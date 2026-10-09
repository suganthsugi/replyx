import { sql } from 'kysely';

import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';

import type { BusinessHoursRowLike } from './business-hours.mapper.js';
import type { ExistingSla, SlaTimes } from './sla-timers.js';
import type { SlaStatus } from '../platform-kernel/db/tables/sla.js';
import type { TicketOrigin, TicketPriority, TicketState } from '../platform-kernel/db/tables/tickets.js';
import type { TenantTransaction } from '../platform-kernel/db/unit-of-work.js';

/** Data access for the SLA consumer (business hours, policies, `ticket_sla`). Tenant-scoped. */

export interface SlaPolicyRow {
  id: string;
  position: number;
  conditions: unknown;
  businessHoursId: string;
  firstResponseMinutes: number | null;
  nextResponseMinutes: number | null;
  resolutionMinutes: number | null;
  warningPercent: number;
}

export interface SlaTicketFacts {
  id: string;
  createdAt: Date;
  state: TicketState;
  origin: TicketOrigin;
  priority: TicketPriority;
  groupId: string | null;
  firstAgentReplyAt: Date | null;
  lastAgentReplyAt: Date | null;
}

export interface StoredSla extends ExistingSla {
  status: SlaStatus;
}

export class SlaRepository extends TenantRepository {
  async policies(tx: TenantTransaction): Promise<SlaPolicyRow[]> {
    const rows = await this.selectFrom(tx, 'sla_policies')
      .select([
        'sla_policies.id',
        'sla_policies.position',
        'sla_policies.conditions',
        'sla_policies.business_hours_id',
        'sla_policies.first_response_minutes',
        'sla_policies.next_response_minutes',
        'sla_policies.resolution_minutes',
        'sla_policies.warning_percent',
      ])
      .orderBy('sla_policies.position')
      .orderBy('sla_policies.id')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      position: row.position,
      conditions: row.conditions,
      businessHoursId: row.business_hours_id,
      firstResponseMinutes: row.first_response_minutes,
      nextResponseMinutes: row.next_response_minutes,
      resolutionMinutes: row.resolution_minutes,
      warningPercent: row.warning_percent,
    }));
  }

  /** Holidays are cast to `YYYY-MM-DD` text in SQL so a timezone can't shift the day. */
  async businessHours(tx: TenantTransaction, id: string): Promise<BusinessHoursRowLike | undefined> {
    const row = await this.selectFrom(tx, 'business_hours')
      .select([
        'business_hours.timezone',
        'business_hours.intervals',
        sql<string[]>`ARRAY(SELECT to_char(h, 'YYYY-MM-DD') FROM unnest(business_hours.holidays) AS h ORDER BY h)`.as('holiday_dates'),
      ])
      .where('business_hours.id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : { timezone: row.timezone, intervals: row.intervals, holidays: row.holiday_dates };
  }

  async ticket(tx: TenantTransaction, ticketId: string): Promise<SlaTicketFacts | undefined> {
    const row = await this.selectFrom(tx, 'tickets')
      .select([
        'tickets.id',
        'tickets.created_at',
        'tickets.state',
        'tickets.origin',
        'tickets.priority',
        'tickets.group_id',
        'tickets.first_agent_reply_at',
        'tickets.last_agent_reply_at',
      ])
      .where('tickets.id', '=', ticketId)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return {
      id: row.id,
      createdAt: row.created_at,
      state: row.state,
      origin: row.origin,
      priority: row.priority,
      groupId: row.group_id,
      firstAgentReplyAt: row.first_agent_reply_at,
      lastAgentReplyAt: row.last_agent_reply_at,
    };
  }

  /** True for the assistant's hand-off notice (`metadata.handoff`), which is not a reply (FR-029). */
  async isHandoffMessage(tx: TenantTransaction, messageId: string): Promise<boolean> {
    const row = await this.selectFrom(tx, 'ticket_messages')
      .select('ticket_messages.metadata')
      .where('ticket_messages.id', '=', messageId)
      .executeTakeFirst();
    return row?.metadata?.handoff === true;
  }

  /** The earliest public customer message after `after` (any, when null): the unanswered one. */
  async unansweredSince(tx: TenantTransaction, ticketId: string, after: Date | null): Promise<Date | null> {
    let query = this.selectFrom(tx, 'ticket_messages')
      .select((eb) => eb.fn.min('ticket_messages.created_at').as('since'))
      .where('ticket_messages.ticket_id', '=', ticketId)
      .where('ticket_messages.author_kind', '=', 'customer')
      .where('ticket_messages.visibility', '=', 'public');
    if (after !== null) query = query.where('ticket_messages.created_at', '>', after);
    const row = await query.executeTakeFirst();
    return row?.since ?? null;
  }

  /** The stored row, locked for the rest of the transaction (serializes with the sweeper). */
  async stored(tx: TenantTransaction, ticketId: string): Promise<StoredSla | undefined> {
    const row = await this.selectFrom(tx, 'ticket_sla').selectAll('ticket_sla').where('ticket_sla.ticket_id', '=', ticketId).forUpdate().executeTakeFirst();
    if (row === undefined) return undefined;
    return {
      policyId: row.policy_id,
      status: row.status,
      pausedSince: row.paused_since,
      firstResponse: { dueAt: row.first_response_due_at, warnAt: row.first_response_warn_at },
      nextResponse: { dueAt: row.next_response_due_at, warnAt: row.next_response_warn_at },
      resolution: { dueAt: row.resolution_due_at, warnAt: row.resolution_warn_at },
    };
  }

  async insert(tx: TenantTransaction, ticketId: string, policyId: string, times: SlaTimes, status: SlaStatus): Promise<void> {
    await this.insertInto(tx, 'ticket_sla', { ticket_id: ticketId, policy_id: policyId, ...columnsOf(times), status }).execute();
  }

  async update(tx: TenantTransaction, ticketId: string, policyId: string, times: SlaTimes, status: SlaStatus): Promise<void> {
    await this.updateTable(tx, 'ticket_sla')
      .set({ policy_id: policyId, ...columnsOf(times), status })
      .where('ticket_sla.ticket_id', '=', ticketId)
      .execute();
  }

  async remove(tx: TenantTransaction, ticketId: string): Promise<void> {
    await this.deleteFrom(tx, 'ticket_sla').where('ticket_sla.ticket_id', '=', ticketId).execute();
  }

  /** Serializes recomputes of one ticket until the transaction ends (also covers the first insert). */
  async lockTicket(tx: TenantTransaction, ticketId: string): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sla:${this.ctx.tenantId}:${ticketId}`}, 0))`.execute(tx);
  }
}

function columnsOf(times: SlaTimes) {
  return {
    first_response_due_at: times.firstResponse.dueAt,
    first_response_warn_at: times.firstResponse.warnAt,
    next_response_due_at: times.nextResponse.dueAt,
    next_response_warn_at: times.nextResponse.warnAt,
    resolution_due_at: times.resolution.dueAt,
    resolution_warn_at: times.resolution.warnAt,
    paused_since: times.pausedSince,
  };
}
