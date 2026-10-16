import { Injectable } from '@nestjs/common';

import { Clock } from '../../platform-kernel/clock.js';
import { WEBHOOK_EVENTS, type WebhookEvent } from '../../platform-kernel/db/tables/integrations.js';
import { tenantScopeOf, UnitOfWork, type TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';
import { IdempotentHandler, type DomainEvent, type HandleResult } from '../../platform-kernel/jobs/idempotent-handler.js';
import { QueueRegistry, type EventJobData } from '../../platform-kernel/jobs/queues.js';

import { enqueueDelivery } from './delivery.job.js';
import { webhookBody, webhookData, WebhookPayloadRepository } from './webhook-payload.js';
import { WebhooksRepository } from './webhooks.repository.js';

/**
 * The event side of webhooks (US18, FR-090): for each event an endpoint can subscribe to, builds
 * the body once and writes attempt 1 as pending for every enabled endpoint subscribed to it, in the
 * consumer's transaction (claimed in `processed_events`, so a redelivered event adds nothing).
 * The delivery jobs are queued after that transaction commits; if queuing fails, the sweep picks
 * the attempts up.
 *
 * Only this tenant's endpoints are read (RLS and `TenantRepository`), and internal notes produce no
 * body at all.
 */

@Injectable()
export class WebhooksConsumer extends IdempotentHandler<WebhookEvent> {
  readonly consumer = 'webhooks';
  readonly queue = 'webhooks' as const;
  readonly eventTypes: readonly WebhookEvent[] = WEBHOOK_EVENTS;

  /** Attempts written by `handle`, queued by `process` once committed (keyed by event id). */
  private readonly written = new Map<string, string[]>();

  constructor(
    unitOfWork: UnitOfWork,
    private readonly queues: QueueRegistry,
    private readonly clock: Clock,
  ) {
    super(unitOfWork);
  }

  override async process(data: EventJobData, jobId: string | undefined): Promise<HandleResult> {
    try {
      const result = await super.process(data, jobId);
      for (const deliveryId of this.written.get(data.eventId) ?? []) await enqueueDelivery(this.queues, { tenantId: data.tenantId, deliveryId });
      return result;
    } finally {
      this.written.delete(data.eventId);
    }
  }

  protected async handle(tx: TenantTransaction, event: DomainEvent<WebhookEvent>): Promise<void> {
    const ctx = tenantScopeOf(tx);
    if (ctx === undefined) throw new Error('WebhooksConsumer.handle must run inside withTenant');
    const repo = new WebhooksRepository(ctx);
    const endpoints = await repo.subscribed(tx, event.type);
    if (endpoints.length === 0) return;

    const payloads = new WebhookPayloadRepository(ctx);
    const data = await webhookData(payloads, tx, event);
    if (data === undefined) return;
    const body = JSON.stringify(webhookBody(event, await payloads.tenantSlug(tx), data));

    const now = this.clock.now();
    const ids: string[] = [];
    for (const endpoint of endpoints) {
      const id = await repo.insertAttempt(tx, { webhookId: endpoint.id, eventId: event.id, eventType: event.type, attempt: 1, body, dueAt: now });
      if (id !== undefined) ids.push(id);
    }
    this.written.set(event.id, ids);
  }
}
