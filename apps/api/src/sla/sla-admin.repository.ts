import { sql } from 'kysely';

import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';

import type { BusinessHoursIntervals } from '../platform-kernel/db/tables/sla.js';
import type { TenantTransaction } from '../platform-kernel/db/unit-of-work.js';

/** Data access for the business-hours and SLA-policy admin endpoints (T224). Tenant-scoped. */

export interface BusinessHoursRecord {
  id: string;
  name: string;
  timezone: string;
  intervals: BusinessHoursIntervals;
  /** `YYYY-MM-DD`, sorted. */
  holidays: string[];
}

export interface BusinessHoursValues {
  name: string;
  timezone: string;
  intervals: BusinessHoursIntervals;
  holidays: string[];
}

export interface SlaPolicyRecord {
  id: string;
  name: string;
  position: number;
  conditions: unknown;
  businessHoursId: string;
  firstResponseMinutes: number | null;
  nextResponseMinutes: number | null;
  resolutionMinutes: number | null;
  warningPercent: number;
}

export interface SlaPolicyValues {
  name: string;
  conditions: unknown;
  businessHoursId: string;
  firstResponseMinutes: number | null;
  nextResponseMinutes: number | null;
  resolutionMinutes: number | null;
  warningPercent: number;
}

/** Holidays are cast to `YYYY-MM-DD` text in SQL: `pg` parses `date` at local midnight. */
const HOLIDAY_DATES = sql<string[]>`ARRAY(SELECT to_char(h, 'YYYY-MM-DD') FROM unnest(business_hours.holidays) AS h ORDER BY h)`.as('holiday_dates');

const POLICY_COLUMNS = [
  'sla_policies.id',
  'sla_policies.name',
  'sla_policies.position',
  'sla_policies.conditions',
  'sla_policies.business_hours_id',
  'sla_policies.first_response_minutes',
  'sla_policies.next_response_minutes',
  'sla_policies.resolution_minutes',
  'sla_policies.warning_percent',
] as const;

export class SlaAdminRepository extends TenantRepository {
  /**
   * Serializes the writes of one tenant's SLA configuration (calendars and policies), so a policy
   * can't be saved against a calendar that is being deleted. Released at commit.
   */
  async lockConfig(tx: TenantTransaction): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`sla_config:${this.ctx.tenantId}`}))`.execute(tx);
  }

  // -- business hours --------------------------------------------------------------------------

  async listBusinessHours(tx: TenantTransaction): Promise<BusinessHoursRecord[]> {
    const rows = await this.selectFrom(tx, 'business_hours')
      .select(['business_hours.id', 'business_hours.name', 'business_hours.timezone', 'business_hours.intervals', HOLIDAY_DATES])
      .orderBy(sql`lower(business_hours.name)`)
      .orderBy('business_hours.id')
      .execute();
    return rows.map(toBusinessHours);
  }

  async businessHoursById(tx: TenantTransaction, id: string): Promise<BusinessHoursRecord | undefined> {
    const row = await this.selectFrom(tx, 'business_hours')
      .select(['business_hours.id', 'business_hours.name', 'business_hours.timezone', 'business_hours.intervals', HOLIDAY_DATES])
      .where('business_hours.id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toBusinessHours(row);
  }

  /** Another calendar already uses the name (case-insensitive, like the unique index). */
  async businessHoursNameTaken(tx: TenantTransaction, name: string, exceptId?: string): Promise<boolean> {
    let query = this.selectFrom(tx, 'business_hours')
      .select('business_hours.id')
      .where(sql<boolean>`lower(business_hours.name) = lower(${name})`);
    if (exceptId !== undefined) query = query.where('business_hours.id', '!=', exceptId);
    return (await query.executeTakeFirst()) !== undefined;
  }

  async insertBusinessHours(tx: TenantTransaction, values: BusinessHoursValues): Promise<string> {
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

  async updateBusinessHours(tx: TenantTransaction, id: string, values: BusinessHoursValues): Promise<void> {
    await this.updateTable(tx, 'business_hours')
      .set({
        name: values.name,
        timezone: values.timezone,
        intervals: JSON.stringify(values.intervals),
        holidays: values.holidays,
      })
      .where('business_hours.id', '=', id)
      .execute();
  }

  async deleteBusinessHours(tx: TenantTransaction, id: string): Promise<void> {
    await this.deleteFrom(tx, 'business_hours').where('business_hours.id', '=', id).execute();
  }

  /** A policy or the tenant's settings still point at the calendar. */
  async businessHoursInUse(tx: TenantTransaction, id: string): Promise<boolean> {
    const policy = await this.selectFrom(tx, 'sla_policies').select('sla_policies.id').where('sla_policies.business_hours_id', '=', id).limit(1).executeTakeFirst();
    if (policy !== undefined) return true;
    const settings = await this.selectFrom(tx, 'tenant_settings')
      .select('tenant_settings.tenant_id')
      .where('tenant_settings.business_hours_id', '=', id)
      .executeTakeFirst();
    return settings !== undefined;
  }

  // -- policies --------------------------------------------------------------------------------

  async listPolicies(tx: TenantTransaction): Promise<SlaPolicyRecord[]> {
    const rows = await this.selectFrom(tx, 'sla_policies').select(POLICY_COLUMNS).orderBy('sla_policies.position').orderBy('sla_policies.id').execute();
    return rows.map(toPolicy);
  }

  async policyById(tx: TenantTransaction, id: string): Promise<SlaPolicyRecord | undefined> {
    const row = await this.selectFrom(tx, 'sla_policies').select(POLICY_COLUMNS).where('sla_policies.id', '=', id).executeTakeFirst();
    return row === undefined ? undefined : toPolicy(row);
  }

  /** The position after the current last one (0 for the first policy). */
  async nextPosition(tx: TenantTransaction): Promise<number> {
    const row = await this.selectFrom(tx, 'sla_policies').select((eb) => eb.fn.max('sla_policies.position').as('last')).executeTakeFirstOrThrow();
    return row.last === null ? 0 : Number(row.last) + 1;
  }

  async insertPolicy(tx: TenantTransaction, values: SlaPolicyValues, position: number): Promise<string> {
    const row = await this.insertInto(tx, 'sla_policies', {
      name: values.name,
      position,
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

  /** `position` is left alone when undefined. */
  async updatePolicy(tx: TenantTransaction, id: string, values: SlaPolicyValues, position: number | undefined): Promise<void> {
    await this.updateTable(tx, 'sla_policies')
      .set({
        name: values.name,
        conditions: JSON.stringify(values.conditions),
        business_hours_id: values.businessHoursId,
        first_response_minutes: values.firstResponseMinutes,
        next_response_minutes: values.nextResponseMinutes,
        resolution_minutes: values.resolutionMinutes,
        warning_percent: values.warningPercent,
        ...(position === undefined ? {} : { position }),
      })
      .where('sla_policies.id', '=', id)
      .execute();
  }

  /** `ticket_sla` rows of the policy go with it (ON DELETE CASCADE). */
  async deletePolicy(tx: TenantTransaction, id: string): Promise<void> {
    await this.deleteFrom(tx, 'sla_policies').where('sla_policies.id', '=', id).execute();
  }

  async existingGroupIds(tx: TenantTransaction, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.selectFrom(tx, 'groups').select('groups.id').where('groups.id', 'in', [...ids]).execute();
    return new Set(rows.map((row) => row.id));
  }

  // -- recompute -------------------------------------------------------------------------------

  /** A page of open (not resolved or closed) tickets in id order, after `afterId`. */
  async openTicketIds(tx: TenantTransaction, afterId: string | undefined, limit: number): Promise<string[]> {
    let query = this.selectFrom(tx, 'tickets')
      .select('tickets.id')
      .where('tickets.state', 'not in', ['resolved', 'closed'])
      .orderBy('tickets.id')
      .limit(limit);
    if (afterId !== undefined) query = query.where('tickets.id', '>', afterId);
    return (await query.execute()).map((row) => row.id);
  }
}

function toBusinessHours(row: {
  id: string;
  name: string;
  timezone: string;
  intervals: BusinessHoursIntervals;
  holiday_dates: string[];
}): BusinessHoursRecord {
  return { id: row.id, name: row.name, timezone: row.timezone, intervals: row.intervals, holidays: row.holiday_dates };
}

function toPolicy(row: {
  id: string;
  name: string;
  position: number;
  conditions: unknown;
  business_hours_id: string;
  first_response_minutes: number | null;
  next_response_minutes: number | null;
  resolution_minutes: number | null;
  warning_percent: number;
}): SlaPolicyRecord {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    conditions: row.conditions,
    businessHoursId: row.business_hours_id,
    firstResponseMinutes: row.first_response_minutes,
    nextResponseMinutes: row.next_response_minutes,
    resolutionMinutes: row.resolution_minutes,
    warningPercent: row.warning_percent,
  };
}
