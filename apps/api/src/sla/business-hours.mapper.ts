import { BusinessCalendar, type BusinessHoursConfig } from './business-calendar.js';

import type { BusinessHoursIntervals, BusinessHoursWeekday } from '../platform-kernel/db/tables/sla.js';

/**
 * Maps a `business_hours` row (data-model.md, contracts/operations.yaml `BusinessHours`) to the
 * pure calendar (business-calendar.ts). The row stores weekday keys (`mon`..`sun`) with
 * `{from, to}` ranges and holidays as dates; the calendar takes flat ISO-weekday intervals
 * (1 = Monday ... 7 = Sunday) with `start`/`end`.
 *
 * `holidays` must already be `YYYY-MM-DD` text. `pg` parses a `date[]` column into `Date`s at local
 * midnight, which shifts the day in other timezones, so select it as text in SQL
 * (`to_char(h, 'YYYY-MM-DD')`, see `SlaRepository.businessHours`) and pass that here.
 */

export interface BusinessHoursRowLike {
  timezone: string;
  intervals: BusinessHoursIntervals;
  holidays: readonly string[];
}

const WEEKDAY_NUMBER: Readonly<Record<BusinessHoursWeekday, number>> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };

/** The calendar config for a row; `BusinessCalendar` validates it (an empty schedule is rejected). */
export function businessHoursRowToConfig(row: BusinessHoursRowLike): BusinessHoursConfig {
  const intervals: BusinessHoursConfig['intervals'] = [];
  for (const [weekday, ranges] of Object.entries(row.intervals) as [BusinessHoursWeekday, { from: string; to: string }[] | undefined][]) {
    const day = WEEKDAY_NUMBER[weekday];
    if (day === undefined || ranges === undefined) continue;
    for (const range of ranges) intervals.push({ day, start: range.from, end: range.to });
  }
  return { timezone: row.timezone, intervals, holidays: [...row.holidays] };
}

/** Throws `ZodError` when the row's schedule is not a valid calendar (for example no intervals). */
export function businessHoursRowToCalendar(row: BusinessHoursRowLike): BusinessCalendar {
  return new BusinessCalendar(businessHoursRowToConfig(row));
}
