import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AuditService } from '../audit/audit.service.js';
import { decide, PolicyService } from '../authorization/policy.service.js';
import { toMessageDto } from '../messaging/message-dto.js';
import { MessagesRepository } from '../messaging/messages.repository.js';
import { Clock } from '../platform-kernel/clock.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { conflict, notFound, permissionDenied } from '../platform-kernel/http/app-error.js';
import { uuidv7 } from '../platform-kernel/ids.js';
import { OutboxService } from '../platform-kernel/outbox/outbox.service.js';
import { TagsService } from '../tags/tags.service.js';

import { initialState } from './state-machine.js';
import { groupStream, summaryOf, ticketStream } from './ticket-events.js';
import { TicketHistoryService, historyValue, type FieldChange } from './ticket-history.service.js';
import { TicketNumberService } from './ticket-number.service.js';
import { TicketsRepository, type TicketPatch, type TicketRow } from './tickets.repository.js';
import { canView, SUPPORT, TicketsService, type Viewer } from './tickets.service.js';

import type { TicketDto } from './ticket-dto.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * Merge and split (contracts/tickets.yaml `/tickets/{id}/merge` and `/split`, FR-039, FR-042,
 * data-model.md "Ticket state machine" and "Conversation routing", T237).
 *
 * Merge folds this ticket (the source) into another of the same customer (the target):
 * - needs `ticket.merge` (edit on the group) on both tickets; an invisible ticket is 404;
 * - a different customer is 409 `DIFFERENT_CUSTOMER`; a source or target that is already merged is
 *   409 `ALREADY_MERGED`; merging a ticket into itself is 409 `SAME_TICKET`;
 * - the source becomes `closed` with `merged_into_id` set and gets a `merged_into` link to the
 *   target. Its messages stay where they are and the target's timeline includes them
 *   (`MessagesRepository.listForTicket`), so nothing is copied and the customer's thread, which
 *   reads every message of the customer's tickets, shows each message once;
 * - tickets that were merged into the source are repointed to the target, so a chain never forms;
 * - a repeat of the same merge returns the target unchanged (retries are idempotent).
 *
 * Split moves one public message into a new ticket of the same customer and group:
 * - needs `ticket.split` (edit on the group); the new ticket has `origin = split`, starts `new`
 *   and unassigned, and has a `split_from` link to the source;
 * - being the most recently updated active ticket, the customer's next message lands on it
 *   (`TicketsRepository.lockActiveForCustomer`);
 * - a repeat of the same split returns the ticket created the first time.
 *
 * Both take the same per-customer advisory lock as `CustomerMessageRouter.accept`, so a customer
 * message can't land on a ticket while it is being merged away.
 */

export interface SplitInput {
  messageId: string;
  title?: string;
}

const MAX_TITLE = 200;

/** Throws 404 when the ticket is invisible and 403 when the caller may not perform `key` on it. */
function require(access: Viewer, key: 'ticket.merge' | 'ticket.split', groupId: string | null): void {
  if (access === SUPPORT) throw permissionDenied();
  const decision = decide(access, key, { type: 'ticket', groupId });
  if (decision === 'not_found') throw notFound('ticket');
  if (decision === 'deny') throw permissionDenied();
}

/** The first line of the message, cut to a title; the source title when the message has no text. */
function titleFrom(body: string, fallback: string): string {
  const line = (body.split('\n').find((candidate) => candidate.trim() !== '') ?? '').trim();
  const title = line.slice(0, MAX_TITLE).trim();
  return title === '' ? fallback : title;
}

@Injectable()
export class MergeSplitService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly policy: PolicyService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    private readonly history: TicketHistoryService,
    private readonly audit: AuditService,
    private readonly numbers: TicketNumberService,
    private readonly tickets: TicketsService,
    private readonly tags: TagsService,
  ) {}

  async merge(ctx: TenantContext, sourceId: string, targetId: string): Promise<TicketDto> {
    const access = await this.access(ctx);
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new TicketsRepository(ctx);
      const peek = await repo.find(tx, sourceId);
      if (peek === undefined || !canView(access, peek.group_id)) throw notFound('ticket');
      require(access, 'ticket.merge', peek.group_id);
      if (targetId === sourceId) throw conflict('SAME_TICKET', 'A ticket cannot be merged into itself');

      await this.lockCustomer(ctx, tx, peek.customer_id);
      // Lock in id order so two merges over the same pair can't deadlock.
      const [first, second] = sourceId < targetId ? [sourceId, targetId] : [targetId, sourceId];
      const lockedFirst = await repo.lock(tx, first);
      const lockedSecond = await repo.lock(tx, second);
      const source = sourceId === first ? lockedFirst : lockedSecond;
      const target = sourceId === first ? lockedSecond : lockedFirst;
      if (source === undefined) throw notFound('ticket');
      if (target === undefined || !canView(access, target.group_id)) throw notFound('ticket');
      require(access, 'ticket.merge', target.group_id);

      if (source.merged_into_id === target.id) return this.toDto(ctx, tx, access, target);
      if (source.merged_into_id !== null) throw conflict('ALREADY_MERGED', 'This ticket is already merged into another ticket');
      if (target.merged_into_id !== null) throw conflict('ALREADY_MERGED', 'The target ticket is already merged into another ticket');
      if (source.customer_id !== target.customer_id) {
        throw conflict('DIFFERENT_CUSTOMER', 'The target ticket belongs to a different customer');
      }

      const now = this.clock.now();
      const patch: TicketPatch = { merged_into_id: target.id };
      const changes: FieldChange[] = [{ field: 'merged_into_id', old: null, new: target.id }];
      const closing = source.state !== 'closed';
      if (closing) {
        Object.assign(patch, { state: 'closed', closed_at: now, pending_until: null, auto_close_at: null });
        changes.push(
          { field: 'state', old: source.state, new: 'closed' },
          { field: 'closed_at', old: historyValue(source.closed_at), new: now.toISOString() },
        );
        if (source.pending_until !== null) changes.push({ field: 'pending_until', old: historyValue(source.pending_until), new: null });
        if (source.auto_close_at !== null) changes.push({ field: 'auto_close_at', old: historyValue(source.auto_close_at), new: null });
      }

      await repo.repointMerged(tx, source.id, target.id);
      const closedSource = await repo.update(tx, source.id, patch);
      await new LinksRepository(ctx).insert(tx, source.id, target.id, 'merged_into', actorUserId(ctx));

      const targetChange: FieldChange = { field: 'merged_from', old: null, new: source.id };
      const eventId = await this.outbox.append(tx, {
        type: 'ticket.updated',
        payload: { ticket: await summaryOf(ctx, tx, closedSource), changes },
        streams: [ticketStream(source.id), groupStream(source.group_id)],
      });
      await this.history.record(tx, source.id, changes, { eventId });

      const targetEventId = await this.outbox.append(tx, {
        type: 'ticket.updated',
        payload: { ticket: await summaryOf(ctx, tx, target), changes: [targetChange] },
        streams: [ticketStream(target.id), groupStream(target.group_id)],
      });
      await this.history.record(tx, target.id, [targetChange], { eventId: targetEventId });

      if (closing) {
        await this.outbox.append(tx, {
          type: 'ticket.state_changed',
          payload: { ticketId: source.id, from: source.state, to: 'closed' },
          streams: [ticketStream(source.id)],
        });
        await this.outbox.append(tx, { type: 'ticket.closed', payload: { ticketId: source.id }, streams: [ticketStream(source.id)] });
      }
      await this.outbox.append(tx, {
        type: 'ticket.removed_from_view',
        payload: { ticketId: source.id, reason: 'merged' },
        streams: [groupStream(source.group_id)],
      });
      await this.audit.record(tx, {
        action: 'ticket.merged',
        resourceType: 'ticket',
        resourceId: source.id,
        details: { number: source.number, targetTicketId: target.id, targetNumber: target.number },
      });

      return this.toDto(ctx, tx, access, target);
    });
  }

  async split(ctx: TenantContext, sourceId: string, input: SplitInput): Promise<TicketDto> {
    const access = await this.access(ctx);
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new TicketsRepository(ctx);
      const peek = await repo.find(tx, sourceId);
      if (peek === undefined || !canView(access, peek.group_id)) throw notFound('ticket');
      require(access, 'ticket.split', peek.group_id);

      await this.lockCustomer(ctx, tx, peek.customer_id);
      const source = await repo.lock(tx, sourceId);
      if (source === undefined) throw notFound('ticket');

      const messages = new MessagesRepository(ctx);
      const message = await messages.find(tx, input.messageId);
      if (message === undefined) throw notFound('message');

      // A retry finds its message already on the ticket it was split into.
      if (message.ticket_id !== source.id) {
        const earlier = await repo.splitTicketFrom(tx, source.id, message.ticket_id);
        if (earlier !== undefined) return this.toDto(ctx, tx, access, earlier);
        // A message of a ticket merged into this one is part of this timeline too.
        const home = await repo.find(tx, message.ticket_id);
        if (home === undefined || home.merged_into_id !== source.id) throw notFound('message');
      }
      if (message.visibility !== 'public') {
        throw conflict('MESSAGE_NOT_SPLITTABLE', 'Only public messages can be split into a new ticket');
      }

      const fromCustomer = message.author_kind === 'customer';
      const created = await repo.insert(tx, {
        id: uuidv7(),
        number: await this.numbers.next(tx),
        title: input.title ?? titleFrom(message.body, source.title),
        customer_id: source.customer_id,
        group_id: source.group_id,
        owner_id: null,
        state: initialState('split'),
        origin: 'split',
        waiting_on: fromCustomer ? 'support' : 'customer',
        last_customer_message_at: fromCustomer ? message.created_at : null,
        // created_at/updated_at stay at the database's now(), the same time base as the touch trigger,
        // so the new ticket is the customer's most recently updated one (routing step 2).
      });

      const moved = await messages.move(tx, message.id, created.id);
      await new LinksRepository(ctx).insert(tx, created.id, source.id, 'split_from', actorUserId(ctx));

      await this.outbox.append(tx, {
        type: 'ticket.created',
        payload: { ticket: await summaryOf(ctx, tx, created) },
        streams: [groupStream(created.group_id)],
      });
      const dto = toMessageDto(moved, await this.messageRefs(ctx, tx, moved));
      const eventId = await this.outbox.append(tx, {
        type: 'message.moved',
        payload: dto,
        streams: [ticketStream(message.ticket_id), ticketStream(created.id)],
      });

      const moveChange: FieldChange = {
        field: 'message_moved',
        old: { messageId: message.id, ticketId: message.ticket_id },
        new: { messageId: message.id, ticketId: created.id },
      };
      await this.history.record(tx, message.ticket_id, [moveChange], { eventId });
      await this.history.record(tx, created.id, [moveChange, { field: 'split_from', old: null, new: source.id }], { eventId });
      await this.audit.record(tx, {
        action: 'ticket.split',
        resourceType: 'ticket',
        resourceId: source.id,
        details: { number: source.number, newTicketId: created.id, newNumber: created.number, messageId: message.id },
      });

      return this.toDto(ctx, tx, access, created);
    });
  }

  /** Same lock `CustomerMessageRouter.accept` takes: serializes writes touching this customer's tickets. */
  private async lockCustomer(ctx: TenantContext, tx: TenantTransaction, customerId: string): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`${ctx.tenantId}:${customerId}`}))`.execute(tx);
  }

  private async messageRefs(ctx: TenantContext, tx: TenantTransaction, row: Parameters<typeof toMessageDto>[0]) {
    const repo = new MessagesRepository(ctx);
    const [authors, attachments] = await Promise.all([
      repo.authors(tx, [row.author_id, ...row.mentions]),
      repo.attachmentsFor(tx, [row.id]),
    ]);
    return { authors, attachments };
  }

  private async toDto(ctx: TenantContext, tx: TenantTransaction, access: Viewer, row: TicketRow): Promise<TicketDto> {
    const tags = (await this.tags.tagsByTicketIds(tx, [row.id])).get(row.id) ?? [];
    return this.tickets.toDto(ctx, tx, access, row, tags);
  }

  /** Operators under a support-access grant are read-only (FR-001a): writes are always denied. */
  private async access(ctx: TenantContext): Promise<Viewer> {
    if (ctx.actor.kind === 'operator') return SUPPORT;
    if (ctx.actor.kind !== 'user') throw new Error('Merge and split need a user actor');
    return this.policy.effectiveAccess(ctx, ctx.actor.id);
  }
}

function actorUserId(ctx: TenantContext): string | null {
  return ctx.actor.kind === 'user' ? ctx.actor.id : null;
}

class LinksRepository extends TenantRepository {
  async insert(
    tx: TenantTransaction,
    fromTicketId: string,
    toTicketId: string,
    kind: 'merged_into' | 'split_from',
    createdBy: string | null,
  ): Promise<void> {
    await this.insertInto(tx, 'ticket_links', { id: uuidv7(), from_ticket_id: fromTicketId, to_ticket_id: toTicketId, kind, created_by: createdBy }).execute();
  }
}
