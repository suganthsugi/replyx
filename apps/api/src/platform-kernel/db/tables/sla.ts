import type { ColumnType, Generated, GeneratedTimestamp, Timestamp } from './column-types.js';

/** Migration 0014_sla (data-model.md "business_hours", "sla_policies", "ticket_sla", "sla_events"). */

export type SlaTarget = 'first_response' | 'next_response' | 'resolution';
export type SlaStatus = 'ok' | 'warning' | 'breached';
export type SlaEventKind = 'warning' | 'breached';

export type BusinessHoursWeekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/** `HH:MM` local times in the calendar's timezone (contracts/operations.yaml BusinessHours). */
export interface BusinessHoursRange {
  from: string;
  to: string;
}

export type BusinessHoursIntervals = Partial<Record<BusinessHoursWeekday, BusinessHoursRange[]>>;

export interface BusinessHoursTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  timezone: string;
  /** Read as an object; written as a JSON string (the pg driver does not serialize objects for jsonb). */
  intervals: ColumnType<BusinessHoursIntervals, string | undefined, string>;
  /**
   * date[]: the pg driver parses it to `Date[]` at local midnight, so select it as text
   * (`holidays::text[]`) or cast in the repository when the exact date matters.
   */
  holidays: ColumnType<Date[], string | string[] | undefined, string | string[]>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface SlaPoliciesTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  position: Generated<number>;
  /** Shared condition group (priority, group); read as an object, written as a JSON string. */
  conditions: ColumnType<Record<string, unknown>, string | undefined, string>;
  business_hours_id: string;
  first_response_minutes: number | null;
  next_response_minutes: number | null;
  resolution_minutes: number | null;
  warning_percent: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface TicketSlaTable {
  ticket_id: string;
  tenant_id: string;
  policy_id: string;
  first_response_due_at: Timestamp | null;
  first_response_warn_at: Timestamp | null;
  next_response_due_at: Timestamp | null;
  next_response_warn_at: Timestamp | null;
  resolution_due_at: Timestamp | null;
  resolution_warn_at: Timestamp | null;
  status: Generated<SlaStatus>;
  paused_since: Timestamp | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface SlaEventsTable {
  id: Generated<string>;
  tenant_id: string;
  ticket_id: string;
  target: SlaTarget;
  kind: SlaEventKind;
  occurred_at: GeneratedTimestamp;
}

export interface SlaTables {
  business_hours: BusinessHoursTable;
  sla_policies: SlaPoliciesTable;
  ticket_sla: TicketSlaTable;
  sla_events: SlaEventsTable;
}
