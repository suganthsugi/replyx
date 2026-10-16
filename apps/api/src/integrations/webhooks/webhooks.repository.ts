import { sql } from 'kysely';

import { TenantRepository } from '../../platform-kernel/db/tenant-repository.js';

import type { WebhookDeliveryStatus, WebhookEvent } from '../../platform-kernel/db/tables/integrations.js';
import type { TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';

/** `webhooks` and `webhook_deliveries` (migration 0022, research D16). */

export interface WebhookRow {
  id: string;
  url: string;
  secretEncrypted: string;
  events: WebhookEvent[];
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookValues {
  url: string;
  events: WebhookEvent[];
  enabled: boolean;
}

export interface DeliveryRow {
  id: string;
  webhookId: string;
  eventId: string;
  eventType: WebhookEvent;
  attempt: number;
  status: WebhookDeliveryStatus;
  body: string;
  responseCode: number | null;
  durationMs: number | null;
  error: string | null;
  nextAttemptAt: Date | null;
  attemptedAt: Date | null;
  createdAt: Date;
}

export interface AttemptOutcome {
  status: Exclude<WebhookDeliveryStatus, 'pending'>;
  responseCode: number | null;
  durationMs: number | null;
  error: string | null;
  attemptedAt: Date;
  /** Set on `failed`: when the next attempt is due. */
  nextAttemptAt: Date | null;
}

const WEBHOOK_COLUMNS = [
  'webhooks.id',
  'webhooks.url',
  'webhooks.secret_encrypted',
  'webhooks.events',
  'webhooks.enabled',
  'webhooks.created_at',
  'webhooks.updated_at',
] as const;

const DELIVERY_COLUMNS = [
  'webhook_deliveries.id',
  'webhook_deliveries.webhook_id',
  'webhook_deliveries.event_id',
  'webhook_deliveries.event_type',
  'webhook_deliveries.attempt',
  'webhook_deliveries.status',
  'webhook_deliveries.body',
  'webhook_deliveries.response_code',
  'webhook_deliveries.duration_ms',
  'webhook_deliveries.error',
  'webhook_deliveries.next_attempt_at',
  'webhook_deliveries.attempted_at',
  'webhook_deliveries.created_at',
] as const;

function toWebhook(row: {
  id: string;
  url: string;
  secret_encrypted: string;
  events: WebhookEvent[];
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}): WebhookRow {
  return {
    id: row.id,
    url: row.url,
    secretEncrypted: row.secret_encrypted,
    events: row.events,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDelivery(row: {
  id: string;
  webhook_id: string;
  event_id: string;
  event_type: WebhookEvent;
  attempt: number;
  status: WebhookDeliveryStatus;
  body: string;
  response_code: number | null;
  duration_ms: number | null;
  error: string | null;
  next_attempt_at: Date | null;
  attempted_at: Date | null;
  created_at: Date;
}): DeliveryRow {
  return {
    id: row.id,
    webhookId: row.webhook_id,
    eventId: row.event_id,
    eventType: row.event_type,
    attempt: row.attempt,
    status: row.status,
    body: row.body,
    responseCode: row.response_code,
    durationMs: row.duration_ms,
    error: row.error,
    nextAttemptAt: row.next_attempt_at,
    attemptedAt: row.attempted_at,
    createdAt: row.created_at,
  };
}

export class WebhooksRepository extends TenantRepository {
  // --- endpoints ---------------------------------------------------------------------------

  async all(tx: TenantTransaction): Promise<WebhookRow[]> {
    const rows = await this.selectFrom(tx, 'webhooks').select(WEBHOOK_COLUMNS).orderBy('webhooks.created_at').orderBy('webhooks.id').execute();
    return rows.map(toWebhook);
  }

  async byId(tx: TenantTransaction, id: string): Promise<WebhookRow | undefined> {
    const row = await this.selectFrom(tx, 'webhooks').select(WEBHOOK_COLUMNS).where('webhooks.id', '=', id).executeTakeFirst();
    return row === undefined ? undefined : toWebhook(row);
  }

  async count(tx: TenantTransaction): Promise<number> {
    const row = await this.selectFrom(tx, 'webhooks').select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow();
    return Number(row.count);
  }

  /** Serializes one tenant's endpoint writes (the per-workspace limit). */
  async lock(tx: TenantTransaction): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`webhooks:${this.ctx.tenantId}`}, 0))`.execute(tx);
  }

  async insert(tx: TenantTransaction, values: WebhookValues, secretEncrypted: string, createdBy: string | null): Promise<string> {
    const row = await this.insertInto(tx, 'webhooks', { url: values.url, events: values.events, enabled: values.enabled, secret_encrypted: secretEncrypted, created_by: createdBy })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async update(tx: TenantTransaction, id: string, values: WebhookValues): Promise<void> {
    await this.updateTable(tx, 'webhooks').set({ url: values.url, events: values.events, enabled: values.enabled }).where('webhooks.id', '=', id).execute();
  }

  async setSecret(tx: TenantTransaction, id: string, secretEncrypted: string): Promise<void> {
    await this.updateTable(tx, 'webhooks').set({ secret_encrypted: secretEncrypted, updated_at: new Date() }).where('webhooks.id', '=', id).execute();
  }

  async delete(tx: TenantTransaction, id: string): Promise<void> {
    await this.deleteFrom(tx, 'webhooks').where('webhooks.id', '=', id).execute();
  }

  /** Enabled endpoints subscribed to the event type. */
  async subscribed(tx: TenantTransaction, eventType: WebhookEvent): Promise<WebhookRow[]> {
    const rows = await this.selectFrom(tx, 'webhooks')
      .select(WEBHOOK_COLUMNS)
      .where('webhooks.enabled', '=', true)
      .where(sql<boolean>`${eventType} = ANY(webhooks.events)`)
      .orderBy('webhooks.id')
      .execute();
    return rows.map(toWebhook);
  }

  /** The latest attempt's status per endpoint (the list's "last delivery"). */
  async lastStatuses(tx: TenantTransaction): Promise<Map<string, string>> {
    const rows = await this.selectFrom(tx, 'webhook_deliveries')
      .distinctOn('webhook_deliveries.webhook_id')
      .select(['webhook_deliveries.webhook_id', 'webhook_deliveries.status'])
      .orderBy('webhook_deliveries.webhook_id')
      .orderBy('webhook_deliveries.created_at', 'desc')
      .orderBy('webhook_deliveries.id', 'desc')
      .execute();
    return new Map(rows.map((row) => [row.webhook_id, row.status]));
  }

  // --- deliveries ----------------------------------------------------------------------------

  /** A pending attempt; `undefined` when it already exists (a redelivered event or a race). */
  async insertAttempt(
    tx: TenantTransaction,
    values: { webhookId: string; eventId: string; eventType: WebhookEvent; attempt: number; body: string; dueAt: Date },
  ): Promise<string | undefined> {
    const row = await this.insertInto(tx, 'webhook_deliveries', {
      webhook_id: values.webhookId,
      event_id: values.eventId,
      event_type: values.eventType,
      attempt: values.attempt,
      body: values.body,
      next_attempt_at: values.dueAt,
    })
      .onConflict((oc) => oc.columns(['tenant_id', 'webhook_id', 'event_id', 'attempt']).doNothing())
      .returning('id')
      .executeTakeFirst();
    return row?.id;
  }

  async delivery(tx: TenantTransaction, id: string): Promise<DeliveryRow | undefined> {
    const row = await this.selectFrom(tx, 'webhook_deliveries').select(DELIVERY_COLUMNS).where('webhook_deliveries.id', '=', id).executeTakeFirst();
    return row === undefined ? undefined : toDelivery(row);
  }

  /**
   * Claims a due pending attempt by moving its due time forward by `leaseMs`, so a second job for
   * the same row (the sweep, a duplicate) finds it not due and leaves it alone. A worker that dies
   * mid-request leaves the row pending; the sweep sends it again once the lease has passed.
   */
  async claim(tx: TenantTransaction, id: string, now: Date, leaseMs: number): Promise<DeliveryRow | undefined> {
    const row = await this.updateTable(tx, 'webhook_deliveries')
      .set({ next_attempt_at: new Date(now.getTime() + leaseMs) })
      .where('webhook_deliveries.id', '=', id)
      .where('webhook_deliveries.status', '=', 'pending')
      .where('webhook_deliveries.next_attempt_at', '<=', now)
      .returning(DELIVERY_COLUMNS)
      .executeTakeFirst();
    return row === undefined ? undefined : toDelivery(row);
  }

  async complete(tx: TenantTransaction, id: string, outcome: AttemptOutcome): Promise<void> {
    await this.updateTable(tx, 'webhook_deliveries')
      .set({
        status: outcome.status,
        response_code: outcome.responseCode,
        duration_ms: outcome.durationMs,
        error: outcome.error?.slice(0, 500) ?? null,
        attempted_at: outcome.attemptedAt,
        next_attempt_at: outcome.nextAttemptAt,
      })
      .where('webhook_deliveries.id', '=', id)
      .execute();
  }

  /** Pending attempts due before `cutoff` (the recovery sweep). */
  async overdue(tx: TenantTransaction, cutoff: Date, limit: number): Promise<string[]> {
    const rows = await this.selectFrom(tx, 'webhook_deliveries')
      .select('webhook_deliveries.id')
      .where('webhook_deliveries.status', '=', 'pending')
      .where('webhook_deliveries.next_attempt_at', '<=', cutoff)
      .orderBy('webhook_deliveries.next_attempt_at')
      .limit(limit)
      .execute();
    return rows.map((row) => row.id);
  }

  async purgeOlderThan(tx: TenantTransaction, cutoff: Date, limit: number): Promise<number> {
    const result = await this.deleteFrom(tx, 'webhook_deliveries')
      .where('webhook_deliveries.id', 'in', (eb) =>
        eb
          .selectFrom('webhook_deliveries as expired')
          .select('expired.id')
          .where('expired.tenant_id', '=', this.ctx.tenantId)
          .where('expired.created_at', '<', cutoff)
          .limit(limit),
      )
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /** An endpoint's history, newest first, keyset-paged on (created_at, id). */
  async history(tx: TenantTransaction, webhookId: string, since: Date, limit: number, after?: { createdAt: Date; id: string }): Promise<DeliveryRow[]> {
    let query = this.selectFrom(tx, 'webhook_deliveries')
      .select(DELIVERY_COLUMNS)
      .where('webhook_deliveries.webhook_id', '=', webhookId)
      .where('webhook_deliveries.created_at', '>=', since);
    if (after !== undefined) {
      query = query.where((eb) =>
        eb.or([
          eb('webhook_deliveries.created_at', '<', after.createdAt),
          eb.and([eb('webhook_deliveries.created_at', '=', after.createdAt), eb('webhook_deliveries.id', '<', after.id)]),
        ]),
      );
    }
    const rows = await query.orderBy('webhook_deliveries.created_at', 'desc').orderBy('webhook_deliveries.id', 'desc').limit(limit).execute();
    return rows.map(toDelivery);
  }
}
