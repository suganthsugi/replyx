import { TenantContext } from '../db/tenant-context.js';
import { UnitOfWork, type TenantTransaction } from '../db/unit-of-work.js';
import { runWithLogContext } from '../observability/logger.js';

import type { EventJobData, QueueName } from './queues.js';
import type { JsonValue } from '../db/tables/column-types.js';
import type { DomainEventPayload, DomainEventType, EventActor, EventCause } from '../outbox/event-types.js';

/** An outbox event as a consumer sees it. */
export interface DomainEvent<T extends DomainEventType = DomainEventType> {
  id: string;
  tenantId: string;
  type: T;
  actor: EventActor;
  payload: DomainEventPayload<T>;
  customerPayload: JsonValue | null;
  streams: string[];
  cause: EventCause | null;
  occurredAt: Date;
  seq: string | null;
}

export type HandleResult = 'handled' | 'skipped';

/**
 * Base class for every queue consumer (research D12, realtime-events rule 11).
 *
 * `process` opens `withTenant` from the job's `tenantId` (never from the event payload), claims
 * `(consumer, event_id)` in `processed_events` and runs `handle` in that same transaction. A
 * duplicate delivery finds the claim and is skipped; a failure rolls the claim back so the
 * retry runs again. Subclasses are Nest providers; the jobs module discovers them, and the relay
 * routes each event type listed in `eventTypes` to `queue` as a job named after `consumer`.
 */
export abstract class IdempotentHandler<T extends DomainEventType = DomainEventType> {
  /** Unique across the app; stored in `processed_events.consumer`. */
  abstract readonly consumer: string;
  abstract readonly queue: QueueName;
  abstract readonly eventTypes: readonly T[];

  constructor(protected readonly unitOfWork: UnitOfWork) {}

  /** Tenant-scoped work for one event. Throw to retry. */
  protected abstract handle(tx: TenantTransaction, event: DomainEvent<T>): Promise<void>;

  process(data: EventJobData, jobId: string | undefined): Promise<HandleResult> {
    const ctx = TenantContext.create({
      tenantId: data.tenantId,
      actor: { kind: 'system' },
      requestId: `job:${jobId ?? data.eventId}`.slice(0, 128),
    });
    return runWithLogContext({ tenantId: ctx.tenantId, eventId: data.eventId, jobId }, () =>
      this.unitOfWork.withTenant(ctx, async (tx) => {
        const claimed = await tx
          .insertInto('processed_events')
          .values({ consumer: this.consumer, event_id: data.eventId })
          .onConflict((oc) => oc.doNothing())
          .returning('event_id')
          .executeTakeFirst();
        if (claimed === undefined) return 'skipped';

        // RLS limits the read to the job's tenant; an event of another tenant is not found.
        const row = await tx
          .selectFrom('outbox_events')
          .selectAll()
          .where('id', '=', data.eventId)
          .where('tenant_id', '=', ctx.tenantId)
          .executeTakeFirst();
        if (row === undefined) {
          throw new Error(`Event ${data.eventId} not found for consumer ${this.consumer}`);
        }
        if (!(this.eventTypes as readonly string[]).includes(row.type)) {
          // Routed by mistake: record it as processed without acting on it.
          return 'skipped';
        }
        await this.handle(tx, toDomainEvent<T>(row));
        return 'handled';
      }),
    );
  }
}

export function toDomainEvent<T extends DomainEventType>(row: {
  id: string;
  tenant_id: string;
  type: string;
  actor: JsonValue;
  payload: JsonValue;
  customer_payload: JsonValue | null;
  streams: string[];
  cause: JsonValue | null;
  created_at: Date;
  seq: string | null;
}): DomainEvent<T> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    type: row.type as T,
    actor: row.actor as unknown as EventActor,
    payload: row.payload as unknown as DomainEventPayload<T>,
    customerPayload: row.customer_payload,
    streams: row.streams,
    cause: row.cause as EventCause | null,
    occurredAt: row.created_at,
    seq: row.seq,
  };
}
