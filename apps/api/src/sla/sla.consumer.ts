import { Injectable } from '@nestjs/common';

import { tenantScopeOf, UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { IdempotentHandler, type DomainEvent } from '../platform-kernel/jobs/idempotent-handler.js';

import { SlaRecomputeService } from './sla-recompute.service.js';
import { SlaRepository } from './sla.repository.js';

import type { MessageDto } from '../messaging/message-dto.js';
import type { DomainEventPayload, DomainEventType } from '../platform-kernel/outbox/event-types.js';

/**
 * Keeps `ticket_sla` right (T223, research D15, FR-084, FR-085). On every event that can change a
 * ticket's policy or timers it recomputes that ticket's row from the ticket's CURRENT state
 * (`SlaRecomputeService`), so a late or out-of-order event converges on the same row and a
 * redelivery is harmless. The sweeper (tickets/sweeper.job.ts) emits `sla.warning` and
 * `sla.breached` from these rows.
 *
 * Events: `ticket.created`; `ticket.updated` (priority, group, state, replies and everything else
 * that touches the row); `ticket.state_changed`, `ticket.reopened`, `ticket.closed`;
 * `message.created` (public messages only).
 *
 * Choices where the spec is silent (conservative; revisit with product):
 * 1. Policy: the first policy by ascending `position` (ties by id) whose conditions match the
 *    ticket's priority and group. No match removes the ticket's row; `sla_events` already emitted
 *    are kept. After a priority or group change the new policy's times are rebuilt from the
 *    ticket's creation (or the customer message for next response); a later due time does not
 *    re-warn, because `sla_events` has its unique key per ticket and target.
 * 2. Timers start at ticket creation, including time spent Ungrouped (FR-085): Ungrouped never
 *    pauses anything. A policy that matches on group never matches an ungrouped ticket unless it
 *    lists `ungrouped`.
 * 3. First response ends at the first public staff reply (`tickets.first_agent_reply_at`). Next
 *    response starts at the first public customer message after the last public staff reply and
 *    ends at the next public staff reply; later customer messages don't restart it, internal notes
 *    never count, and it only exists after the first reply (before it, first response covers the
 *    customer). Staff-started tickets have a first reply from the start. A public assistant
 *    answer is a staff reply (FR-029): `AssistantMessageWriter` sets the same reply timestamps, so
 *    this stays derived from the ticket row. The assistant's hand-off notice
 *    (`authorKind = 'assistant'`, `metadata.handoff`) is not a reply: it moves no timestamp and
 *    the consumer skips it.
 * 4. Resolution ends when the ticket is resolved or closed: then no timer runs and the status is
 *    `ok`. A reopened ticket gets its resolution times rebuilt from CREATION, not from the reopen
 *    (an old ticket may breach at once; a breach already recorded does not repeat).
 * 5. `pending_reminder` and `pending_close` pause the resolution timer only (`paused_since`).
 *    Leaving the state moves the due and warn times later by the business minutes spent paused.
 *    If the policy changes while paused, the times are rebuilt from creation and earlier pauses
 *    are not re-applied. Response targets never pause.
 * 6. Pause and resume instants are the Clock time the consumer runs (the outbox `occurred_at` is
 *    database time, not the Clock), so they lag the real change by the queue delay.
 * 7. A `message.moved` between tickets is not a trigger: the next event on either ticket
 *    recomputes it from the messages it holds.
 *
 * `SlaRecomputeService.recompute(..., { reset: true })` is for policy or business-hours edits
 * (T224): the stored resolution times are otherwise kept so served pauses survive.
 */

type Handled = Extract<
  DomainEventType,
  'ticket.created' | 'ticket.updated' | 'ticket.state_changed' | 'ticket.reopened' | 'ticket.closed' | 'message.created'
>;

/** The ticket an event is about, or undefined for an event that can't change its SLA. */
function ticketIdOf(event: DomainEvent<Handled>): string | undefined {
  switch (event.type) {
    case 'ticket.created':
    case 'ticket.updated':
      return (event.payload as DomainEventPayload<'ticket.created'>).ticket.id;
    case 'message.created': {
      const message = event.payload as MessageDto;
      return message.visibility === 'public' ? message.ticketId : undefined; // internal notes never count
    }
    case 'ticket.state_changed':
    case 'ticket.reopened':
    case 'ticket.closed':
      return (event.payload as { ticketId: string }).ticketId;
  }
}

@Injectable()
export class SlaConsumer extends IdempotentHandler<Handled> {
  readonly consumer = 'sla';
  readonly queue = 'sla' as const;
  readonly eventTypes: readonly Handled[] = ['ticket.created', 'ticket.updated', 'ticket.state_changed', 'ticket.reopened', 'ticket.closed', 'message.created'];

  constructor(
    unitOfWork: UnitOfWork,
    private readonly recompute: SlaRecomputeService,
  ) {
    super(unitOfWork);
  }

  protected async handle(tx: TenantTransaction, event: DomainEvent<Handled>): Promise<void> {
    const ctx = tenantScopeOf(tx);
    if (ctx === undefined) throw new Error('SlaConsumer.handle must run inside withTenant');
    const ticketId = ticketIdOf(event);
    if (ticketId === undefined) return;
    // The assistant's hand-off notice answers nothing: no reply timestamp moved, so nothing to recompute.
    if (event.type === 'message.created') {
      const message = event.payload as MessageDto;
      if (message.authorKind === 'assistant' && (await new SlaRepository(ctx).isHandoffMessage(tx, message.id))) return;
    }
    await this.recompute.recompute(tx, ticketId);
  }
}
