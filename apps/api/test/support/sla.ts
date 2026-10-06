import { Clock } from '../../src/platform-kernel/clock.js';
import { TenantContext } from '../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../src/platform-kernel/db/unit-of-work.js';
import { OutboxService } from '../../src/platform-kernel/outbox/outbox.service.js';
import { SlaRecomputeService, type RecomputeOutcome } from '../../src/sla/sla-recompute.service.js';
import { SlaConsumer } from '../../src/sla/sla.consumer.js';

import { service } from './app.js';
import { latestEventId } from './jobs.js';

import type { BusinessHoursIntervals, SlaEventKind, SlaStatus, SlaTarget } from '../../src/platform-kernel/db/tables/sla.js';

/**
 * SLA fixtures (T226). Rows are inserted directly (jsonb columns as JSON strings, the pg driver does
 * not serialise objects), so tests do not depend on the policy and business-hours endpoints. The SLA
 * consumer and recompute service are worker-only, so they are built by hand over the app's services
 * (and its TestClock) instead of starting the worker.
 */

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export const ALL_WEEK: BusinessHoursIntervals = Object.fromEntries(DAYS.map((day) => [day, [{ from: '00:00', to: '24:00' }]]));

export const WEEKDAYS_9_TO_17: BusinessHoursIntervals = Object.fromEntries(
  DAYS.slice(0, 5).map((day) => [day, [{ from: '09:00', to: '17:00' }]]),
);

export interface TestBusinessHours {
  id: string;
}

export interface TestSlaPolicy {
  id: string;
}

export interface SlaRow {
  status: SlaStatus;
  policyId: string;
  pausedSince: Date | null;
  firstResponseDueAt: Date | null;
  firstResponseWarnAt: Date | null;
  nextResponseDueAt: Date | null;
  nextResponseWarnAt: Date | null;
  resolutionDueAt: Date | null;
  resolutionWarnAt: Date | null;
}

export interface SlaEventRow {
  target: SlaTarget;
  kind: SlaEventKind;
  occurredAt: Date;
}

class SlaFixtureRepository extends TenantRepository {
  async businessHours(tx: TenantTransaction, values: { name: string; timezone: string; intervals: BusinessHoursIntervals; holidays: string[] }): Promise<string> {
    const row = await this.insertInto(tx, 'business_hours', {
      name: values.name,
      timezone: values.timezone,
      intervals: JSON.stringify(values.intervals),
      holidays: values.holidays,
    })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async policy(
    tx: TenantTransaction,
    values: {
      name: string;
      position: number;
      conditions: Record<string, unknown>;
      businessHoursId: string;
      firstResponseMinutes: number | null;
      nextResponseMinutes: number | null;
      resolutionMinutes: number | null;
      warningPercent: number;
    },
  ): Promise<string> {
    const row = await this.insertInto(tx, 'sla_policies', {
      name: values.name,
      position: values.position,
      conditions: JSON.stringify(values.conditions),
      business_hours_id: values.businessHoursId,
      first_response_minutes: values.firstResponseMinutes,
      next_response_minutes: values.nextResponseMinutes,
      resolution_minutes: values.resolutionMinutes,
      warning_percent: values.warningPercent,
    })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  slaRow(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'ticket_sla').selectAll('ticket_sla').where('ticket_sla.ticket_id', '=', ticketId).executeTakeFirst();
  }

  events(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'sla_events')
      .select(['sla_events.target', 'sla_events.kind', 'sla_events.occurred_at'])
      .where('sla_events.ticket_id', '=', ticketId)
      .orderBy('sla_events.id')
      .execute();
  }

  ticket(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'tickets').select(['tickets.created_at', 'tickets.group_id']).where('tickets.id', '=', ticketId).executeTakeFirstOrThrow();
  }
}

export async function inSlaTenant<T>(tenant: { id: string }, fn: (tx: TenantTransaction, repo: SlaFixtureRepository) => Promise<T>): Promise<T> {
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'sla-test' });
  return (await service(UnitOfWork)).withTenant(ctx, (tx) => fn(tx, new SlaFixtureRepository(ctx)));
}

const suffix = () => Math.random().toString(36).slice(2, 8);

/** A calendar, open all week 00:00-24:00 in UTC unless told otherwise. */
export function createBusinessHours(
  tenant: { id: string },
  options: { name?: string; timezone?: string; intervals?: BusinessHoursIntervals; holidays?: string[] } = {},
): Promise<TestBusinessHours> {
  return inSlaTenant(tenant, async (tx, repo) => ({
    id: await repo.businessHours(tx, {
      name: options.name ?? `Hours ${suffix()}`,
      timezone: options.timezone ?? 'UTC',
      intervals: options.intervals ?? ALL_WEEK,
      holidays: options.holidays ?? [],
    }),
  }));
}

/** A policy on `businessHours`; conditions default to `{}` (matches every ticket). */
export function createSlaPolicy(
  tenant: { id: string },
  options: {
    businessHours: TestBusinessHours;
    name?: string;
    position?: number;
    conditions?: Record<string, unknown>;
    firstResponseMinutes?: number | null;
    nextResponseMinutes?: number | null;
    resolutionMinutes?: number | null;
    warningPercent?: number;
  },
): Promise<TestSlaPolicy> {
  return inSlaTenant(tenant, async (tx, repo) => ({
    id: await repo.policy(tx, {
      name: options.name ?? `Policy ${suffix()}`,
      position: options.position ?? 0,
      conditions: options.conditions ?? {},
      businessHoursId: options.businessHours.id,
      firstResponseMinutes: options.firstResponseMinutes ?? null,
      nextResponseMinutes: options.nextResponseMinutes ?? null,
      resolutionMinutes: options.resolutionMinutes ?? null,
      warningPercent: options.warningPercent ?? 80,
    }),
  }));
}

export async function slaRow(tenant: { id: string }, ticketId: string): Promise<SlaRow | undefined> {
  const row = await inSlaTenant(tenant, (tx, repo) => repo.slaRow(tx, ticketId));
  if (row === undefined) return undefined;
  return {
    status: row.status,
    policyId: row.policy_id,
    pausedSince: row.paused_since,
    firstResponseDueAt: row.first_response_due_at,
    firstResponseWarnAt: row.first_response_warn_at,
    nextResponseDueAt: row.next_response_due_at,
    nextResponseWarnAt: row.next_response_warn_at,
    resolutionDueAt: row.resolution_due_at,
    resolutionWarnAt: row.resolution_warn_at,
  };
}

export async function slaEvents(tenant: { id: string }, ticketId: string): Promise<SlaEventRow[]> {
  const rows = await inSlaTenant(tenant, (tx, repo) => repo.events(tx, ticketId));
  return rows.map((row) => ({ target: row.target, kind: row.kind, occurredAt: row.occurred_at }));
}

export async function ticketCreatedAt(tenant: { id: string }, ticketId: string): Promise<Date> {
  return (await inSlaTenant(tenant, (tx, repo) => repo.ticket(tx, ticketId))).created_at;
}

/** Recomputes one ticket directly, with the app's TestClock, the way the consumer does after an event. */
export async function recomputeSla(tenant: { id: string }, ticketId: string, options: { reset?: boolean } = {}): Promise<RecomputeOutcome> {
  const recompute = new SlaRecomputeService(await service(OutboxService), await service(Clock));
  return inSlaTenant(tenant, (tx) => recompute.recompute(tx, ticketId, options));
}

/** Runs the SLA consumer over the tenant's latest event of `type` (a real outbox row), as the worker would. */
export async function deliverToSla(tenant: { id: string }, type: string): Promise<string> {
  const consumer = new SlaConsumer(await service(UnitOfWork), new SlaRecomputeService(await service(OutboxService), await service(Clock)));
  const eventId = await latestEventId(tenant.id, type);
  return consumer.process({ tenantId: tenant.id, eventId }, 'sla-test-job');
}
