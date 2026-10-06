import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';

import { PolicyService } from '../authorization/policy.service.js';
import { Clock } from '../platform-kernel/clock.js';
import { UnitOfWork } from '../platform-kernel/db/unit-of-work.js';

import { DashboardRepository } from './dashboard.repository.js';

import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * The dashboard (FR-086, contracts/operations.yaml `/dashboard`): live operational numbers, every
 * figure over the tickets the caller may view only (`PolicyService.ticketAccessFilter(ctx,
 * 'view')`, the same filter as ticket lists and view counts), so a group the caller cannot see adds
 * nothing to any number. Live = computed per request, not cached; the web refetches on the
 * existing tickets/views stream hints. All figures are one `FILTER` aggregate in one read-only
 * unit of work (repository: dashboard.repository.ts).
 *
 * Definitions (conservative, from the state machine and the default views of FR-073):
 * - open: state in new, open, pending_reminder, pending_close (not resolved, not closed); the
 *   "All Open" view.
 * - ungrouped / unassigned: open tickets with no group / no owner. Unassigned therefore includes
 *   ungrouped tickets that have no owner (the two answer different questions).
 * - waitingOnCustomer: open tickets with `waiting_on = 'customer'` (set by the last staff reply).
 * - waitingOnSupport: tickets in new or open with `waiting_on = 'support'`; the "Waiting on Support"
 *   view. A pending ticket is waiting on the customer or on a date, not on support.
 * - urgent: open tickets with priority urgent.
 * - slaBreached: tickets not closed whose `ticket_sla.status = 'breached'` (the "Escalated"
 *   view's not-closed rule; a resolved ticket that breached still shows until it closes).
 * - today: tickets created since local midnight in the tenant's timezone (`created_at`), and
 *   tickets resolved since then (`resolved_at`; a ticket reopened later has no `resolved_at`
 *   and drops out). "Now" is the injected Clock.
 * - averages, window P7D (the last 7 x 24 h): first response = mean of `first_agent_reply_at -
 *   created_at` over tickets created in the window that have a reply; resolution = mean of
 *   `resolved_at - created_at` over tickets resolved in the window. Minutes, rounded to 2
 *   decimals; null when no ticket qualifies.
 * - satisfaction: a placeholder `{ average: null, responses: 0 }`; filled in US16 when ratings
 *   exist. Never a fake value.
 *
 * The access filter is computed before the unit of work opens (it takes its own short read-only
 * transaction), so this never holds two pool connections at once.
 */

export const AVERAGE_WINDOW_DAYS = 7;

export interface DashboardDto {
  counts: {
    open: number;
    ungrouped: number;
    unassigned: number;
    waitingOnCustomer: number;
    waitingOnSupport: number;
    urgent: number;
    slaBreached: number;
  };
  today: { created: number; resolved: number };
  averages: { firstResponseMinutes: number | null; resolutionMinutes: number | null; window: string };
  satisfaction: { average: number | null; responses: number };
}

const DAY_MS = 86_400_000;

function toMinutes(seconds: number | null): number | null {
  return seconds === null ? null : Math.round((seconds / 60) * 100) / 100;
}

/** Local midnight of `now` in `timezone`; an unusable zone falls back to UTC. */
export function startOfLocalDay(now: Date, timezone: string | undefined): Date {
  const zoned = DateTime.fromJSDate(now, { zone: timezone ?? 'UTC' });
  return (zoned.isValid ? zoned : DateTime.fromJSDate(now, { zone: 'UTC' })).startOf('day').toJSDate();
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly policy: PolicyService,
    private readonly clock: Clock,
  ) {}

  async get(ctx: TenantContext): Promise<DashboardDto> {
    const access = await this.policy.ticketAccessFilter(ctx, 'view');
    const now = this.clock.now();
    const since = new Date(now.getTime() - AVERAGE_WINDOW_DAYS * DAY_MS);
    const repo = new DashboardRepository(ctx);

    const figures = await this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const startOfToday = startOfLocalDay(now, await repo.timezone(tx));
      return repo.figures(tx, access, { startOfToday, since });
    });

    return {
      counts: {
        open: figures.open,
        ungrouped: figures.ungrouped,
        unassigned: figures.unassigned,
        waitingOnCustomer: figures.waitingOnCustomer,
        waitingOnSupport: figures.waitingOnSupport,
        urgent: figures.urgent,
        slaBreached: figures.slaBreached,
      },
      today: { created: figures.createdToday, resolved: figures.resolvedToday },
      averages: {
        firstResponseMinutes: toMinutes(figures.avgFirstResponseSeconds),
        resolutionMinutes: toMinutes(figures.avgResolutionSeconds),
        window: `P${AVERAGE_WINDOW_DAYS}D`,
      },
      satisfaction: { average: null, responses: 0 },
    };
  }
}
