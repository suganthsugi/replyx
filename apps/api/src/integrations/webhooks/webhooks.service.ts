import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { AuditService } from '../../audit/audit.service.js';
import { Clock } from '../../platform-kernel/clock.js';
import { SecretBox } from '../../platform-kernel/crypto/secret-box.js';
import { UnitOfWork, type TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';
import { conflict, notFound, validationFailed } from '../../platform-kernel/http/app-error.js';
import { checkOutboundUrl, OutboundRefusedError } from '../../platform-kernel/http/outbound-guard.js';
import { decodeCursor, toPage, type Page } from '../../platform-kernel/http/pagination.js';

import { generateWebhookSecret } from './webhook-signature.js';
import { DELIVERY_RETENTION_DAYS } from './webhook-sweep.job.js';
import { WebhooksRepository, type DeliveryRow, type WebhookRow, type WebhookValues } from './webhooks.repository.js';

import type { WebhookInput } from './webhook-input.js';
import type { WebhookDeliveryStatus, WebhookEvent } from '../../platform-kernel/db/tables/integrations.js';
import type { TenantContext } from '../../platform-kernel/db/tenant-context.js';

/**
 * Webhook endpoints admin (US18, FR-090, FR-091, contracts/operations.yaml `/webhooks*`).
 *
 * - The URL must pass the outbound guard on save (https; no private or loopback IP literal, no
 *   `localhost`), so a typo or an internal target is a field error right away. Host names are
 *   resolved and checked again on every delivery.
 * - The signing secret is generated here, returned once (create, rotate) and stored only sealed.
 *   Rotating takes effect for the next attempt, retries included.
 * - At most `MAX_WEBHOOKS` endpoints per workspace; writes are serialized by an advisory lock.
 * - Every write is audited (`webhook.created` / `.updated` / `.deleted` / `.secret_rotated`) with the
 *   host only: endpoint URLs often carry a token in their path or query.
 */

export const MAX_WEBHOOKS = 20;

export interface WebhookDto {
  id: string;
  url: string;
  events: WebhookEvent[];
  enabled: boolean;
  createdAt: string;
  lastDeliveryStatus: WebhookDeliveryStatus | null;
}

export interface WebhookDeliveryDto {
  id: string;
  eventId: string;
  eventType: WebhookEvent;
  attempt: number;
  status: WebhookDeliveryStatus;
  responseCode: number | null;
  durationMs: number | null;
  error: string | null;
  nextAttemptAt: string | null;
  attemptedAt: string | null;
  createdAt: string;
}

function toWebhookDto(row: WebhookRow, lastStatus: string | undefined): WebhookDto {
  return {
    id: row.id,
    url: row.url,
    events: row.events,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    lastDeliveryStatus: (lastStatus as WebhookDeliveryStatus | undefined) ?? null,
  };
}

function toDeliveryDto(row: DeliveryRow): WebhookDeliveryDto {
  return {
    id: row.id,
    eventId: row.eventId,
    eventType: row.eventType,
    attempt: row.attempt,
    status: row.status,
    responseCode: row.responseCode,
    durationMs: row.durationMs,
    error: row.error,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    attemptedAt: row.attemptedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

const DeliveryCursor = z.object({ createdAt: z.iso.datetime(), id: z.uuid() }).strict();

/** The URL as given, if the outbound guard accepts it; otherwise a field error on `url`. */
function checkedValues(input: WebhookInput): WebhookValues {
  try {
    checkOutboundUrl(input.url);
  } catch (error) {
    if (!(error instanceof OutboundRefusedError)) throw error;
    throw validationFailed([{ path: 'url', issue: error.reason }]);
  }
  return { url: input.url, events: input.events, enabled: input.enabled };
}

function hostOf(url: string): string {
  return new URL(url).host;
}

@Injectable()
export class WebhooksService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    private readonly secrets: SecretBox,
    private readonly clock: Clock,
  ) {}

  list(ctx: TenantContext): Promise<WebhookDto[]> {
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const repo = new WebhooksRepository(ctx);
      const statuses = await repo.lastStatuses(tx);
      return (await repo.all(tx)).map((row) => toWebhookDto(row, statuses.get(row.id)));
    });
  }

  create(ctx: TenantContext, input: WebhookInput): Promise<WebhookDto & { secret: string }> {
    const values = checkedValues(input);
    const secret = generateWebhookSecret();
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new WebhooksRepository(ctx);
      await repo.lock(tx);
      if ((await repo.count(tx)) >= MAX_WEBHOOKS) throw conflict('WEBHOOK_LIMIT', `A workspace can have at most ${MAX_WEBHOOKS} webhook endpoints`);
      const createdBy = ctx.actor.kind === 'user' ? ctx.actor.id : null;
      const id = await repo.insert(tx, values, this.secrets.seal(secret), createdBy);
      await this.auditWrite(tx, 'webhook.created', id, values);
      return { ...toWebhookDto(await this.load(repo, tx, id), undefined), secret };
    });
  }

  /** Full replace of URL, events and switch; the secret and history stay. */
  update(ctx: TenantContext, id: string, input: WebhookInput): Promise<WebhookDto> {
    const values = checkedValues(input);
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new WebhooksRepository(ctx);
      await repo.lock(tx);
      await this.load(repo, tx, id);
      await repo.update(tx, id, values);
      await this.auditWrite(tx, 'webhook.updated', id, values);
      const statuses = await repo.lastStatuses(tx);
      return toWebhookDto(await this.load(repo, tx, id), statuses.get(id));
    });
  }

  async delete(ctx: TenantContext, id: string): Promise<void> {
    await this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new WebhooksRepository(ctx);
      await repo.lock(tx);
      const row = await this.load(repo, tx, id);
      await repo.delete(tx, id);
      await this.audit.record(tx, { action: 'webhook.deleted', resourceType: 'webhook', resourceId: id, details: { host: hostOf(row.url) } });
    });
  }

  rotateSecret(ctx: TenantContext, id: string): Promise<{ secret: string }> {
    const secret = generateWebhookSecret();
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new WebhooksRepository(ctx);
      const row = await this.load(repo, tx, id);
      await repo.setSecret(tx, id, this.secrets.seal(secret));
      await this.audit.record(tx, { action: 'webhook.secret_rotated', resourceType: 'webhook', resourceId: id, details: { host: hostOf(row.url) } });
      return { secret };
    });
  }

  /** The endpoint's attempts of the last 30 days, newest first. */
  deliveries(ctx: TenantContext, id: string, query: { limit: number; cursor?: string }): Promise<Page<WebhookDeliveryDto>> {
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor, DeliveryCursor);
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const repo = new WebhooksRepository(ctx);
      await this.load(repo, tx, id);
      const since = new Date(this.clock.nowMs() - DELIVERY_RETENTION_DAYS * 86_400_000);
      const rows = await repo.history(tx, id, since, query.limit + 1, after === undefined ? undefined : { createdAt: new Date(after.createdAt), id: after.id });
      return toPage(rows, query.limit, (row) => ({ createdAt: row.createdAt.toISOString(), id: row.id }), toDeliveryDto);
    });
  }

  private async load(repo: WebhooksRepository, tx: TenantTransaction, id: string): Promise<WebhookRow> {
    const row = await repo.byId(tx, id);
    if (row === undefined) throw notFound('webhook');
    return row;
  }

  private auditWrite(tx: TenantTransaction, action: string, id: string, values: WebhookValues): Promise<void> {
    return this.audit.record(tx, { action, resourceType: 'webhook', resourceId: id, details: { host: hostOf(values.url), events: values.events, enabled: values.enabled } });
  }
}
