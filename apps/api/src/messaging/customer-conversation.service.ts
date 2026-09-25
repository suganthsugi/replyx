import { Injectable, Optional } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';

import { Clock } from '../platform-kernel/clock.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { notFound } from '../platform-kernel/http/app-error.js';
import { decodeCursor, encodeCursor } from '../platform-kernel/http/pagination.js';
import { OutboxService } from '../platform-kernel/outbox/outbox.service.js';
import { PresenceService } from '../platform-kernel/realtime/presence.service.js';
import { ticketStream } from '../tickets/ticket-events.js';
import { ACTIVE_STATES } from '../tickets/tickets.repository.js';

import {
  friendlyStatus,
  markerId,
  resolvedMarker,
  toConversationMessage,
  type FriendlyStatus,
  type FriendlyStatusCode,
  type ThreadItem,
} from './customer-projection.js';
import { MESSAGE_COLUMNS, MessagesRepository, type MessageRow } from './messages.repository.js';

import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * The customer's single thread (FR-048, FR-052, research D9): public messages across all of the
 * customer's tickets, oldest to newest, with a resolved marker after each resolved or closed
 * ticket, and a friendly status. Every query here is limited to `visibility = 'public'` and the
 * caller's own tickets; there is no method that could return anything else to a customer.
 *
 * Pages go backwards (scroll up): the newest page first, `before` for older ones. Items inside a
 * page are oldest first. Merged tickets show their messages but no marker of their own.
 */

export interface ConversationPage {
  items: ThreadItem[];
  olderCursor: string | null;
  status: FriendlyStatus;
  pendingRating: null;
  streamSeq: number;
}

const Position = z.object({ at: z.iso.datetime(), key: z.string().min(1).max(64) }).strict();
type Position = z.infer<typeof Position>;

interface Positioned {
  at: Date;
  key: string;
  item: ThreadItem;
}

/** Newest first: later time, then the larger key. */
function newestFirst(a: Positioned, b: Positioned): number {
  const byTime = b.at.getTime() - a.at.getTime();
  if (byTime !== 0) return byTime;
  return a.key < b.key ? 1 : a.key > b.key ? -1 : 0;
}

function isBefore(entry: { at: Date; key: string }, cursor: { at: Date; key: string } | undefined): boolean {
  if (cursor === undefined) return true;
  const diff = entry.at.getTime() - cursor.at.getTime();
  return diff < 0 || (diff === 0 && entry.key < cursor.key);
}

@Injectable()
export class CustomerConversationService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    @Optional() private readonly presence?: PresenceService,
  ) {}

  conversation(ctx: TenantContext, customerId: string, options: { limit: number; before?: string }): Promise<ConversationPage> {
    const before = options.before === undefined ? undefined : toCursor(decodeCursor(options.before, Position));
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const repo = new ConversationRepository(ctx);
      const [messages, markers, streamSeq] = await Promise.all([
        repo.publicMessagesBefore(tx, customerId, options.limit + 1, before),
        repo.resolutions(tx, customerId),
        repo.streamSeq(tx, customerId),
      ]);
      const refs = await this.refs(ctx, tx, messages);

      const entries: Positioned[] = [
        ...messages.map((row) => ({
          at: row.created_at,
          key: row.id,
          item: { type: 'message' as const, message: toConversationMessage(row, customerId, refs) },
        })),
        ...markers
          .map((ticket) => ({ at: ticket.at, key: markerId(ctx.tenantId, ticket.id, ticket.at), ticketId: ticket.id }))
          .filter((marker) => isBefore(marker, before))
          .map((marker) => ({
            at: marker.at,
            key: marker.key,
            item: { type: 'resolved_marker' as const, marker: resolvedMarker(ctx.tenantId, marker.ticketId, marker.at) },
          })),
      ].sort(newestFirst);

      const page = entries.slice(0, options.limit);
      const last = page.at(-1);
      return {
        items: page.reverse().map((entry) => entry.item),
        olderCursor: entries.length > options.limit && last !== undefined ? encodeCursor(positionOf(last)) : null,
        status: await this.status(ctx, tx, customerId),
        pendingRating: null,
        streamSeq,
      };
    });
  }

  /** FR-052: idle, received ("Support has your message"), replying or answered. */
  async status(ctx: TenantContext, tx: TenantTransaction, customerId: string): Promise<FriendlyStatus> {
    const active = await new ConversationRepository(ctx).activeTicket(tx, customerId);
    let code: FriendlyStatusCode = 'idle';
    if (active !== undefined) code = active.waiting_on === 'customer' ? 'answered' : 'received';
    if (code === 'received' && active !== undefined && this.presence !== undefined) {
      const { typing } = await this.presence.ticket(ctx.tenantId, active.id);
      if (typing.some((member) => !member.startsWith('customer:'))) code = 'replying';
    }
    return friendlyStatus(code);
  }

  /**
   * Read receipts (FR-053): support's public replies up to `upToMessageId` become read, and each
   * ticket they belong to gets one `message.read` for its staff. An id the customer can't see is
   * 404, like any missing message.
   */
  markRead(ctx: TenantContext, customerId: string, upToMessageId: string): Promise<void> {
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const upTo = await new ConversationRepository(ctx).publicMessage(tx, customerId, upToMessageId);
      if (upTo === undefined) throw notFound('message');
      const now = this.clock.now();
      const read = await new MessagesRepository(ctx).markSupportRepliesRead(tx, customerId, upTo.id, now);
      const latestByTicket = new Map<string, string>();
      // Rows come back in no particular order; ids are UUIDv7, so the largest is the latest.
      for (const row of read) {
        const current = latestByTicket.get(row.ticket_id);
        if (current === undefined || row.id > current) latestByTicket.set(row.ticket_id, row.id);
      }
      for (const [ticketId, messageId] of latestByTicket) {
        await this.outbox.append(tx, {
          type: 'message.read',
          payload: { ticketId, upToMessageId: messageId, readAt: now.toISOString() },
          streams: [ticketStream(ticketId)],
        });
      }
    });
  }

  private async refs(ctx: TenantContext, tx: TenantTransaction, rows: readonly MessageRow[]) {
    const messages = new MessagesRepository(ctx);
    const [authors, attachments] = await Promise.all([
      messages.authors(tx, rows.map((row) => row.author_id)),
      messages.attachmentsFor(tx, rows.map((row) => row.id)),
    ]);
    return { authors, attachments };
  }
}

function toCursor(position: Position): { at: Date; key: string } {
  return { at: new Date(position.at), key: position.key };
}

function positionOf(entry: Positioned): Position {
  return { at: entry.at.toISOString(), key: entry.key };
}

/** Customer-side reads. Every message query is `visibility = 'public'` on the customer's tickets. */
class ConversationRepository extends TenantRepository {
  publicMessagesBefore(
    tx: TenantTransaction,
    customerId: string,
    limit: number,
    before?: { at: Date; key: string },
  ): Promise<MessageRow[]> {
    let query = this.selectFrom(tx, 'ticket_messages')
      .innerJoin('tickets', (join) =>
        join.onRef('tickets.tenant_id', '=', 'ticket_messages.tenant_id').onRef('tickets.id', '=', 'ticket_messages.ticket_id'),
      )
      .select(MESSAGE_COLUMNS)
      .where('tickets.customer_id', '=', customerId)
      .where('ticket_messages.visibility', '=', 'public');
    if (before !== undefined) {
      // Marker keys are not uuids, so compare the key as text; message ids sort the same way.
      query = query.where(
        sql<boolean>`(ticket_messages.created_at < ${before.at} OR (ticket_messages.created_at = ${before.at} AND ticket_messages.id::text COLLATE "C" < ${before.key}))`,
      );
    }
    return query.orderBy('ticket_messages.created_at', 'desc').orderBy('ticket_messages.id', 'desc').limit(limit).execute();
  }

  publicMessage(tx: TenantTransaction, customerId: string, messageId: string) {
    return this.selectFrom(tx, 'ticket_messages')
      .innerJoin('tickets', (join) =>
        join.onRef('tickets.tenant_id', '=', 'ticket_messages.tenant_id').onRef('tickets.id', '=', 'ticket_messages.ticket_id'),
      )
      .select(['ticket_messages.id', 'ticket_messages.created_at'])
      .where('ticket_messages.id', '=', messageId)
      .where('tickets.customer_id', '=', customerId)
      .where('ticket_messages.visibility', '=', 'public')
      .executeTakeFirst();
  }

  /** When each resolved or closed, unmerged ticket was resolved (or closed without resolving). */
  async resolutions(tx: TenantTransaction, customerId: string): Promise<{ id: string; at: Date }[]> {
    const rows = await this.selectFrom(tx, 'tickets')
      .select(['tickets.id', 'tickets.resolved_at', 'tickets.closed_at'])
      .where('tickets.customer_id', '=', customerId)
      .where('tickets.state', 'in', ['resolved', 'closed'])
      .where('tickets.merged_into_id', 'is', null)
      .execute();
    return rows.flatMap((row) => {
      const at = row.resolved_at ?? row.closed_at;
      return at === null ? [] : [{ id: row.id, at }];
    });
  }

  activeTicket(tx: TenantTransaction, customerId: string) {
    return this.selectFrom(tx, 'tickets')
      .select(['tickets.id', 'tickets.waiting_on'])
      .where('tickets.customer_id', '=', customerId)
      .where('tickets.state', 'in', ACTIVE_STATES)
      .where('tickets.merged_into_id', 'is', null)
      .orderBy('tickets.updated_at', 'desc')
      .orderBy('tickets.id', 'desc')
      .limit(1)
      .executeTakeFirst();
  }

  /** The newest published `seq` on the customer's conversation stream, 0 when none. */
  async streamSeq(tx: TenantTransaction, customerId: string): Promise<number> {
    const row = await this.selectFrom(tx, 'outbox_events')
      .select(sql<string | null>`max(outbox_events.seq)`.as('seq'))
      .where(sql<boolean>`outbox_events.streams @> ARRAY[${`conversation:${customerId}`}]::text[]`)
      .executeTakeFirst();
    return Number(row?.seq ?? 0);
  }
}
