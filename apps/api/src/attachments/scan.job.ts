import { Inject, Injectable, Logger, Module } from '@nestjs/common';

import { customerAttachment, customerEvents } from '../messaging/customer-projection.js';
import { Clock } from '../platform-kernel/clock.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { tenantScopeOf, UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { IdempotentHandler, type DomainEvent } from '../platform-kernel/jobs/idempotent-handler.js';
import { OutboxService } from '../platform-kernel/outbox/outbox.service.js';

import { ClamAvScanner } from './clamav-scanner.js';
import { PassthroughScanner } from './passthrough-scanner.js';
import { FILE_STORAGE, storageKey, type FileStorage } from './storage/file-storage.js';

import type { DomainEventType, StreamKey } from '../platform-kernel/outbox/event-types.js';
import type { Readable } from 'node:stream';

/**
 * The malware scan (FR-047, research D17), in the worker on the `attachments` queue.
 *
 * For each `attachment.uploaded`: read the quarantined file, scan it, then either move it to the
 * tenant's `files` area and mark it `clean`, or delete it and mark it `blocked`. The result is
 * announced as `attachment.scanned` to the uploader, to the ticket when the file was already
 * sent, and to the customer's conversation when the customer can see it (their own upload, or a
 * public message), so a blocked file shows as blocked and its sender is told.
 *
 * Storage moves can't roll back with the transaction. A retry after a promote that did not
 * commit finds the file in `files` instead of `quarantine` and records it as clean: it was
 * scanned before it was moved.
 */

export type ScanVerdict = { verdict: 'clean' } | { verdict: 'infected'; signature: string };

export interface MalwareScanner {
  readonly name: string;
  scan(file: Readable): Promise<ScanVerdict>;
}

export const MALWARE_SCANNER = Symbol('MALWARE_SCANNER');

/** ClamAV when `CLAMAV_HOST` is set; otherwise the pass-through scanner, which refuses production. */
export function scannerFromEnv(env: NodeJS.ProcessEnv = process.env): MalwareScanner {
  const host = env.CLAMAV_HOST;
  return host === undefined || host === '' ? new PassthroughScanner(env.NODE_ENV) : new ClamAvScanner(host);
}

type Handled = Extract<DomainEventType, 'attachment.uploaded'>;

function isMissing(error: unknown): boolean {
  const { code, name } = (error ?? {}) as { code?: unknown; name?: unknown };
  return code === 'ENOENT' || name === 'NoSuchKey' || name === 'NotFound';
}

@Injectable()
export class AttachmentScanConsumer extends IdempotentHandler<Handled> {
  readonly consumer = 'attachment-scan';
  readonly queue = 'attachments' as const;
  readonly eventTypes: readonly Handled[] = ['attachment.uploaded'];
  private readonly logger = new Logger('AttachmentScanConsumer');

  constructor(
    unitOfWork: UnitOfWork,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
  ) {
    super(unitOfWork);
  }

  protected async handle(tx: TenantTransaction, event: DomainEvent<Handled>): Promise<void> {
    const ctx = tenantScopeOf(tx);
    if (ctx === undefined) throw new Error('AttachmentScanConsumer.handle must run inside withTenant');
    const repo = new ScanRepository(ctx);
    const attachment = await repo.lock(tx, event.payload.attachmentId);
    // Gone (ticket deleted, upload expired) or already decided: nothing to do.
    if (attachment?.scan_status !== 'pending') return;

    const tenantId = ctx.tenantId;
    const id = attachment.id;
    const verdict = await this.verdict(tenantId, id);
    const now = this.clock.now();
    if (verdict.verdict === 'clean') {
      if (!verdict.alreadyPromoted) await this.storage.promote(tenantId, id);
      await repo.mark(tx, id, 'clean', storageKey({ tenantId, attachmentId: id, area: 'files' }), now);
    } else {
      await this.storage.delete({ tenantId, attachmentId: id, area: 'quarantine' });
      await repo.mark(tx, id, 'blocked', attachment.storage_key, now);
      this.logger.warn(`Blocked attachment ${id} (${this.scanner.name}: ${verdict.signature})`);
    }

    const scanStatus = verdict.verdict === 'clean' ? 'clean' : 'blocked';
    const message = attachment.message_id === null ? undefined : await repo.messageOf(tx, attachment.message_id);
    const updated = { ...attachment, scan_status: scanStatus, size_bytes: Number(attachment.size_bytes) } as const;
    // The customer sees it when it is theirs, or once it is on a public message.
    let customerId: string | undefined;
    if (message === undefined) customerId = attachment.uploader_kind === 'customer' ? attachment.uploaded_by : undefined;
    else customerId = message.visibility === 'public' ? message.customer_id : undefined;
    const streams: StreamKey[] = [`user:${attachment.uploaded_by}`];
    if (message !== undefined) streams.push(`ticket:${message.ticket_id}`);
    if (customerId !== undefined) streams.push(`conversation:${customerId}`);

    await this.outbox.append(tx, {
      type: 'attachment.scanned',
      actor: { kind: 'system' },
      payload: { attachmentId: id, messageId: attachment.message_id, scanStatus },
      ...(customerId === undefined ? {} : { customerPayload: customerEvents.attachment(attachment.message_id, customerAttachment(updated)) }),
      streams,
    });
  }

  private async verdict(tenantId: string, attachmentId: string): Promise<ScanVerdict & { alreadyPromoted?: boolean }> {
    let file: Readable;
    try {
      file = await this.storage.read({ tenantId, attachmentId, area: 'quarantine' });
    } catch (error) {
      if (!isMissing(error)) throw error;
      // A previous attempt moved it after a clean scan, then failed before committing.
      (await this.storage.read({ tenantId, attachmentId, area: 'files' })).destroy();
      return { verdict: 'clean', alreadyPromoted: true };
    }
    return this.scanner.scan(file);
  }
}

class ScanRepository extends TenantRepository {
  lock(tx: TenantTransaction, id: string) {
    return this.selectFrom(tx, 'attachments')
      .innerJoin('users', (join) => join.onRef('users.tenant_id', '=', 'attachments.tenant_id').onRef('users.id', '=', 'attachments.uploaded_by'))
      .select([
        'attachments.id',
        'attachments.message_id',
        'attachments.uploaded_by',
        'attachments.file_name',
        'attachments.content_type',
        'attachments.size_bytes',
        'attachments.storage_key',
        'attachments.scan_status',
        'attachments.scanned_at',
        'attachments.created_at',
        'attachments.updated_at',
        'users.kind as uploader_kind',
      ])
      .where('attachments.id', '=', id)
      .forUpdate('attachments')
      .executeTakeFirst();
  }

  async mark(tx: TenantTransaction, id: string, status: 'clean' | 'blocked', key: string, at: Date): Promise<void> {
    await this.updateTable(tx, 'attachments').set({ scan_status: status, storage_key: key, scanned_at: at }).where('attachments.id', '=', id).execute();
  }

  messageOf(tx: TenantTransaction, messageId: string) {
    return this.selectFrom(tx, 'ticket_messages')
      .innerJoin('tickets', (join) => join.onRef('tickets.tenant_id', '=', 'ticket_messages.tenant_id').onRef('tickets.id', '=', 'ticket_messages.ticket_id'))
      .select(['ticket_messages.ticket_id', 'ticket_messages.visibility', 'tickets.customer_id'])
      .where('ticket_messages.id', '=', messageId)
      .executeTakeFirst();
  }
}

/** Attachment jobs (worker process only). */
@Module({
  providers: [{ provide: MALWARE_SCANNER, useFactory: () => scannerFromEnv() }, AttachmentScanConsumer],
})
export class AttachmentJobsModule {}
