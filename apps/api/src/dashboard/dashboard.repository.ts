import { sql, type Expression, type SqlBool } from 'kysely';

import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';

import type { TenantTransaction } from '../platform-kernel/db/unit-of-work.js';

/** The figures of one aggregate over the viewer's accessible tickets (see dashboard.service.ts). */
export interface DashboardFigures {
  open: number;
  ungrouped: number;
  unassigned: number;
  waitingOnCustomer: number;
  waitingOnSupport: number;
  urgent: number;
  slaBreached: number;
  createdToday: number;
  resolvedToday: number;
  /** Seconds; null when no ticket qualifies. */
  avgFirstResponseSeconds: number | null;
  avgResolutionSeconds: number | null;
}

/** States that count as open: everything except `resolved` and `closed` (state-machine.ts). */
const OPEN_STATES = sql`('new', 'open', 'pending_reminder', 'pending_close')`;

export class DashboardRepository extends TenantRepository {
  /** The tenant's IANA timezone (`tenant_settings.timezone`), defaulted by the table. */
  async timezone(tx: TenantTransaction): Promise<string | undefined> {
    const row = await this.selectFrom(tx, 'tenant_settings').select('tenant_settings.timezone').executeTakeFirst();
    return row?.timezone;
  }

  /**
   * One scan of `tickets` (tenant filter AND `access`), every figure a `FILTER` aggregate. The
   * `ticket_sla` join matches `tenant_id`; it is one row per ticket, so it never multiplies rows.
   */
  async figures(
    tx: TenantTransaction,
    access: Expression<SqlBool>,
    window: { startOfToday: Date; since: Date },
  ): Promise<DashboardFigures> {
    const row = await this.selectFrom(tx, 'tickets')
      .leftJoin('ticket_sla', (join) =>
        join.onRef('ticket_sla.tenant_id', '=', 'tickets.tenant_id').onRef('ticket_sla.ticket_id', '=', 'tickets.id'),
      )
      .where(access)
      .select([
        sql<string>`count(*) FILTER (WHERE tickets.state IN ${OPEN_STATES})`.as('open'),
        sql<string>`count(*) FILTER (WHERE tickets.state IN ${OPEN_STATES} AND tickets.group_id IS NULL)`.as('ungrouped'),
        sql<string>`count(*) FILTER (WHERE tickets.state IN ${OPEN_STATES} AND tickets.owner_id IS NULL)`.as('unassigned'),
        sql<string>`count(*) FILTER (WHERE tickets.state IN ${OPEN_STATES} AND tickets.waiting_on = 'customer')`.as(
          'waiting_on_customer',
        ),
        sql<string>`count(*) FILTER (WHERE tickets.state IN ('new', 'open') AND tickets.waiting_on = 'support')`.as(
          'waiting_on_support',
        ),
        sql<string>`count(*) FILTER (WHERE tickets.state IN ${OPEN_STATES} AND tickets.priority = 'urgent')`.as('urgent'),
        sql<string>`count(*) FILTER (WHERE tickets.state <> 'closed' AND ticket_sla.status = 'breached')`.as('sla_breached'),
        sql<string>`count(*) FILTER (WHERE tickets.created_at >= ${window.startOfToday})`.as('created_today'),
        sql<string>`count(*) FILTER (WHERE tickets.resolved_at >= ${window.startOfToday})`.as('resolved_today'),
        sql<number | null>`(avg(extract(epoch FROM tickets.first_agent_reply_at - tickets.created_at))
          FILTER (WHERE tickets.created_at >= ${window.since} AND tickets.first_agent_reply_at IS NOT NULL))::float8`.as(
          'avg_first_response_seconds',
        ),
        sql<number | null>`(avg(extract(epoch FROM tickets.resolved_at - tickets.created_at))
          FILTER (WHERE tickets.resolved_at >= ${window.since}))::float8`.as('avg_resolution_seconds'),
      ])
      .executeTakeFirstOrThrow();

    return {
      open: Number(row.open),
      ungrouped: Number(row.ungrouped),
      unassigned: Number(row.unassigned),
      waitingOnCustomer: Number(row.waiting_on_customer),
      waitingOnSupport: Number(row.waiting_on_support),
      urgent: Number(row.urgent),
      slaBreached: Number(row.sla_breached),
      createdToday: Number(row.created_today),
      resolvedToday: Number(row.resolved_today),
      avgFirstResponseSeconds: row.avg_first_response_seconds,
      avgResolutionSeconds: row.avg_resolution_seconds,
    };
  }
}
