import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';

import type { UserStatus } from '../platform-kernel/db/tables/identity.js';
import type { TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import type { TicketRow } from '../tickets/tickets.repository.js';
import type { Expression, SqlBool } from 'kysely';

/** Rows and joins for the customer profile (data-model.md "users", "customer_profiles"). */

export interface CustomerRow {
  id: string;
  name: string;
  email: string;
  status: UserStatus;
  phone: string | null;
  company: string | null;
  created_at: Date;
  last_message_at: Date | null;
}

/** Same columns as the tickets module's `TICKET_COLUMNS` (tickets.repository.ts), so rows fit its
 * `TicketRow` shape and `toTicketSummary`/`TicketRefsRepository` (ticket-dto.ts) build summaries
 * without this module duplicating that logic. */
const TICKET_COLUMNS = [
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
  'tickets.reminder_notified_at',
  'tickets.created_at',
  'tickets.updated_at',
] as const;

export class CustomersRepository extends TenantRepository {
  /** A customer's profile row, or `undefined` when the id is not an active customer-kind user. */
  profile(tx: TenantTransaction, userId: string): Promise<CustomerRow | undefined> {
    return this.selectFrom(tx, 'users')
      .innerJoin('customer_profiles', (join) =>
        join
          .onRef('customer_profiles.tenant_id', '=', 'users.tenant_id')
          .onRef('customer_profiles.user_id', '=', 'users.id'),
      )
      .select([
        'users.id',
        'users.name',
        'users.email',
        'users.status',
        'customer_profiles.phone',
        'customer_profiles.company',
        'users.created_at',
        'customer_profiles.last_message_at',
      ])
      .where('users.id', '=', userId)
      .where('users.kind', '=', 'customer')
      .executeTakeFirst();
  }

  async update(tx: TenantTransaction, userId: string, values: { name?: string; phone?: string; company?: string }): Promise<void> {
    if (values.name !== undefined) {
      await this.updateTable(tx, 'users').set({ name: values.name }).where('id', '=', userId).execute();
    }
    if (values.phone !== undefined || values.company !== undefined) {
      await this.updateTable(tx, 'customer_profiles')
        .set({
          ...(values.phone !== undefined ? { phone: values.phone } : {}),
          ...(values.company !== undefined ? { company: values.company } : {}),
        })
        .where('user_id', '=', userId)
        .execute();
    }
  }

  /** Tickets of the customer visible to the caller (policy filter over `tickets.group_id`). */
  async ticketsOf(tx: TenantTransaction, userId: string, access: Expression<SqlBool>): Promise<TicketRow[]> {
    const rows = await this.selectFrom(tx, 'tickets')
      .select(TICKET_COLUMNS)
      .where('tickets.customer_id', '=', userId)
      .where(access)
      .orderBy('tickets.updated_at', 'desc')
      .orderBy('tickets.id', 'desc')
      .execute();
    return rows.map((row) => ({ ...row, number: Number(row.number) }));
  }
}
