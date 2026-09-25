import { createHmac, timingSafeEqual } from 'node:crypto';

import { Controller, Get, Inject, Injectable, Param, Req, Res } from '@nestjs/common';
import { z } from 'zod';

import { decide, PolicyService } from '../authorization/policy.service.js';
import { CustomerApi, Public, RequirePermission } from '../authorization/registry/module-permissions.js';
import { Clock } from '../platform-kernel/clock.js';
import { TenantContext } from '../platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { conflict, notFound } from '../platform-kernel/http/app-error.js';
import { requestIdOf, tenantContextOf } from '../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../platform-kernel/http/validation.pipe.js';

import { INLINE_SAFE_TYPES } from './file-type.js';
import { FILE_STORAGE, type FileStorage, type StoredObject } from './storage/file-storage.js';
import { contentDisposition } from './storage/s3-file-storage.js';

import type { Request, Response } from 'express';

/**
 * Attachment downloads (FR-046, research D17).
 *
 * 1. `GET /attachments/{id}/download` (staff) and `GET /customer/attachments/{id}/download`
 *    decide "can see the message": staff need view on the ticket's group (notes included);
 *    customers only public messages on their own tickets. An upload not sent yet is visible to
 *    its uploader only. Anything else is the same 404 as an unknown id. Then 409
 *    `ATTACHMENT_NOT_READY` while scanning, 409 `ATTACHMENT_BLOCKED` when flagged, else 302.
 * 2. The redirect goes to `/api/v1/files/{token}`: tenant, attachment and expiry (15 minutes)
 *    signed with `FILE_SIGNING_KEY`. With S3 storage it goes to a presigned URL instead.
 * 3. `GET /files/{token}` needs no session. It checks the signature, the expiry and that the
 *    token's tenant is the host's (another tenant's token is 404), then streams the file with
 *    `Content-Disposition: attachment` (inline only for safe images) and `nosniff`.
 */

export const DOWNLOAD_TTL_MS = 15 * 60_000;

const IdParams = z.object({ id: z.uuid() }).strict();
const TokenParams = z.object({ token: z.string().min(1).max(512) }).strict();

const TokenPayload = z.object({ t: z.uuid(), a: z.uuid(), e: z.number().int().positive() }).strict();
type TokenPayload = z.infer<typeof TokenPayload>;

function signingKey(): string {
  const key = process.env.FILE_SIGNING_KEY;
  if (key === undefined || key.length < 16) throw new Error('FILE_SIGNING_KEY must be set (at least 16 characters)');
  return key;
}

function sign(body: string): Buffer {
  return createHmac('sha256', signingKey()).update(body).digest();
}

export function issueDownloadToken(payload: TokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body).toString('base64url')}`;
}

/** The payload of a well-formed token with a valid signature; undefined otherwise. */
export function readDownloadToken(token: string): TokenPayload | undefined {
  const [body, signature, extra] = token.split('.');
  if (body === undefined || signature === undefined || extra !== undefined) return undefined;
  const expected = sign(body);
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    const parsed = TokenPayload.safeParse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

interface DownloadableRow {
  id: string;
  file_name: string;
  content_type: string;
  scan_status: 'pending' | 'clean' | 'blocked';
  uploaded_by: string;
  message_id: string | null;
  visibility: 'public' | 'internal' | null;
  group_id: string | null;
  customer_id: string | null;
}

class DownloadRepository extends TenantRepository {
  find(tx: TenantTransaction, id: string): Promise<DownloadableRow | undefined> {
    return this.selectFrom(tx, 'attachments')
      .leftJoin('ticket_messages', (join) =>
        join.onRef('ticket_messages.tenant_id', '=', 'attachments.tenant_id').onRef('ticket_messages.id', '=', 'attachments.message_id'),
      )
      .leftJoin('tickets', (join) => join.onRef('tickets.tenant_id', '=', 'ticket_messages.tenant_id').onRef('tickets.id', '=', 'ticket_messages.ticket_id'))
      .select([
        'attachments.id',
        'attachments.file_name',
        'attachments.content_type',
        'attachments.scan_status',
        'attachments.uploaded_by',
        'attachments.message_id',
        'ticket_messages.visibility',
        'tickets.group_id',
        'tickets.customer_id',
      ])
      .where('attachments.id', '=', id)
      .executeTakeFirst();
  }
}

@Injectable()
export class DownloadService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly policy: PolicyService,
    private readonly clock: Clock,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  /** Where to send the caller, after the visibility and scan checks. */
  async redirectFor(ctx: TenantContext, attachmentId: string, audience: 'staff' | 'customer'): Promise<string> {
    const actorId = ctx.actor.kind === 'system' ? undefined : ctx.actor.id;
    const row = await this.unitOfWork.withTenantReadOnly(ctx, (tx) => new DownloadRepository(ctx).find(tx, attachmentId));
    if (row === undefined || actorId === undefined || !(await this.canSee(ctx, row, actorId, audience))) throw notFound('attachment');
    if (row.scan_status === 'pending') throw conflict('ATTACHMENT_NOT_READY', 'This file is still being checked. Try again in a moment');
    if (row.scan_status === 'blocked') throw conflict('ATTACHMENT_BLOCKED', 'This file was blocked because it may be harmful');

    const object: StoredObject = { tenantId: ctx.tenantId, attachmentId: row.id, area: 'files' };
    const expiresInSeconds = DOWNLOAD_TTL_MS / 1000;
    if (this.storage.presignedUrl !== undefined) {
      return this.storage.presignedUrl(object, { fileName: row.file_name, contentType: row.content_type, disposition: dispositionFor(row.content_type), expiresInSeconds });
    }
    return `/api/v1/files/${issueDownloadToken({ t: ctx.tenantId, a: row.id, e: this.clock.nowMs() + DOWNLOAD_TTL_MS })}`;
  }

  /** Streams a file for a valid token on its own tenant's host; anything else is 404. */
  async stream(tenantId: string, requestId: string, token: string, res: Response): Promise<void> {
    const payload = readDownloadToken(token);
    if (payload?.t !== tenantId || payload.e <= this.clock.nowMs()) throw notFound('file');
    const ctx = TenantContext.create({ tenantId, actor: { kind: 'system' }, requestId, readOnly: true });
    const row = await this.unitOfWork.withTenantReadOnly(ctx, (tx) => new DownloadRepository(ctx).find(tx, payload.a));
    if (row?.scan_status !== 'clean') throw notFound('file');

    const file = await this.storage.read({ tenantId, attachmentId: row.id, area: 'files' });
    res.setHeader('Content-Type', row.content_type);
    res.setHeader('Content-Disposition', contentDisposition(dispositionFor(row.content_type), row.file_name));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    await new Promise<void>((resolve, reject) => {
      file.on('error', reject);
      res.on('finish', resolve);
      res.on('close', resolve);
      file.pipe(res);
    });
  }

  private async canSee(ctx: TenantContext, row: DownloadableRow, actorId: string, audience: 'staff' | 'customer'): Promise<boolean> {
    // Not sent yet: only the person who uploaded it.
    if (row.message_id === null) return row.uploaded_by === actorId;
    if (audience === 'customer') return row.visibility === 'public' && row.customer_id === actorId;
    if (ctx.actor.kind === 'operator') return true;
    const access = await this.policy.effectiveAccess(ctx, actorId);
    return decide(access, 'ticket.view', { type: 'ticket', groupId: row.group_id }) === 'allow';
  }
}

function dispositionFor(contentType: string): 'inline' | 'attachment' {
  return INLINE_SAFE_TYPES.has(contentType) ? 'inline' : 'attachment';
}

@Controller()
export class DownloadController {
  constructor(private readonly downloads: DownloadService) {}

  @Get('attachments/:id/download')
  @RequirePermission('ticket.view')
  async staff(@Req() req: Request, @Res() res: Response, @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>): Promise<void> {
    res.redirect(302, await this.downloads.redirectFor(tenantContextOf(req), params.id, 'staff'));
  }

  @Get('customer/attachments/:id/download')
  @CustomerApi()
  async customer(@Req() req: Request, @Res() res: Response, @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>): Promise<void> {
    res.redirect(302, await this.downloads.redirectFor(tenantContextOf(req), params.id, 'customer'));
  }

  /** The signed link is the authorization; the host must be the token's tenant. */
  @Get('files/:token')
  @Public()
  async file(@Req() req: Request, @Res() res: Response, @Param(new ZodValidationPipe(TokenParams)) params: z.infer<typeof TokenParams>): Promise<void> {
    if (req.tenant === undefined) throw notFound('file');
    await this.downloads.stream(req.tenant.id, requestIdOf(req), params.token, res);
  }
}
