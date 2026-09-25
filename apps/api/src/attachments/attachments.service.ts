import { Inject, Injectable } from '@nestjs/common';

import { Clock } from '../platform-kernel/clock.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { AppError, validationFailed } from '../platform-kernel/http/app-error.js';
import { uuidv7 } from '../platform-kernel/ids.js';
import { OutboxService } from '../platform-kernel/outbox/outbox.service.js';

import { allowedContentType, safeFileName } from './file-type.js';
import { FILE_STORAGE, storageKey, type FileStorage, type StoredObject } from './storage/file-storage.js';
import { attachmentTooLarge, MAX_ATTACHMENT_BYTES, type UploadedFile } from './upload.interceptor.js';

import type { ScanStatus } from '../platform-kernel/db/tables/tickets.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * Uploads (FR-045, FR-047, research D17). A file is checked for size (25 MB) and type (magic
 * bytes, file-type.ts), written to the tenant's quarantine area and recorded as `pending`; the
 * `attachment.uploaded` event then has the worker scan it (scan.job.ts). The id is sent with a
 * message within 24 hours; until then the attachment belongs to nobody but its uploader.
 *
 * The file is written before the row so a row never points at nothing; if the transaction fails
 * the file is removed again.
 */

export interface UploadedAttachmentDto {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  scanStatus: ScanStatus;
  downloadPath: null;
}

export function attachmentTypeNotAllowed(): AppError {
  return new AppError(
    'ATTACHMENT_TYPE_NOT_ALLOWED',
    415,
    'This type of file can’t be attached. Try an image, PDF, office document, text file or archive',
  );
}

@Injectable()
export class AttachmentsService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  async upload(ctx: TenantContext, uploaderId: string, file: UploadedFile): Promise<UploadedAttachmentDto> {
    if (file.size > MAX_ATTACHMENT_BYTES) throw attachmentTooLarge();
    if (file.size === 0) throw validationFailed([{ path: 'file', issue: 'too_small' }]);
    const fileName = safeFileName(file.originalname);
    const contentType = await allowedContentType(file.buffer, fileName);
    if (contentType === undefined) throw attachmentTypeNotAllowed();

    const id = uuidv7();
    const object: StoredObject = { tenantId: ctx.tenantId, attachmentId: id, area: 'quarantine' };
    await this.storage.put(object, file.buffer);
    try {
      await this.unitOfWork.withTenant(ctx, async (tx) => {
        await new UploadsRepository(ctx).insert(tx, {
          id,
          uploaderId,
          fileName,
          contentType,
          sizeBytes: file.size,
          storageKey: storageKey(object),
          createdAt: this.clock.now(),
        });
        await this.outbox.append(tx, { type: 'attachment.uploaded', payload: { attachmentId: id }, streams: [`user:${uploaderId}`] });
      });
    } catch (error) {
      await this.storage.delete(object).catch(() => undefined);
      throw error;
    }
    return { id, fileName, contentType, sizeBytes: file.size, scanStatus: 'pending', downloadPath: null };
  }
}

class UploadsRepository extends TenantRepository {
  async insert(
    tx: TenantTransaction,
    row: { id: string; uploaderId: string; fileName: string; contentType: string; sizeBytes: number; storageKey: string; createdAt: Date },
  ): Promise<void> {
    await this.insertInto(tx, 'attachments', {
      id: row.id,
      uploaded_by: row.uploaderId,
      file_name: row.fileName,
      content_type: row.contentType,
      size_bytes: row.sizeBytes,
      storage_key: row.storageKey,
      created_at: row.createdAt,
      updated_at: row.createdAt,
    }).execute();
  }
}
