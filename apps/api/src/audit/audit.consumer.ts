import { Injectable } from '@nestjs/common';

import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { IdempotentHandler, type DomainEvent } from '../platform-kernel/jobs/idempotent-handler.js';

import { AuditService, type AuditEntry } from './audit.service.js';

import type { Actor } from '../platform-kernel/db/tenant-context.js';
import type { DomainEventType, EventActor } from '../platform-kernel/outbox/event-types.js';

/**
 * Turns domain events into audit entries (FR-092), idempotently: a redelivered event never
 * writes a second entry. Services that already audit an action in their own transaction (for
 * example `auth.locked`) are not mapped here. T191 completes the mapping for ticket events.
 */

type AuditedEvent = 'session.revoked';

/** The audit entry for an event, or undefined when the event is not audited. */
export function auditEntryFor(event: DomainEvent<AuditedEvent>): AuditEntry | undefined {
  switch (event.type) {
    case 'session.revoked': {
      // A single sign-out is routine; revoking every session is a security event.
      if (event.payload.reason === 'sign_out') return undefined;
      return {
        action: 'auth.sessions_revoked',
        resourceType: 'user',
        resourceId: event.payload.userId,
        details: { reason: event.payload.reason, sessionCount: event.payload.sessionIds.length },
      };
    }
  }
}

function toActor(actor: EventActor): Actor {
  return actor.kind === 'system' ? { kind: 'system' } : { kind: actor.kind, id: actor.id };
}

@Injectable()
export class AuditConsumer extends IdempotentHandler<AuditedEvent> {
  readonly consumer = 'audit';
  readonly queue = 'audit' as const;
  readonly eventTypes: readonly Extract<DomainEventType, AuditedEvent>[] = ['session.revoked'];

  constructor(
    unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
  ) {
    super(unitOfWork);
  }

  protected async handle(tx: TenantTransaction, event: DomainEvent<AuditedEvent>): Promise<void> {
    const entry = auditEntryFor(event);
    if (entry === undefined) return;
    await this.audit.record(tx, entry, { actor: toActor(event.actor) });
  }
}
