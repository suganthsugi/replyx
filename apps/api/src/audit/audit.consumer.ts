import { Injectable } from '@nestjs/common';

import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { IdempotentHandler, type DomainEvent } from '../platform-kernel/jobs/idempotent-handler.js';

import { AuditService, type AuditEntry } from './audit.service.js';

import type { Actor } from '../platform-kernel/db/tenant-context.js';
import type { DomainEventType, EventActor } from '../platform-kernel/outbox/event-types.js';

/**
 * Turns domain events into audit entries (FR-092), idempotently: a redelivered event never
 * writes a second entry.
 *
 * Two sources feed the log. Services audit their own configuration and security actions in the
 * same transaction as the change (sign-ins and failures, user, role, permission and group-access
 * changes, tenant settings, support access, ticket deletion, retention purges), because those
 * have no domain event. This consumer covers the ticket lifecycle, which is announced as events:
 * created, assigned/reassigned, state, priority and group changes, and messages and internal
 * notes added. Merged, split and webhook changes arrive with their event types (later phases).
 *
 * Message bodies, titles and other free text never go into `details`: only ids, numbers, enum
 * values and counts.
 */

const AUDITED_EVENTS = [
  'session.revoked',
  'ticket.created',
  'ticket.updated',
  'ticket.assigned',
  'message.created',
] as const satisfies readonly DomainEventType[];

type AuditedEvent = (typeof AUDITED_EVENTS)[number];

/** One member per event type, so `event.type` narrows `event.payload`. */
export type AuditableEvent = { [K in AuditedEvent]: DomainEvent<K> }[AuditedEvent];

/** Ticket fields whose change is an audit entry, and the action it produces. */
const TICKET_FIELD_ACTIONS: Readonly<Record<string, string>> = {
  state: 'ticket.state_changed',
  priority: 'ticket.priority_changed',
  group_id: 'ticket.group_changed',
};

/** The audit entries for an event: none when the event is not audited. */
export function auditEntriesFor(event: AuditableEvent): AuditEntry[] {
  switch (event.type) {
    case 'session.revoked': {
      // A single sign-out is routine; revoking every session is a security event.
      if (event.payload.reason === 'sign_out') return [];
      return [
        {
          action: 'auth.sessions_revoked',
          resourceType: 'user',
          resourceId: event.payload.userId,
          details: { reason: event.payload.reason, sessionCount: event.payload.sessionIds.length },
        },
      ];
    }
    case 'ticket.created': {
      const { ticket } = event.payload;
      return [
        {
          action: 'ticket.created',
          resourceType: 'ticket',
          resourceId: ticket.id,
          details: {
            number: ticket.number,
            state: ticket.state,
            priority: ticket.priority,
            groupId: ticket.group?.id ?? null,
            ownerId: ticket.owner?.id ?? null,
          },
        },
      ];
    }
    case 'ticket.updated': {
      // Owner changes are audited from `ticket.assigned`, which says who lost and gained the ticket.
      const { ticket, changes } = event.payload;
      return changes.flatMap((change) => {
        const action = TICKET_FIELD_ACTIONS[change.field];
        if (action === undefined) return [];
        return [
          {
            action,
            resourceType: 'ticket',
            resourceId: ticket.id,
            details: { number: ticket.number, from: change.old, to: change.new },
          },
        ];
      });
    }
    case 'ticket.assigned': {
      const { ticketId, previousOwnerId, ownerId } = event.payload;
      if (previousOwnerId === ownerId) return [];
      const action =
        ownerId === null ? 'ticket.unassigned' : previousOwnerId === null ? 'ticket.assigned' : 'ticket.reassigned';
      return [{ action, resourceType: 'ticket', resourceId: ticketId, details: { previousOwnerId, ownerId } }];
    }
    case 'message.created': {
      const message = event.payload;
      return [
        {
          action: message.visibility === 'internal' ? 'ticket.note_added' : 'ticket.message_added',
          resourceType: 'ticket',
          resourceId: message.ticketId,
          details: {
            messageId: message.id,
            authorKind: message.authorKind,
            attachmentCount: message.attachments.length,
            mentionCount: message.mentions.length,
          },
        },
      ];
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
  readonly eventTypes: readonly AuditedEvent[] = AUDITED_EVENTS;

  constructor(
    unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
  ) {
    super(unitOfWork);
  }

  protected async handle(tx: TenantTransaction, event: DomainEvent<AuditedEvent>): Promise<void> {
    // The relay routes by `eventTypes`, so `type` and `payload` always agree.
    const entries = auditEntriesFor(event as AuditableEvent);
    const actor = toActor(event.actor);
    for (const entry of entries) {
      await this.audit.record(tx, entry, { actor });
    }
  }
}
