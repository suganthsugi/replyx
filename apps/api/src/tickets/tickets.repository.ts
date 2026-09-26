import { sql, type Expression, type Selectable, type SqlBool, type Updateable } from 'kysely';

import { TenantRepository, type TenantInsert } from '../platform-kernel/db/tenant-repository.js';

import type { Database } from '../platform-kernel/db/database.js';
import type { TicketPriority, TicketState } from '../platform-kernel/db/tables/tickets.js';
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

  /**
   * Other tickets' links pointing at this one (migration 0008 `ticket_links_to_fk`), removed
   * outright before a hard delete: `ON DELETE SET NULL` would null `to_ticket_id` without setting
   * `removed_reason`, and the `ticket_links_tombstone` CHECK only allows that combination for a
   * retention tombstone (`removed_reason = 'retention'`), not a plain hard delete.
   */
  async deleteIncomingLinks(tx: TenantTransaction, id: string): Promise<void> {
    await this.deleteFrom(tx, 'ticket_links').where('ticket_links.to_ticket_id', '=', id).execute();
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

  /**
   * `GET /tickets` (contracts/tickets.yaml, T135): `access` (`PolicyService.ticketAccessFilter`)
   * is always applied; `extra` is the compiled view condition when the caller passed `viewId`.
   * `groupId`/`ownerId` are already resolved by the caller (`null` = Ungrouped/unassigned,
   * `undefined` = not filtering). `after` is the previous page's last row's sort key, keyset-style
   * (`sortExpr`/`tickets.id`, both in `direction`), so a row equal to the cursor's key ties on id.
   */
  async list(tx: TenantTransaction, params: TicketListParams): Promise<TicketRow[]> {
    let query = this.selectFrom(tx, 'tickets').select(TICKET_COLUMNS).where(params.access);
    if (params.extra !== undefined) query = query.where(params.extra);
    if (params.state !== undefined) query = query.where('tickets.state', 'in', params.state as TicketState[]);
    if (params.priority !== undefined) query = query.where('tickets.priority', 'in', params.priority as TicketPriority[]);
    if (params.groupId !== undefined) {
      query = params.groupId === null ? query.where('tickets.group_id', 'is', null) : query.where('tickets.group_id', '=', params.groupId);
    }
    if (params.ownerId !== undefined) {
      query = params.ownerId === null ? query.where('tickets.owner_id', 'is', null) : query.where('tickets.owner_id', '=', params.ownerId);
    }
    if (params.customerId !== undefined) query = query.where('tickets.customer_id', '=', params.customerId);
    if (params.after !== undefined) {
      const op = params.direction === 'asc' ? sql`>` : sql`<`;
      const { sortExpr } = params;
      const value = sql.val(params.after.value);
      query = query.where(sql<SqlBool>`(${sortExpr} ${op} ${value} OR (${sortExpr} = ${value} AND tickets.id ${op} ${sql.val(params.after.id)}))`);
    }
    const rows = await query
      .orderBy(params.sortExpr, params.direction)
      .orderBy('tickets.id', params.direction)
      .limit(params.limit + 1)
      .execute();
    return rows.map(toRow);
  }
}

export interface TicketListParams {
  /** `PolicyService.ticketAccessFilter(ctx, 'view')`: always applied. */
  access: Expression<SqlBool>;
  /** The compiled view condition (`ViewCompiler.filterFor`), when listing by `viewId`. */
  extra?: Expression<SqlBool>;
  state?: readonly TicketState[];
  priority?: readonly TicketPriority[];
  /** `null` is Ungrouped; `undefined` is "not filtering". */
  groupId?: string | null;
  /** `null` is unassigned; `undefined` is "not filtering". Resolve `me` before calling. */
  ownerId?: string | null;
  customerId?: string;
  sortExpr: Expression<Date | number>;
  direction: 'asc' | 'desc';
  after?: { value: Date | number; id: string };
  limit: number;
}
