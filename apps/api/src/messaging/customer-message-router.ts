import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { Clock } from '../platform-kernel/clock.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { notFound, validationFailed } from '../platform-kernel/http/app-error.js';
import { uuidv7 } from '../platform-kernel/ids.js';
import { OutboxService } from '../platform-kernel/outbox/outbox.service.js';
import { TenantSettingsRepository, type ConversationSettings } from '../tenancy/tenant-settings.js';
import { transition, type TransitionResult } from '../tickets/state-machine.js';
import { groupStream, summaryOf, ticketStream } from '../tickets/ticket-events.js';
import { TicketHistoryService, historyValue, type FieldChange } from '../tickets/ticket-history.service.js';
import { TicketNumberService } from '../tickets/ticket-number.service.js';
import { TicketsRepository, type TicketPatch, type TicketRow } from '../tickets/tickets.repository.js';

import { customerEvents, toConversationMessage, type ConversationMessage } from './customer-projection.js';
import { toMessageDto } from './message-dto.js';
import { MessagesRepository, type MessageRow } from './messages.repository.js';
import { TICKET_ROUTER, type TicketRouter } from './ticket-router.js';

import type { TicketOrigin } from '../platform-kernel/db/tables/tickets.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * Where a customer's message goes (FR-050, FR-051, research D10, data-model.md "Conversation
 * routing"). One transaction per message:
 *
 *   1. `pg_advisory_xact_lock` on (tenant, customer): every send of this customer, and the
 *      auto-close sweeper (US7), runs one at a time, so two concurrent sends can never create two
 *      tickets and a message can't land on a ticket that is being closed.
 *   2. A repeated `clientMessageId` returns the stored message; nothing else happens.
 *   3. Target: the most recently updated active ticket; else the latest ticket if it is resolved
 *      and still within the grace period (reopened, group and owner kept); else, when there is a
 *      latest ticket (closed, or resolved past grace, which is closed first), reopen it or start
 *      a follow-up linked to it, per `after_close_behavior`; else a brand-new ticket.
 *   4. New tickets get the next number, a title from the message and one `TicketRouter` pass.
 *   5. The message is stored, the ticket's state and timestamps move, and the outbox gets
 *      `ticket.created` (new tickets, list rooms), `ticket.updated`/`ticket.reopened` (existing
 *      ones), `message.created` (ticket room + the customer's conversation, as a projection) and
 *      the customer's new friendly status.
 */

export interface MessageCustomer {
  id: string;
  email: string;
}

export interface CustomerMessageInput {
  body: string;
  clientMessageId: string;
  attachmentIds: readonly string[];
}

export interface AcceptedMessage {
  message: ConversationMessage;
  /** False when the `clientMessageId` had already been used. */
  created: boolean;
}

const TITLE_LENGTH = 80;
const ATTACHMENT_TTL_MS = 24 * 3_600_000;

/** The first 80 characters of the message, cut at a word boundary (FR-031). */
export function titleFrom(body: string): string {
  const text = body.replace(/\s+/g, ' ').trim();
  if (text.length <= TITLE_LENGTH) return text;
  const cut = text.slice(0, TITLE_LENGTH + 1);
  const space = cut.lastIndexOf(' ');
  // A single very long word is cut hard rather than leaving a stub.
  return (space >= TITLE_LENGTH / 2 ? cut.slice(0, space) : text.slice(0, TITLE_LENGTH)).trim();
}

interface Target {
  ticket: TicketRow;
  created: boolean;
}

@Injectable()
export class CustomerMessageRouter {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    private readonly numbers: TicketNumberService,
    private readonly history: TicketHistoryService,
    @Inject(TICKET_ROUTER) private readonly router: TicketRouter,
  ) {}

  /** `customerId` is the signed-in customer (never taken from input). */
  accept(ctx: TenantContext, customerId: string, input: CustomerMessageInput): Promise<AcceptedMessage> {
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      await lockCustomer(tx, ctx.tenantId, customerId);
      const customer = await new RoutingRepository(ctx).customer(tx, customerId);
      if (customer === undefined) throw notFound('customer');

      const messages = new MessagesRepository(ctx);
      const existing = await messages.findByClientMessageId(tx, customer.id, input.clientMessageId);
      if (existing !== undefined) return { message: await this.project(ctx, tx, existing, customer.id), created: false };

      const now = this.clock.now();
      const settings = await new TenantSettingsRepository(ctx).conversation(tx);
      const target = await this.target(ctx, tx, customer, input.body, settings, now);

      const message = await messages.insert(tx, {
        id: uuidv7(),
        ticket_id: target.ticket.id,
        author_id: customer.id,
        author_kind: 'customer',
        visibility: 'public',
        body: input.body,
        client_message_id: input.clientMessageId,
        created_at: now,
        updated_at: now,
      });
      const attachmentIds = [...new Set(input.attachmentIds)];
      const bound = await messages.bindAttachments(tx, message.id, customer.id, attachmentIds, new Date(now.getTime() - ATTACHMENT_TTL_MS));
      if (bound !== attachmentIds.length) throw validationFailed([{ path: 'attachmentIds', issue: 'invalid' }]);

      const moved = transition(timersOf(target.ticket), { cause: 'customer_message', now, gracePeriodHours: settings.gracePeriodHours });
      const ticket = await this.applyMessage(ctx, tx, target, moved, now);

      const staffMessage = await this.staffDto(ctx, tx, message);
      const projected = await this.project(ctx, tx, message, customer.id);
      await this.outbox.append(tx, {
        type: 'message.created',
        payload: staffMessage,
        customerPayload: customerEvents.message(projected),
        streams: [ticketStream(ticket.id), `conversation:${customer.id}`],
      });
      await this.outbox.append(tx, {
        type: 'conversation.status_changed',
        payload: { customerId: customer.id, status: 'received' },
        customerPayload: customerEvents.status('received'),
        streams: [`conversation:${customer.id}`],
      });
      return { message: projected, created: true };
    });
  }

  /** Steps 2–5 of the routing algorithm. Tickets returned are locked. */
  private async target(
    ctx: TenantContext,
    tx: TenantTransaction,
    customer: MessageCustomer,
    body: string,
    settings: ConversationSettings,
    now: Date,
  ): Promise<Target> {
    const tickets = new TicketsRepository(ctx);
    const active = await tickets.lockActiveForCustomer(tx, customer.id);
    if (active !== undefined) return { ticket: active, created: false };

    const last = await tickets.lockLatestForCustomer(tx, customer.id);
    if (last === undefined) return { ticket: await this.create(ctx, tx, customer, body, 'customer_message', now), created: true };
    if (last.state === 'resolved' && last.auto_close_at !== null && now < last.auto_close_at) {
      return { ticket: last, created: false };
    }

    // Resolved past its grace period but not swept yet: close it now, as the sweeper would.
    const previous = last.state === 'resolved' ? await this.closeExpired(ctx, tx, last, settings, now) : last;
    if (settings.afterCloseBehavior === 'reopen_previous') return { ticket: previous, created: false };

    const followUp = await this.create(ctx, tx, customer, body, 'follow_up', now);
    await new RoutingRepository(ctx).followUp(tx, followUp.id, previous.id);
    return { ticket: followUp, created: true };
  }

  private async create(
    ctx: TenantContext,
    tx: TenantTransaction,
    customer: MessageCustomer,
    body: string,
    origin: TicketOrigin,
    now: Date,
  ): Promise<TicketRow> {
    const tickets = new TicketsRepository(ctx);
    let ticket = await tickets.insert(tx, {
      id: uuidv7(),
      number: await this.numbers.next(tx),
      title: titleFrom(body),
      customer_id: customer.id,
      group_id: null,
      owner_id: null,
      state: 'new',
      origin,
      waiting_on: 'support',
      created_at: now,
      updated_at: now,
    });

    const decision = await this.router.route(tx, ticket, { body }, customer);
    const groupId = decision?.groupId;
    if (groupId !== undefined && (await new RoutingRepository(ctx).isActiveGroup(tx, groupId))) {
      const patch: TicketPatch = { group_id: groupId, ...(decision?.priority === undefined ? {} : { priority: decision.priority }) };
      const changes: FieldChange[] = [
        { field: 'group_id', old: null, new: groupId },
        ...(decision?.priority === undefined ? [] : [{ field: 'priority', old: ticket.priority, new: decision.priority }]),
      ];
      ticket = await tickets.update(tx, ticket.id, patch);
      await this.history.record(tx, ticket.id, changes, { actorKind: 'routing' });
    }
    return ticket;
  }

  private async closeExpired(
    ctx: TenantContext,
    tx: TenantTransaction,
    ticket: TicketRow,
    settings: ConversationSettings,
    now: Date,
  ): Promise<TicketRow> {
    const closed = transition(timersOf(ticket), { cause: 'sweeper', to: 'closed', now, gracePeriodHours: settings.gracePeriodHours });
    const row = await new TicketsRepository(ctx).update(tx, ticket.id, { state: closed.state, ...closed.changes });
    const changes = stateChanges(ticket, closed);
    const eventId = await this.outbox.append(tx, {
      type: 'ticket.updated',
      actor: { kind: 'system' },
      payload: { ticket: await summaryOf(ctx, tx, row), changes },
      streams: [ticketStream(row.id), groupStream(row.group_id)],
    });
    await this.outbox.append(tx, { type: 'ticket.closed', actor: { kind: 'system' }, payload: { ticketId: row.id }, streams: [ticketStream(row.id)] });
    await this.history.record(tx, row.id, changes, { eventId, actorKind: 'system' });
    return row;
  }

  /** Moves the target's state and timestamps for the new message and announces existing tickets. */
  private async applyMessage(ctx: TenantContext, tx: TenantTransaction, target: Target, moved: TransitionResult, now: Date): Promise<TicketRow> {
    const before = target.ticket;
    const patch: TicketPatch = { ...moved.changes, last_customer_message_at: now, waiting_on: 'support' };
    if (moved.stateChanged) patch.state = moved.state;
    const ticket = await new TicketsRepository(ctx).update(tx, before.id, patch);
    if (target.created) {
      // Announced once it has its first message, so list rows are complete.
      await this.outbox.append(tx, {
        type: 'ticket.created',
        payload: { ticket: await summaryOf(ctx, tx, ticket) },
        streams: [groupStream(ticket.group_id)],
      });
      return ticket;
    }

    const changes: FieldChange[] = [
      ...stateChanges(before, moved),
      ...(before.waiting_on === 'support' ? [] : [{ field: 'waiting_on', old: before.waiting_on, new: 'support' }]),
    ];
    const eventId = await this.outbox.append(tx, {
      type: 'ticket.updated',
      payload: {
        ticket: await summaryOf(ctx, tx, ticket),
        changes: [...changes, { field: 'last_customer_message_at', old: historyValue(before.last_customer_message_at), new: now.toISOString() }],
      },
      streams: [ticketStream(ticket.id), groupStream(ticket.group_id)],
    });
    if (moved.reopened) {
      await this.outbox.append(tx, { type: 'ticket.reopened', payload: { ticketId: ticket.id, from: moved.from }, streams: [ticketStream(ticket.id)] });
    }
    await this.history.record(tx, ticket.id, changes, { eventId });
    return ticket;
  }

  private async staffDto(ctx: TenantContext, tx: TenantTransaction, message: MessageRow) {
    const messages = new MessagesRepository(ctx);
    const [authors, attachments] = await Promise.all([messages.authors(tx, [message.author_id]), messages.attachmentsFor(tx, [message.id])]);
    return toMessageDto(message, { authors, attachments });
  }

  private async project(ctx: TenantContext, tx: TenantTransaction, message: MessageRow, customerId: string) {
    const attachments = await new MessagesRepository(ctx).attachmentsFor(tx, [message.id]);
    return toConversationMessage(message, customerId, { authors: new Map(), attachments });
  }
}

/**
 * Serializes routing for one customer, and the auto-close sweeper (D10, D11): every send of
 * theirs, and the sweeper closing one of their tickets, runs one at a time, so a customer message
 * racing an auto-close lands on exactly one ticket. Released automatically at commit or rollback.
 */
export async function lockCustomer(tx: TenantTransaction, tenantId: string, customerId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:${customerId}`}))`.execute(tx);
}

export function timersOf(ticket: TicketRow) {
  return {
    state: ticket.state,
    pendingUntil: ticket.pending_until,
    resolvedAt: ticket.resolved_at,
    autoCloseAt: ticket.auto_close_at,
    closedAt: ticket.closed_at,
  };
}

/** History entries for a transition: the state and each timer that changed. */
export function stateChanges(before: TicketRow, moved: TransitionResult): FieldChange[] {
  const changes: FieldChange[] = moved.stateChanged ? [{ field: 'state', old: before.state, new: moved.state }] : [];
  for (const [field, value] of Object.entries(moved.changes) as [keyof TransitionResult['changes'], Date | null][]) {
    changes.push({ field, old: historyValue(before[field]), new: historyValue(value) });
  }
  return changes;
}

class RoutingRepository extends TenantRepository {
  async followUp(tx: TenantTransaction, fromTicketId: string, toTicketId: string): Promise<void> {
    await this.insertInto(tx, 'ticket_links', { from_ticket_id: fromTicketId, to_ticket_id: toTicketId, kind: 'follow_up_of' }).execute();
  }

  customer(tx: TenantTransaction, userId: string): Promise<MessageCustomer | undefined> {
    return this.selectFrom(tx, 'users')
      .select(['users.id', 'users.email'])
      .where('users.id', '=', userId)
      .where('users.kind', '=', 'customer')
      .where('users.status', '=', 'active')
      .executeTakeFirst();
  }

  async isActiveGroup(tx: TenantTransaction, groupId: string): Promise<boolean> {
    const row = await this.selectFrom(tx, 'groups').select('groups.status').where('groups.id', '=', groupId).executeTakeFirst();
    return row?.status === 'active';
  }
}
