import { IANAZone } from 'luxon';
import { z } from 'zod';

import type { BusinessHoursIntervals, BusinessHoursWeekday } from '../platform-kernel/db/tables/sla.js';

/**
 * Request schemas of the business-hours endpoints (contracts/operations.yaml `BusinessHours`).
 * All are `.strict()`. Error paths follow the web editor (`business-hours-model.ts`): `timezone`,
 * `intervals`, `intervals.mon.0`, `intervals.mon.0.from`, `holidays.2`.
 *
 * - `intervals`: weekday (`mon`..`sun`) to `{from, to}` local `HH:MM` ranges; `to` may be `24:00`,
 *   and a range whose end is not after its start continues past midnight (business-calendar.ts).
 *   `00:00`-`00:00` means the whole day and is stored as `00:00`-`24:00`; any other range with the
 *   same start and end is invalid. Overlapping ranges are accepted (the calendar merges them).
 * - At least one open day is required: a calendar that is never open can't run a timer.
 * - `holidays` are real `YYYY-MM-DD` dates; they are stored sorted and without duplicates.
 */

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const satisfies readonly BusinessHoursWeekday[];

export const MAX_RANGES_PER_DAY = 6;
export const MAX_HOLIDAYS = 200;

const START_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const END_TIME = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: string): boolean {
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}

const RangeSchema = z
  .object({
    from: z.string().regex(START_TIME),
    to: z.string().regex(END_TIME),
  })
  .strict();

const rangesOf = () => z.array(RangeSchema).max(MAX_RANGES_PER_DAY).optional();

const IntervalsSchema = z
  .object({
    mon: rangesOf(),
    tue: rangesOf(),
    wed: rangesOf(),
    thu: rangesOf(),
    fri: rangesOf(),
    sat: rangesOf(),
    sun: rangesOf(),
  })
  .strict();

export const BusinessHoursInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    timezone: z.string().trim().min(1).max(64),
    intervals: IntervalsSchema,
    holidays: z.array(z.string().regex(LOCAL_DATE)).max(MAX_HOLIDAYS).default([]),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (!IANAZone.isValidZone(input.timezone)) {
      ctx.addIssue({ code: 'invalid_value', values: [], path: ['timezone'], message: 'Unknown timezone' });
    }
    let openDays = 0;
    for (const day of WEEKDAYS) {
      const ranges = input.intervals[day] ?? [];
      if (ranges.length > 0) openDays += 1;
      ranges.forEach((range, index) => {
        if (range.from === range.to && !(range.from === '00:00' && range.to === '00:00')) {
          ctx.addIssue({ code: 'custom', path: ['intervals', day, index], message: 'Start and end must differ' });
        }
      });
    }
    if (openDays === 0) ctx.addIssue({ code: 'custom', path: ['intervals'], message: 'Open at least one day' });
    input.holidays.forEach((date, index) => {
      if (!isRealDate(date)) ctx.addIssue({ code: 'custom', path: ['holidays', index], message: 'Not a calendar date' });
    });
  });

export type BusinessHoursInput = z.infer<typeof BusinessHoursInputSchema>;

/** Stored shape: only open days, ranges sorted by start, whole-day `00:00`-`00:00` as `00:00`-`24:00`. */
export function normalizeIntervals(intervals: BusinessHoursInput['intervals']): BusinessHoursIntervals {
  const out: BusinessHoursIntervals = {};
  for (const day of WEEKDAYS) {
    const ranges = intervals[day] ?? [];
    if (ranges.length === 0) continue;
    out[day] = ranges
      .map((range) => (range.from === '00:00' && range.to === '00:00' ? { from: '00:00', to: '24:00' } : { from: range.from, to: range.to }))
      .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  }
  return out;
}

export function normalizeHolidays(holidays: readonly string[]): string[] {
  return [...new Set(holidays)].sort();
}

export const IdParams = z.object({ id: z.uuid() }).strict();
