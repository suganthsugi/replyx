import { DateTime } from 'luxon';

/**
 * Retention settings as values (FR-005a, research D18). Kept free of Nest and the database so the
 * rules are unit-testable: which values exist, what a cutoff is, and what counts as shortening.
 */

/** `tenant_settings.retention_period`: closed tickets are purged this long after closure. */
export const RETENTION_PERIODS = ['forever', 'P1Y', 'P2Y', 'P3Y', 'P4Y', 'P5Y', 'P6Y', 'P7Y'] as const;
export type RetentionPeriod = (typeof RETENTION_PERIODS)[number];

/** `tenant_settings.audit_retention`: at least one year, or indefinitely (FR-005a). */
export const AUDIT_RETENTIONS = ['forever', 'P1Y', 'P2Y', 'P3Y', 'P5Y', 'P7Y', 'P10Y'] as const;
export type AuditRetention = (typeof AUDIT_RETENTIONS)[number];

/** Years in `P{n}Y`; `null` for `forever` and anything that is not a whole-year duration. */
export function periodYears(period: string): number | null {
  const match = /^P([1-9][0-9]*)Y$/.exec(period);
  return match === null ? null : Number(match[1]);
}

/** Rows older than this are purged; `null` when nothing is ever purged (`forever`). */
export function retentionCutoff(now: Date, period: string): Date | null {
  const years = periodYears(period);
  if (years === null) return null;
  return DateTime.fromJSDate(now, { zone: 'utc' }).minus({ years }).toJSDate();
}

/**
 * True when `after` deletes data that `before` would still keep: from `forever` to any period, or
 * to a smaller number of years. Lengthening or keeping the period is never shortening.
 */
export function isShortening(before: string, after: string): boolean {
  const next = periodYears(after);
  if (next === null) return false;
  const current = periodYears(before);
  return current === null || next < current;
}
