/**
 * The shape behind `BusinessHoursEditor` (US12, FR-085): a time zone, the open ranges of each weekday
 * and a list of holiday dates. The name of the schedule belongs to the page's own field.
 *
 * Times are local wall-clock `HH:MM` strings. As on the server, a range whose end is not after its
 * start continues past midnight (`22:00` to `02:00`), and `24:00` is allowed as an end. A browser
 * time input cannot hold `24:00`, so the editor shows it as `00:00` (see `toInputTime`); both mean
 * "until midnight".
 */

export const WEEKDAYS = [
  { key: 'mon', label: 'Monday' },
  { key: 'tue', label: 'Tuesday' },
  { key: 'wed', label: 'Wednesday' },
  { key: 'thu', label: 'Thursday' },
  { key: 'fri', label: 'Friday' },
  { key: 'sat', label: 'Saturday' },
  { key: 'sun', label: 'Sunday' },
] as const;

export type Weekday = (typeof WEEKDAYS)[number]['key'];

export interface TimeRange {
  from: string;
  to: string;
}

/** Every weekday is present; a closed day is `[]`. */
export type BusinessHoursIntervals = Record<Weekday, TimeRange[]>;

export interface BusinessHoursValue {
  /** IANA time zone, e.g. `Europe/Berlin`. */
  timezone: string;
  intervals: BusinessHoursIntervals;
  /** `YYYY-MM-DD`, sorted, no duplicates. */
  holidays: string[];
}

/** The request body fields (minus `name`): only open days are sent. */
export interface BusinessHoursInput {
  timezone: string;
  intervals: Partial<Record<Weekday, TimeRange[]>>;
  holidays: string[];
}

/**
 * Messages by path, using the API's `details` paths: `timezone`, `intervals` (no open day),
 * `intervals.mon` (a problem between ranges), `intervals.mon.0` (one range), `intervals.mon.0.from`,
 * `intervals.mon.0.to`, `holidays` and `holidays.2`.
 */
export type BusinessHoursErrors = Readonly<Record<string, string>>;

export const DEFAULT_RANGE: Readonly<TimeRange> = { from: '09:00', to: '17:00' };
export const ALL_DAY_RANGE: Readonly<TimeRange> = { from: '00:00', to: '24:00' };
export const MAX_RANGES_PER_DAY = 6;
export const MAX_HOLIDAYS = 200;

const MINUTES_PER_DAY = 1440;
const START_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const END_TIME = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Every IANA zone the browser knows, the browser's own zone first. `UTC` is always offered. */
export function timeZoneOptions(): string[] {
  const supported = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const all = supported.includes('UTC') ? supported : [...supported, 'UTC'];
  const own = browserTimeZone();
  return [own, ...all.filter((zone) => zone !== own)];
}

export function isValidTimeZone(zone: string): boolean {
  if (zone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function emptyIntervals(): BusinessHoursIntervals {
  return { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
}

/** A fresh schedule: Monday to Friday, 09:00 to 17:00, in the browser's zone. */
export function defaultBusinessHours(timezone: string = browserTimeZone()): BusinessHoursValue {
  const intervals = emptyIntervals();
  for (const day of ['mon', 'tue', 'wed', 'thu', 'fri'] as const) intervals[day] = [{ ...DEFAULT_RANGE }];
  return { timezone, intervals, holidays: [] };
}

/** Builds an editor value from an API response (missing weekdays become closed days). */
export function toBusinessHoursValue(input: {
  timezone: string;
  intervals?: Partial<Record<string, readonly TimeRange[]>> | undefined;
  holidays?: readonly string[] | undefined;
}): BusinessHoursValue {
  const intervals = emptyIntervals();
  for (const { key } of WEEKDAYS) intervals[key] = (input.intervals?.[key] ?? []).map((range) => ({ from: range.from, to: range.to }));
  return { timezone: input.timezone, intervals, holidays: normalizeHolidays(input.holidays ?? []) };
}

/** The request body fields for the editor value: open days only, holidays sorted. */
export function toBusinessHoursInput(value: BusinessHoursValue): BusinessHoursInput {
  const intervals: Partial<Record<Weekday, TimeRange[]>> = {};
  for (const { key } of WEEKDAYS) {
    const ranges = value.intervals[key];
    if (ranges.length > 0) intervals[key] = ranges.map((range) => ({ from: range.from, to: range.to }));
  }
  return { timezone: value.timezone, intervals, holidays: normalizeHolidays(value.holidays) };
}

export function normalizeHolidays(dates: readonly string[]): string[] {
  return [...new Set(dates)].sort();
}

/** `YYYY-MM-DD` that is a real calendar date (no 2026-02-30). */
export function isValidDate(date: string): boolean {
  if (!DATE_ONLY.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

export interface HolidayAddResult {
  holidays: string[];
  outcome: 'added' | 'duplicate' | 'invalid' | 'full';
}

/** Adds one date, keeping the list sorted; a duplicate or invalid date changes nothing. */
export function addHoliday(holidays: readonly string[], date: string): HolidayAddResult {
  if (!isValidDate(date)) return { holidays: [...holidays], outcome: 'invalid' };
  if (holidays.includes(date)) return { holidays: [...holidays], outcome: 'duplicate' };
  if (holidays.length >= MAX_HOLIDAYS) return { holidays: [...holidays], outcome: 'full' };
  return { holidays: normalizeHolidays([...holidays, date]), outcome: 'added' };
}

export function removeHoliday(holidays: readonly string[], date: string): string[] {
  return holidays.filter((entry) => entry !== date);
}

/** Copies one day's ranges onto every other day. */
export function copyDayToAll(intervals: BusinessHoursIntervals, source: Weekday): BusinessHoursIntervals {
  const next = emptyIntervals();
  for (const { key } of WEEKDAYS) next[key] = intervals[source].map((range) => ({ ...range }));
  return next;
}

export function setDayRanges(intervals: BusinessHoursIntervals, day: Weekday, ranges: TimeRange[]): BusinessHoursIntervals {
  return { ...intervals, [day]: ranges };
}

/** True for exactly one range covering the whole day (`00:00` to `24:00`, or `00:00` to `00:00`). */
export function isAllDay(ranges: readonly TimeRange[]): boolean {
  const only = ranges.length === 1 ? ranges[0] : undefined;
  return only !== undefined && only.from === '00:00' && (only.to === '24:00' || only.to === '00:00');
}

/** What a `<input type="time">` can show for a stored time: `24:00` becomes `00:00`. */
export function toInputTime(time: string): string {
  return time === '24:00' ? '00:00' : time;
}

export function toMinutes(time: string): number | undefined {
  if (!END_TIME.test(time)) return undefined;
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

/** End of a range in minutes from the start of its day; more than 1440 when it runs past midnight. */
export function rangeEnd(range: TimeRange): { start: number; end: number } | undefined {
  const start = START_TIME.test(range.from) ? toMinutes(range.from) : undefined;
  const end = toMinutes(range.to);
  if (start === undefined || end === undefined) return undefined;
  if (range.to === '24:00') return { start, end: MINUTES_PER_DAY };
  return { start, end: end <= start ? MINUTES_PER_DAY + end : end };
}

export function crossesMidnight(range: TimeRange): boolean {
  const bounds = rangeEnd(range);
  return bounds !== undefined && bounds.end > MINUTES_PER_DAY;
}

/**
 * A short note for a complete range: "Open all day", "Ends at midnight" or "Ends the next day at
 * 02:00". `undefined` for an ordinary same-day range or an incomplete one.
 */
export function rangeHint(range: TimeRange): string | undefined {
  const bounds = rangeEnd(range);
  if (bounds === undefined) return undefined;
  if (bounds.start === 0 && bounds.end >= MINUTES_PER_DAY && (range.to === '24:00' || range.to === '00:00')) return 'Open all day.';
  if (range.to === '24:00' || range.to === '00:00') return 'Ends at midnight.';
  if (bounds.end > MINUTES_PER_DAY) return `Ends the next day at ${range.to}.`;
  return undefined;
}

function dayLabel(day: Weekday): string {
  return WEEKDAYS.find((entry) => entry.key === day)?.label ?? day;
}

/**
 * Checks a whole schedule. Returns messages by path (see `BusinessHoursErrors`); an empty object
 * means the value can be saved. Overlapping ranges are reported (the server would merge them, but a
 * schedule that needs merging is usually a typo), including a range that runs past midnight into
 * the next day's first range.
 */
export function validateBusinessHours(value: BusinessHoursValue): Record<string, string> {
  const errors: Record<string, string> = {};

  if (!isValidTimeZone(value.timezone)) errors['timezone'] = 'Choose a time zone from the list.';

  let openDays = 0;
  const spans: Record<Weekday, { start: number; end: number; index: number }[]> = {
    mon: [],
    tue: [],
    wed: [],
    thu: [],
    fri: [],
    sat: [],
    sun: [],
  };

  for (const { key, label } of WEEKDAYS) {
    const ranges = value.intervals[key];
    if (ranges.length > 0) openDays += 1;
    ranges.forEach((range, index) => {
      const path = `intervals.${key}.${index}`;
      let complete = true;
      if (range.from === '') {
        errors[`${path}.from`] = 'Enter a start time.';
        complete = false;
      } else if (!START_TIME.test(range.from)) {
        errors[`${path}.from`] = 'Enter a time as hours and minutes.';
        complete = false;
      }
      if (range.to === '') {
        errors[`${path}.to`] = 'Enter an end time.';
        complete = false;
      } else if (!END_TIME.test(range.to)) {
        errors[`${path}.to`] = 'Enter a time as hours and minutes.';
        complete = false;
      }
      if (!complete) return;
      if (range.from === range.to && range.from !== '00:00') {
        errors[path] = `${label}: start and end are the same. Use "24 hours" for a day that never closes.`;
        return;
      }
      const bounds = rangeEnd(range);
      if (bounds !== undefined) spans[key].push({ ...bounds, index });
    });
  }

  if (openDays === 0) errors['intervals'] = 'Open at least one day.';

  WEEKDAYS.forEach(({ key, label }, dayIndex) => {
    const sorted = [...spans[key]].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i += 1) {
      const previous = sorted[i - 1];
      const current = sorted[i];
      if (previous !== undefined && current !== undefined && current.start < previous.end) {
        errors[`intervals.${key}`] = `${label}: ranges overlap. Merge them or move one.`;
        break;
      }
    }
    // A range running past midnight must not reach into the next day's first range.
    const tail = Math.max(0, ...sorted.map((span) => span.end - MINUTES_PER_DAY));
    const nextDay = WEEKDAYS[(dayIndex + 1) % WEEKDAYS.length];
    if (tail > 0 && nextDay !== undefined && errors[`intervals.${nextDay.key}`] === undefined) {
      const clash = spans[nextDay.key].some((span) => span.start < tail);
      if (clash) errors[`intervals.${nextDay.key}`] = `${nextDay.label}: a range starts before the one from ${dayLabel(key)} ends.`;
    }
  });

  value.holidays.forEach((date, index) => {
    if (!isValidDate(date)) errors[`holidays.${index}`] = `${date === '' ? 'Empty date' : date} is not a valid date.`;
  });

  return errors;
}
