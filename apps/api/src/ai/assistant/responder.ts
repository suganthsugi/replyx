import { Injectable } from '@nestjs/common';

import { TenantRepository } from '../../platform-kernel/db/tenant-repository.js';
import { OutboxService } from '../../platform-kernel/outbox/outbox.service.js';
import { ticketStream } from '../../tickets/ticket-events.js';
import { ACTIVE_STATES, TicketsRepository, type TicketRow } from '../../tickets/tickets.repository.js';
import { AiSettingsRepository, DEFAULT_SETTINGS, type AiSettingsRow } from '../settings/ai-settings.repository.js';

import { isAnswering } from './ai-ticket-status.js';
import { AiTicketStateRepository, type AiTicketState } from './assistant.repositories.js';

import type { JsonValue } from '../../platform-kernel/db/tables/column-types.js';
import type { TenantContext } from '../../platform-kernel/db/tenant-context.js';
import type { TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';
import type { Responder } from '../../platform-kernel/outbox/event-types.js';

/** What decides who answers a ticket's next customer message (data-model.md "Derived: responder"). */
export interface ResponderFacts {
  /** `isAnswering`: AI active, Auto-reply, ticket not stopped. */
  assistantAnswering: boolean;
  owner: { name: string; avatarUrl: string | null } | null;
}

/**
 * The single place the responder is computed (FR-031, research R18): the assistant while it is
 * answering, else the ticket's owner, else the team. The ticket detail, the customer conversation
 * and `conversation.responder_changed` all go through it.
 */
export function computeResponder(facts: ResponderFacts): Responder {
  if (facts.assistantAnswering) return { kind: 'assistant' };
  if (facts.owner !== null) return { kind: 'agent', name: facts.owner.name, avatarUrl: facts.owner.avatarUrl };
  return { kind: 'team' };
}

export function sameResponder(a: Responder, b: Responder): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== 'agent' || (b.kind === 'agent' && a.name === b.name && a.avatarUrl === b.avatarUrl);
}

class ResponderRepository extends TenantRepository {
  async nameOf(tx: TenantTransaction, userId: string): Promise<string | undefined> {
    const row = await this.selectFrom(tx, 'users').select('users.name').where('users.id', '=', userId).executeTakeFirst();
    return row?.name;
  }

  /** The customer's most recently updated active ticket (the one their next message joins). */
  async activeTicketOf(tx: TenantTransaction, customerId: string): Promise<TicketRow | undefined> {
    const row = await this.selectFrom(tx, 'tickets')
      .select('tickets.id')
      .where('tickets.customer_id', '=', customerId)
      .where('tickets.state', 'in', ACTIVE_STATES)
      .where('tickets.merged_into_id', 'is', null)
      .orderBy('tickets.updated_at', 'desc')
      .orderBy('tickets.id', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row === undefined ? undefined : new TicketsRepository(this.ctx).find(tx, row.id);
  }
}

export interface ResponderSnapshot {
  responder: Responder;
  settings: AiSettingsRow;
  /** Undefined until the assistant has touched the ticket. */
  state: AiTicketState | undefined;
}

/** The ticket's responder with the facts behind it. Plain repositories, so any module can call it. */
export async function responderSnapshot(tx: TenantTransaction, ctx: TenantContext, ticket: TicketRow): Promise<ResponderSnapshot> {
  const settings = (await new AiSettingsRepository(ctx).find(tx)) ?? DEFAULT_SETTINGS;
  const state = await new AiTicketStateRepository(ctx).find(tx, ticket.id);
  const ownerName = ticket.owner_id === null ? undefined : await new ResponderRepository(ctx).nameOf(tx, ticket.owner_id);
  const responder = computeResponder({
    assistantAnswering: isAnswering(settings, state),
    // Avatar URLs arrive with attachment-backed avatars (same as `UserRef`).
    owner: ownerName === undefined ? null : { name: ownerName, avatarUrl: null },
  });
  return { responder, settings, state };
}

/**
 * Who answers the customer's next message (customer conversation, FR-031). Without an active
 * ticket the next message opens a new one, which the assistant answers when it is on in
 * Auto-reply; otherwise the team does. Never carries a ticket concept.
 */
export async function responderForCustomer(tx: TenantTransaction, ctx: TenantContext, customerId: string): Promise<Responder> {
  const active = await new ResponderRepository(ctx).activeTicketOf(tx, customerId);
  if (active !== undefined) return (await responderSnapshot(tx, ctx, active)).responder;
  const settings = (await new AiSettingsRepository(ctx).find(tx)) ?? DEFAULT_SETTINGS;
  return computeResponder({ assistantAnswering: isAnswering(settings, undefined), owner: null });
}

/** Computes a ticket's responder and announces a change (`conversation.responder_changed`, research R18). */
@Injectable()
export class ResponderService {
  constructor(private readonly outbox: OutboxService) {}

  /** The ticket's responder now, or undefined when the ticket does not exist. */
  async current(tx: TenantTransaction, ctx: TenantContext, ticketId: string): Promise<Responder | undefined> {
    const ticket = await new TicketsRepository(ctx).find(tx, ticketId);
    return ticket === undefined ? undefined : (await responderSnapshot(tx, ctx, ticket)).responder;
  }

  /**
   * Emits `conversation.responder_changed` when the responder differs from `before`: to the ticket,
   * and to the customer only when this is the ticket their conversation shows (their active ticket,
   * see `responderForCustomer`). A change on another of their tickets must not move their badge.
   */
  async emitIfChanged(tx: TenantTransaction, ctx: TenantContext, ticketId: string, before: Responder | undefined): Promise<boolean> {
    const ticket = await new TicketsRepository(ctx).find(tx, ticketId);
    if (ticket === undefined) return false;
    const { responder: after } = await responderSnapshot(tx, ctx, ticket);
    if (before !== undefined && sameResponder(before, after)) return false;
    const shownToCustomer = (await new ResponderRepository(ctx).activeTicketOf(tx, ticket.customer_id))?.id === ticketId;
    await this.outbox.append(tx, {
      type: 'conversation.responder_changed',
      payload: { ticketId, responder: after },
      ...(shownToCustomer
        ? {
            // The customer's projection drops the ticket id.
            customerPayload: { type: 'conversation.responder_changed', data: { responder: after as unknown as JsonValue } },
            streams: [ticketStream(ticketId), `conversation:${ticket.customer_id}`],
          }
        : { streams: [ticketStream(ticketId)] }),
    });
    return true;
  }
}
