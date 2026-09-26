import { sql, type Expression, type Selectable, type SqlBool, type Updateable } from 'kysely';

import { TenantRepository, type TenantInsert } from '../platform-kernel/db/tenant-repository.js';

import type { Database } from '../platform-kernel/db/database.js';
import type { TicketState } from '../platform-kernel/db/tables/tickets.js';
import type { TenantTransaction } from '../platform-kernel/db/unit-of-work.js';

/**
 * Ticket rows (data-model.md "tickets"). Owned by the tickets module: other modules read and
 * change tickets through its services. Numbers are bigint in the database and plain numbers here.
 */

export type TicketRow = Omit<Selectable<Database['tickets']>, 'tenant_id' | 'number'> & { number: number };

export type TicketPatch = Omit<Updateable<Database['tickets']>, 'id' | 'tenant_id' | 'number' | 'created_at'>;

/** States in which a ticket is still being worked (data-model "Conversation routing" step 2). */
export const ACTIVE_STATES: readonly TicketState[] = ['new', 'open', 'pending_reminder', 'pending_close'];

/** Every column but `tenant_id`, so rows never carry the tenant into DTOs. */
export const TICKET_COLUMNS = [
  'tickets.id',
  'tickets.number',
  'tickets.title',
  'tickets.customer_id',
  'tickets.group_id',
  'tickets.owner_id',
  'tickets.priority',
  'tickets.state',
  'tickets.pending_until',
  'tickets.auto_close_at',
  'tickets.waiting_on',
  'tickets.origin',
  'tickets.merged_into_id',
  'tickets.resolved_at',
  'tickets.closed_at',
  'tickets.last_customer_message_at',
  'tickets.last_agent_reply_at',
  'tickets.first_agent_reply_at',
  'tickets.created_at',
  'tickets.updated_at',
] as const;

type RawTicket = Omit<TicketRow, 'number'> & { number: string };

function toRow(row: RawTicket): TicketRow {
  return { ...row, number: Number(row.number) };
}

export class TicketsRepository extends TenantRepository {
  async insert(tx: TenantTransaction, values: TenantInsert<'tickets'>): Promise<TicketRow> {
    const row = await this.insertInto(tx, 'tickets', values).returning(TICKET_COLUMNS).executeTakeFirstOrThrow();
    return toRow(row);
  }

  /** `access` is a policy filter over `tickets.group_id`; without it the read is unfiltered. */
  async find(tx: TenantTransaction, id: string, access?: Expression<SqlBool>): Promise<TicketRow | undefined> {
    let query = this.selectFrom(tx, 'tickets').select(TICKET_COLUMNS).where('tickets.id', '=', id);
    if (access !== undefined) query = query.where(access);
    const row = await query.executeTakeFirst();
    return row === undefined ? undefined : toRow(row);
  }

  /** Locks the row for the rest of the transaction (state changes, replies). */
  async lock(tx: TenantTransaction, id: string): Promise<TicketRow | undefined> {
    const row = await this.selectFrom(tx, 'tickets').select(TICKET_COLUMNS).where('tickets.id', '=', id).forUpdate().executeTakeFirst();
    return row === undefined ? undefined : toRow(row);
  }

  /** The group of a ticket: `null` = Ungrouped, `undefined` = no such ticket. */
  async groupOf(tx: TenantTransaction, id: string): Promise<string | null | undefined> {
    const row = await this.selectFrom(tx, 'tickets').select('tickets.group_id').where('tickets.id', '=', id).executeTakeFirst();
    return row?.group_id;
  }

  async update(tx: TenantTransaction, id: string, patch: TicketPatch): Promise<TicketRow> {
    const row = await this.updateTable(tx, 'tickets')
      .set(patch)
      .where('tickets.id', '=', id)
      .returning(TICKET_COLUMNS)
      .executeTakeFirstOrThrow();
    return toRow(row);
  }

  /** Hard delete (spec Assumptions): cascades to messages, links, history, attachments and tags. */
  async delete(tx: TenantTransaction, id: string): Promise<void> {
    await this.deleteFrom(tx, 'tickets').where('tickets.id', '=', id).execute();
  }

  /** The customer's most recently updated active, unmerged ticket, locked. */
  async lockActiveForCustomer(tx: TenantTransaction, customerId: string): Promise<TicketRow | undefined> {
    const row = await this.selectFrom(tx, 'tickets')
      .select(TICKET_COLUMNS)
      .where('tickets.customer_id', '=', customerId)
      .where('tickets.state', 'in', ACTIVE_STATES)
      .where('tickets.merged_into_id', 'is', null)
      .orderBy('tickets.updated_at', 'desc')
      .orderBy('tickets.id', 'desc')
      .limit(1)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? undefined : toRow(row);
  }

  /** The customer's most recently created ticket, locked. Merged tickets never receive messages. */
  async lockLatestForCustomer(tx: TenantTransaction, customerId: string): Promise<TicketRow | undefined> {
    const row = await this.selectFrom(tx, 'tickets')
      .select(TICKET_COLUMNS)
      .where('tickets.customer_id', '=', customerId)
      .where('tickets.merged_into_id', 'is', null)
      .orderBy('tickets.created_at', 'desc')
      .orderBy('tickets.id', 'desc')
      .limit(1)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? undefined : toRow(row);
  }

  /** Every ticket of a customer, oldest first (the conversation thread spans all of them). */
  async listForCustomer(tx: TenantTransaction, customerId: string): Promise<TicketRow[]> {
    const rows = await this.selectFrom(tx, 'tickets')
      .select(TICKET_COLUMNS)
      .where('tickets.customer_id', '=', customerId)
      .orderBy('tickets.created_at')
      .orderBy('tickets.id')
      .execute();
    return rows.map(toRow);
  }

  async openCountsByGroup(tx: TenantTransaction, groupIds: readonly string[]): Promise<Map<string, number>> {
    if (groupIds.length === 0) return new Map();
    const rows = await this.selectFrom(tx, 'tickets')
      .select(['tickets.group_id', sql<string>`count(*)`.as('count')])
      .where('tickets.group_id', 'in', groupIds)
      .where('tickets.state', '<>', 'closed')
      .groupBy('tickets.group_id')
      .execute();
    return new Map(rows.map((row) => [row.group_id as string, Number(row.count)]));
  }

  async openCountsByOwner(tx: TenantTransaction, ownerIds: readonly string[]): Promise<Map<string, number>> {
    if (ownerIds.length === 0) return new Map();
    const rows = await this.selectFrom(tx, 'tickets')
      .select(['tickets.owner_id', sql<string>`count(*)`.as('count')])
      .where('tickets.owner_id', 'in', ownerIds)
      .where('tickets.state', '<>', 'closed')
      .groupBy('tickets.owner_id')
      .execute();
    return new Map(rows.map((row) => [row.owner_id as string, Number(row.count)]));
  }

  async groupHasTickets(tx: TenantTransaction, groupId: string): Promise<boolean> {
    const row = await this.selectFrom(tx, 'tickets').select('tickets.id').where('tickets.group_id', '=', groupId).limit(1).executeTakeFirst();
    return row !== undefined;
  }

  /** A customer with tickets has history (FR-009: deactivate or erase instead of deleting). */
  async customerHasTickets(tx: TenantTransaction, userId: string): Promise<boolean> {
    const row = await this.selectFrom(tx, 'tickets').select('tickets.id').where('tickets.customer_id', '=', userId).limit(1).executeTakeFirst();
    return row !== undefined;
  }
}
