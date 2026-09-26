import { sql, type Selectable } from 'kysely';

import { TenantRepository, type TenantInsert } from '../platform-kernel/db/tenant-repository.js';

import type { Database } from '../platform-kernel/db/database.js';
import type { TenantTransaction } from '../platform-kernel/db/unit-of-work.js';

/**
 * Ticket messages and the attachments sent with them (data-model.md "ticket_messages",
 * "attachments"). Messages are immutable: the only updates are receipts and moves.
 */

export type MessageRow = Omit<Selectable<Database['ticket_messages']>, 'tenant_id'>;

export type AttachmentRow = Omit<Selectable<Database['attachments']>, 'tenant_id' | 'size_bytes' | 'storage_key'> & {
  size_bytes: number;
};

export const MESSAGE_COLUMNS = [
  'ticket_messages.id',
  'ticket_messages.ticket_id',
  'ticket_messages.author_id',
  'ticket_messages.author_kind',
  'ticket_messages.visibility',
  'ticket_messages.body',
  'ticket_messages.client_message_id',
  'ticket_messages.mentions',
  'ticket_messages.moved_from_ticket_id',
  'ticket_messages.delivered_at',
  'ticket_messages.read_at',
  'ticket_messages.created_at',
  'ticket_messages.updated_at',
] as const;

const ATTACHMENT_COLUMNS = [
  'attachments.id',
  'attachments.message_id',
  'attachments.uploaded_by',
  'attachments.file_name',
  'attachments.content_type',
  'attachments.size_bytes',
  'attachments.scan_status',
  'attachments.scanned_at',
  'attachments.created_at',
  'attachments.updated_at',
] as const;

export interface AuthorRef {
  id: string;
  name: string;
}

export class MessagesRepository extends TenantRepository {
  insert(tx: TenantTransaction, values: TenantInsert<'ticket_messages'>): Promise<MessageRow> {
    return this.insertInto(tx, 'ticket_messages', values).returning(MESSAGE_COLUMNS).executeTakeFirstOrThrow();
  }

  /** The message an author already sent with this idempotency key, if any (research D10). */
  findByClientMessageId(tx: TenantTransaction, authorId: string, clientMessageId: string): Promise<MessageRow | undefined> {
    return this.selectFrom(tx, 'ticket_messages')
      .select(MESSAGE_COLUMNS)
      .where('ticket_messages.author_id', '=', authorId)
      .where('ticket_messages.client_message_id', '=', clientMessageId)
      .executeTakeFirst();
  }

  find(tx: TenantTransaction, id: string): Promise<MessageRow | undefined> {
    return this.selectFrom(tx, 'ticket_messages').select(MESSAGE_COLUMNS).where('ticket_messages.id', '=', id).executeTakeFirst();
  }

  /**
   * Moves a message to another ticket (FR-042), recording the ticket it was on just before this
   * move. `moved_from_ticket_id` is set from the row's own (pre-update) `ticket_id`: SQL evaluates
   * every `SET` expression against the original row, so this is safe even for a message that was
   * already moved once before.
   */
  move(tx: TenantTransaction, id: string, targetTicketId: string): Promise<MessageRow> {
    return this.updateTable(tx, 'ticket_messages')
      .set({ ticket_id: targetTicketId, moved_from_ticket_id: sql`ticket_messages.ticket_id` })
      .where('ticket_messages.id', '=', id)
      .returning(MESSAGE_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  /** A ticket's timeline page, oldest first, after `(createdAt, id)`. Staff only: includes notes. */
  listForTicket(
    tx: TenantTransaction,
    ticketId: string,
    limit: number,
    after?: { createdAt: Date; id: string },
  ): Promise<MessageRow[]> {
    let query = this.selectFrom(tx, 'ticket_messages').select(MESSAGE_COLUMNS).where('ticket_messages.ticket_id', '=', ticketId);
    if (after !== undefined) {
      query = query.where(sql<boolean>`(ticket_messages.created_at, ticket_messages.id) > (${after.createdAt}, ${after.id}::uuid)`);
    }
    return query.orderBy('ticket_messages.created_at').orderBy('ticket_messages.id').limit(limit).execute();
  }

  /** Customer messages on a ticket that have no receipt of the given kind yet. */
  async markCustomerMessages(tx: TenantTransaction, ticketId: string, receipt: 'delivered_at' | 'read_at', at: Date): Promise<string[]> {
    let query = this.updateTable(tx, 'ticket_messages')
      .where('ticket_messages.ticket_id', '=', ticketId)
      .where('ticket_messages.author_kind', '=', 'customer')
      .where(`ticket_messages.${receipt}`, 'is', null);
    // Reading implies delivery.
    query = receipt === 'read_at' ? query.set({ read_at: at, delivered_at: sql`COALESCE(delivered_at, ${at})` }) : query.set({ delivered_at: at });
    const rows = await query.returning('ticket_messages.id').execute();
    return rows.map((row) => row.id);
  }

  /**
   * Support's public replies to a customer, up to and including `upTo`, that the customer has not
   * read yet; marks them read. Returns the ids with their tickets.
   */
  async markSupportRepliesRead(tx: TenantTransaction, customerId: string, upToId: string, at: Date): Promise<{ id: string; ticket_id: string }[]> {
    // Compared with the stored row, so timestamp precision can't drop the last message.
    const upTo = sql<boolean>`(ticket_messages.created_at, ticket_messages.id) <= (
      SELECT upto.created_at, upto.id FROM ticket_messages upto
      WHERE upto.tenant_id = ${this.ctx.tenantId} AND upto.id = ${upToId}
    )`;
    return this.updateTable(tx, 'ticket_messages')
      .set({ read_at: at, delivered_at: sql`COALESCE(delivered_at, ${at})` })
      .where('ticket_messages.visibility', '=', 'public')
      .where('ticket_messages.author_kind', 'in', ['staff', 'system', 'automation'])
      .where('ticket_messages.read_at', 'is', null)
      .where(upTo)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('tickets')
            .select(sql`1`.as('one'))
            .whereRef('tickets.tenant_id', '=', 'ticket_messages.tenant_id')
            .whereRef('tickets.id', '=', 'ticket_messages.ticket_id')
            .where('tickets.customer_id', '=', customerId),
        ),
      )
      .returning(['ticket_messages.id', 'ticket_messages.ticket_id'])
      .execute();
  }

  async authors(tx: TenantTransaction, ids: readonly (string | null)[]): Promise<Map<string, AuthorRef>> {
    const unique = [...new Set(ids.filter((id): id is string => id !== null))];
    if (unique.length === 0) return new Map();
    const rows = await this.selectFrom(tx, 'users').select(['users.id', 'users.name']).where('users.id', 'in', unique).execute();
    return new Map(rows.map((row) => [row.id, row]));
  }

  async attachmentsFor(tx: TenantTransaction, messageIds: readonly string[]): Promise<Map<string, AttachmentRow[]>> {
    const result = new Map<string, AttachmentRow[]>();
    if (messageIds.length === 0) return result;
    const rows = await this.selectFrom(tx, 'attachments')
      .select(ATTACHMENT_COLUMNS)
      .where('attachments.message_id', 'in', messageIds)
      .orderBy('attachments.created_at')
      .orderBy('attachments.id')
      .execute();
    for (const row of rows) {
      const list = result.get(row.message_id as string) ?? [];
      list.push({ ...row, size_bytes: Number(row.size_bytes) });
      result.set(row.message_id as string, list);
    }
    return result;
  }

  /**
   * Binds the uploader's unsent attachments to a message. Returns how many were bound; fewer
   * than asked means some ids are unknown, someone else's, already sent or expired.
   */
  async bindAttachments(
    tx: TenantTransaction,
    messageId: string,
    uploaderId: string,
    attachmentIds: readonly string[],
    notBefore: Date,
  ): Promise<number> {
    if (attachmentIds.length === 0) return 0;
    const rows = await this.updateTable(tx, 'attachments')
      .set({ message_id: messageId })
      .where('attachments.id', 'in', attachmentIds)
      .where('attachments.uploaded_by', '=', uploaderId)
      .where('attachments.message_id', 'is', null)
      .where('attachments.scan_status', '<>', 'blocked')
      .where('attachments.created_at', '>=', notBefore)
      .returning('attachments.id')
      .execute();
    return rows.length;
  }
}
