import { Injectable } from '@nestjs/common';

import { TenantRepository } from '../../platform-kernel/db/tenant-repository.js';
import { OutboxService } from '../../platform-kernel/outbox/outbox.service.js';
import { ticketStream } from '../../tickets/ticket-events.js';
import { TicketsRepository } from '../../tickets/tickets.repository.js';
import { AiStatus, isActive } from '../settings/ai-status.js';

import { isStopped } from './ai-ticket-status.js';
import { AiTicketStateRepository } from './assistant.repositories.js';

import type { AiReplyMode } from '../../platform-kernel/db/tables/ai.js';
import type { JsonValue } from '../../platform-kernel/db/tables/column-types.js';
import type { TenantContext } from '../../platform-kernel/db/tenant-context.js';
import type { TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';
import type { Responder } from '../../platform-kernel/outbox/event-types.js';

/** What decides who answers a ticket's next customer message (data-model.md "Derived: responder"). */
export interface ResponderFacts {
  replyMode: AiReplyMode;
  /** Key saved and not paused. */
  active: boolean;
  /** Handed off, a person replied, or taken over. */
  stopped: boolean;
  owner: { name: string; avatarUrl: string | null } | null;
}

/**
 * The single place the responder is computed. T024 extends it (ticket detail DTO, customer
 * conversation projection, the `ai` block) without touching its callers.
 */
export function computeResponder(facts: ResponderFacts): Responder {
  if (facts.active && facts.replyMode === 'auto' && !facts.stopped) return { kind: 'assistant' };
  if (facts.owner !== null) return { kind: 'agent', name: facts.owner.name, avatarUrl: facts.owner.avatarUrl };
  return { kind: 'team' };
}

export function sameResponder(a: Responder, b: Responder): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== 'agent' || (b.kind === 'agent' && a.name === b.name && a.avatarUrl === b.avatarUrl);
}

class OwnerRepository extends TenantRepository {
  async nameOf(tx: TenantTransaction, userId: string): Promise<string | undefined> {
    const row = await this.selectFrom(tx, 'users').select('users.name').where('users.id', '=', userId).executeTakeFirst();
    return row?.name;
  }
}

/** Computes a ticket's responder and announces a change (`conversation.responder_changed`, research R18). */
@Injectable()
export class ResponderService {
  constructor(
    private readonly status: AiStatus,
    private readonly outbox: OutboxService,
  ) {}

  /** The ticket's responder now, or undefined when the ticket does not exist. */
  async current(tx: TenantTransaction, ctx: TenantContext, ticketId: string): Promise<Responder | undefined> {
    const ticket = await new TicketsRepository(ctx).find(tx, ticketId);
    if (ticket === undefined) return undefined;
    const settings = await this.status.settings(ctx, tx);
    const state = await new AiTicketStateRepository(ctx).find(tx, ticketId);
    const ownerName = ticket.owner_id === null ? undefined : await new OwnerRepository(ctx).nameOf(tx, ticket.owner_id);
    return computeResponder({
      replyMode: settings.replyMode,
      active: isActive(settings),
      stopped: isStopped(state),
      // Avatar URLs arrive with attachment-backed avatars (same as `UserRef`).
      owner: ownerName === undefined ? null : { name: ownerName, avatarUrl: null },
    });
  }

  /** Emits `conversation.responder_changed` to the ticket and the customer when the responder differs from `before`. */
  async emitIfChanged(tx: TenantTransaction, ctx: TenantContext, ticketId: string, before: Responder | undefined): Promise<boolean> {
    const after = await this.current(tx, ctx, ticketId);
    if (after === undefined || (before !== undefined && sameResponder(before, after))) return false;
    const ticket = await new TicketsRepository(ctx).find(tx, ticketId);
    if (ticket === undefined) return false;
    await this.outbox.append(tx, {
      type: 'conversation.responder_changed',
      payload: { ticketId, responder: after },
      // The customer's projection drops the ticket id.
      customerPayload: { type: 'conversation.responder_changed', data: { responder: after as unknown as JsonValue } },
      streams: [ticketStream(ticketId), `conversation:${ticket.customer_id}`],
    });
    return true;
  }
}
