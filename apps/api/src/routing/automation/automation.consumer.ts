import { Injectable } from '@nestjs/common';

import { Clock } from '../../platform-kernel/clock.js';
import { tenantScopeOf, UnitOfWork, type TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';
import { IdempotentHandler, type DomainEvent } from '../../platform-kernel/jobs/idempotent-handler.js';
import { QueueRegistry } from '../../platform-kernel/jobs/queues.js';

import { AutomationMatchRepository, enqueueRun, MAX_CHAIN_DEPTH } from './automation-engine.js';
import { AutomationRulesRepository } from './automation-rules.repository.js';

import type { MessageDto } from '../../messaging/message-dto.js';
import type { DomainEventPayload, DomainEventType } from '../../platform-kernel/outbox/event-types.js';

/**
 * The event side of automation rules (T254, FR-088, FR-089): on `ticket.created`, `ticket.updated`
 * and `message.created` (a customer's message: "message received"), finds the enabled rules for
 * that trigger whose conditions match the ticket now, and queues one run per rule
 * (`AutomationRunJob`, keyed by the event, so a redelivery adds nothing).
 *
 * Loop guard: an event written by a rule's run carries the rule as its actor and the run's cause.
 * A rule never runs on an event it caused itself, and an event already `MAX_CHAIN_DEPTH` rules deep
 * triggers nothing, so rules that trigger each other stop after three links.
 */

type Handled = Extract<DomainEventType, 'ticket.created' | 'ticket.updated' | 'message.created'>;

function ticketIdOf(event: DomainEvent<Handled>): string {
  if (event.type === 'message.created') return (event.payload as MessageDto).ticketId;
  return (event.payload as DomainEventPayload<'ticket.created'>).ticket.id;
}

@Injectable()
export class AutomationConsumer extends IdempotentHandler<Handled> {
  readonly consumer = 'automation-rules';
  readonly queue = 'automation' as const;
  readonly eventTypes: readonly Handled[] = ['ticket.created', 'ticket.updated', 'message.created'];

  constructor(
    unitOfWork: UnitOfWork,
    private readonly queues: QueueRegistry,
    private readonly clock: Clock,
  ) {
    super(unitOfWork);
  }

  protected async handle(tx: TenantTransaction, event: DomainEvent<Handled>): Promise<void> {
    const ctx = tenantScopeOf(tx);
    if (ctx === undefined) throw new Error('AutomationConsumer.handle must run inside withTenant');
    if (event.type === 'message.created') {
      const message = event.payload as MessageDto;
      if (message.authorKind !== 'customer' || message.visibility !== 'public') return;
    }

    const byRule = event.actor.kind === 'automation' ? event.actor.id : null;
    const depth = byRule === null ? 0 : (event.cause?.depth ?? 1);
    if (depth >= MAX_CHAIN_DEPTH) return;

    const rules = await new AutomationRulesRepository(ctx).enabledFor(tx, event.type);
    if (rules.length === 0) return;
    const ticketId = ticketIdOf(event);
    const match = new AutomationMatchRepository(ctx);
    const now = this.clock.now();
    for (const rule of rules) {
      if (rule.id === byRule || rule.id === event.cause?.ruleId) continue;
      if (!(await match.matches(tx, ticketId, rule.conditions, now))) continue;
      await enqueueRun(this.queues, { tenantId: ctx.tenantId, ruleId: rule.id, ticketId, triggerKey: event.id, depth: depth + 1, eventId: event.id });
    }
  }
}
