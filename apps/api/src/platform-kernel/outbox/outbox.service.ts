import { Global, Injectable, Module } from '@nestjs/common';

import { tenantScopeOf, type TenantTransaction } from '../db/unit-of-work.js';
import { uuidv7 } from '../ids.js';

import {
  isCustomerStream,
  isStreamKey,
  type DomainEventPayload,
  type DomainEventType,
  type EventActor,
  type EventCause,
  type StreamKey,
} from './event-types.js';

import type { JsonValue } from '../db/tables/column-types.js';

export interface AppendInput<T extends DomainEventType> {
  type: T;
  /** Defaults to the transaction's context actor. */
  actor?: EventActor;
  payload: DomainEventPayload<T>;
  /** Required when any stream is `conversation:*`; never includes internal fields (research D9). */
  customerPayload?: JsonValue;
  streams: readonly StreamKey[];
  cause?: EventCause;
}

/**
 * Persist-then-publish (constitution IV, research D7): events are rows written in the same
 * transaction as the state change. The relay (worker) publishes them after commit, so a rollback
 * publishes nothing. Services never emit to sockets or queues directly.
 */
@Injectable()
export class OutboxService {
  /** Returns the new event's UUIDv7 id. The tenant always comes from the transaction. */
  async append<T extends DomainEventType>(tx: TenantTransaction, input: AppendInput<T>): Promise<string> {
    const ctx = tenantScopeOf(tx);
    if (ctx === undefined) {
      throw new Error('OutboxService.append must run inside withTenant');
    }
    if (input.streams.length === 0) {
      throw new Error(`Event ${input.type} has no streams`);
    }
    // Typed callers can only pass valid keys; untyped (cast) input is still checked at runtime.
    for (const stream of input.streams as readonly string[]) {
      if (!isStreamKey(stream)) {
        throw new Error(`Event ${input.type} has an invalid stream key "${stream}"`);
      }
    }
    const hasCustomerStream = input.streams.some(isCustomerStream);
    if (hasCustomerStream && input.customerPayload === undefined) {
      throw new Error(`Event ${input.type} targets a customer stream without a customerPayload`);
    }
    if (!hasCustomerStream && input.customerPayload !== undefined) {
      throw new Error(`Event ${input.type} has a customerPayload but no customer stream`);
    }

    const id = uuidv7();
    await tx
      .insertInto('outbox_events')
      .values({
        id,
        tenant_id: ctx.tenantId,
        type: input.type,
        actor: JSON.stringify(input.actor ?? ctx.actor),
        payload: JSON.stringify(input.payload),
        customer_payload: input.customerPayload === undefined ? null : JSON.stringify(input.customerPayload),
        streams: [...new Set(input.streams)],
        cause: input.cause === undefined ? null : JSON.stringify(input.cause),
      })
      .execute();
    return id;
  }
}

@Global()
@Module({ providers: [OutboxService], exports: [OutboxService] })
export class OutboxModule {}
