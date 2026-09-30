/**
 * Business calendar for SLA timers (research D15, FR-084). Pure: no database, no Nest, no clock.
 * Every function takes explicit instants; services inject `Clock` and pass `clock.now()` in.
 *
 * Design choices
 * - Weekdays are ISO: 1 = Monday ... 7 = Sunday.
 * - Times are local wall-clock `HH:mm` in the tenant timezone. `24:00` is allowed as an END only.
 * - An interval with `end <= start` (e.g. 22:00-02:00, or 18:00-00:00) continues past midnight into
 *   the next local day. Holidays apply to the local date the interval STARTS on, so a holiday
 *   closes the interval that starts on it (including its spill) but not the spill of an interval
 *   that started the day before.
 * - Holidays are local calendar dates (`YYYY-MM-DD`) in the tenant timezone; the whole day is closed.
 * - Multiple intervals per day are allowed. Overlapping or adjacent intervals are merged, also
 *   across midnight, so a moment is never counted twice.
 * - Opening hours are half-open: `[start, end)`. A moment exactly at `end` is outside hours.
 * - DST: interval boundaries are resolved as local wall-clock times with Luxon, then compared as
 *   real instants, so minutes are real elapsed minutes inside the local interval (00:00-06:00 is
 *   5h on spring-forward days and 7h on fall-back days in America/New_York).
 *   Nonexistent local times are moved forward by Luxon and never throw.
 * - `addBusinessMinutes(from, 0)` returns `from` when open, else the next open instant.
 * - When no open time exists within the scan horizon (`MAX_SCAN_DAYS`, ~10 years, e.g. holidays
 *   cover everything) `addBusinessMinutes` throws `BusinessCalendarError`.
 */
import { DateTime, IANAZone } from 'luxon';
import { z } from 'zod';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const MINUTES_PER_DAY = 1440;

/** How many local days a search scans before giving up (about 10 years). */
export const MAX_SCAN_DAYS = 3660;

/** Raised when a calendar has no open time within the scan horizon. */
export class BusinessCalendarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BusinessCalendarError';
  }
}

const START_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const END_TIME = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: string): boolean {
  if (!LOCAL_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}

/** One weekly opening interval. `day` is the ISO weekday (1 = Monday ... 7 = Sunday). */
export const BusinessIntervalSchema = z
  .object({
    day: z.number().int().min(1).max(7),
    start: z.string().regex(START_TIME),
    end: z.string().regex(END_TIME),
  })
  .strict()
  .refine((i) => i.start !== i.end, { message: 'Interval must not be zero-length', path: ['end'] });

/**
 * Business hours config: IANA timezone, weekly intervals (at least one) and holiday dates.
 * T224 reuses this for the admin API.
 */
export const BusinessHoursConfigSchema = z
  .object({
    timezone: z.string().refine((tz) => IANAZone.isValidZone(tz), { message: 'Unknown timezone' }),
    intervals: z.array(BusinessIntervalSchema).min(1).max(100),
    holidays: z
      .array(z.string().refine(isRealDate, { message: 'Expected a YYYY-MM-DD date' }))
      .max(1000)
      .default([]),
  })
  .strict();

export type BusinessInterval = z.infer<typeof BusinessIntervalSchema>;
export type BusinessHoursConfig = z.input<typeof BusinessHoursConfigSchema>;

type Instant = Date | DateTime;

interface Segment {
  /** Minutes from local midnight of the day the interval starts on. */
  start: number;
  /** Minutes from that same midnight; above 1440 means it continues into the next local day. */
  end: number;
}

interface Window {
  start: number;
  end: number;
}

function toMillis(at: Instant): number {
  const ms = at instanceof Date ? at.getTime() : at.toMillis();
  if (!Number.isFinite(ms)) throw new RangeError('Invalid date');
  return ms;
}

function parseMinutes(hhmm: string): number {
  const h = Number(hhmm.slice(0, 2));
  const m = Number(hhmm.slice(3, 5));
  return h * 60 + m;
}

/** Sort and merge overlapping or adjacent segments of one weekday. */
function mergeSegments(segments: Segment[]): Segment[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const out: Segment[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

export class BusinessCalendar {
  readonly timezone: string;
  private readonly byWeekday: Segment[][] = [[], [], [], [], [], [], [], []];
  private readonly holidays: Set<string>;
  private readonly alwaysOpen: boolean;

  /** Validates the config with `BusinessHoursConfigSchema`; throws a ZodError when invalid. */
  constructor(config: BusinessHoursConfig) {
    const parsed = BusinessHoursConfigSchema.parse(config);
    this.timezone = parsed.timezone;
    this.holidays = new Set(parsed.holidays);

    const raw: Segment[][] = [[], [], [], [], [], [], [], []];
    for (const i of parsed.intervals) {
      const start = parseMinutes(i.start);
      let end = parseMinutes(i.end);
      if (end <= start) end += MINUTES_PER_DAY;
      raw[i.day]!.push({ start, end });
    }
    for (let d = 1; d <= 7; d++) this.byWeekday[d] = mergeSegments(raw[d]!);

    this.alwaysOpen =
      this.holidays.size === 0 &&
      this.byWeekday.slice(1).every((s) => s.length === 1 && s[0]!.start === 0 && s[0]!.end >= MINUTES_PER_DAY);
  }

  /** True when `at` falls inside opening hours (start inclusive, end exclusive). */
  isWithinBusinessHours(at: Instant): boolean {
    const ms = toMillis(at);
    if (this.alwaysOpen) return true;
    const first = this.windows(ms, 3).next();
    // windows() only yields windows ending after ms, so the first one contains ms when it started.
    return !first.done && first.value.start <= ms;
  }

  /**
   * The earliest open instant at or after `at` (`at` itself when open).
   * Throws `BusinessCalendarError` when there is none within the scan horizon.
   */
  nextBusinessOpen(at: Instant): Date {
    const ms = toMillis(at);
    if (this.alwaysOpen) return new Date(ms);
    const first = this.windows(ms, MAX_SCAN_DAYS).next();
    if (!first.done) return new Date(Math.max(first.value.start, ms));
    throw new BusinessCalendarError('No business hours within the scan horizon');
  }

  /**
   * Adds `minutes` of business time to `from`. Starts at `from` if open, else at the next open
   * instant. 0 minutes returns that start. When the minutes end exactly at closing time, the
   * closing instant is returned. Throws RangeError for negative/non-finite minutes.
   */
  addBusinessMinutes(from: Instant, minutes: number): Date {
    if (!Number.isFinite(minutes) || minutes < 0) throw new RangeError('minutes must be >= 0');
    const ms = toMillis(from);
    let remaining = Math.round(minutes * MINUTE_MS);
    if (this.alwaysOpen) return new Date(ms + remaining);
    for (const w of this.windows(ms, MAX_SCAN_DAYS)) {
      const start = Math.max(w.start, ms);
      const available = w.end - start;
      if (remaining <= available) return new Date(start + remaining);
      remaining -= available;
    }
    throw new BusinessCalendarError('Not enough business hours within the scan horizon');
  }

  /**
   * Business minutes inside `[a, b)`. Returns 0 when `b <= a`. May be fractional when the
   * instants are not minute-aligned.
   */
  businessMinutesBetween(a: Instant, b: Instant): number {
    const from = toMillis(a);
    const to = toMillis(b);
    if (to <= from) return 0;
    if (this.alwaysOpen) return (to - from) / MINUTE_MS;
    const days = Math.ceil((to - from) / DAY_MS) + 3;
    let total = 0;
    for (const w of this.windows(from, days)) {
      if (w.start >= to) break;
      total += Math.min(w.end, to) - Math.max(w.start, from);
    }
    return total / MINUTE_MS;
  }

  /** Local wall-clock `minutes` (0..2880) on the UTC-midnight-encoded calendar day to an instant. */
  private instantAt(dayUtcMs: number, minutes: number): number {
    const offset = Math.floor(minutes / MINUTES_PER_DAY);
    const within = minutes - offset * MINUTES_PER_DAY;
    const d = new Date(dayUtcMs + offset * DAY_MS);
    return DateTime.fromObject(
      {
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
        hour: Math.floor(within / 60),
        minute: within % 60,
      },
      { zone: this.timezone },
    ).toMillis();
  }

  /**
   * Merged open windows (absolute ms, ascending) that end after `fromMs`, scanning `maxDays`
   * local days starting the day before `fromMs` (to catch intervals spilling past midnight).
   * A merged window may start before `fromMs`; callers clip it.
   */
  private *windows(fromMs: number, maxDays: number): Generator<Window> {
    const local = DateTime.fromMillis(fromMs, { zone: this.timezone });
    const firstDay = Date.UTC(local.year, local.month - 1, local.day) - DAY_MS;
    let cur: Window | null = null;
    for (let i = 0; i < maxDays; i++) {
      const dayMs = firstDay + i * DAY_MS;
      const day = new Date(dayMs);
      if (this.holidays.has(day.toISOString().slice(0, 10))) continue;
      const segments = this.byWeekday[day.getUTCDay() || 7]!;
      for (const s of segments) {
        const w: Window = { start: this.instantAt(dayMs, s.start), end: this.instantAt(dayMs, s.end) };
        if (w.end <= w.start) continue;
        if (cur && w.start <= cur.end) {
          cur.end = Math.max(cur.end, w.end);
        } else {
          if (cur && cur.end > fromMs) yield cur;
          cur = w;
        }
      }
    }
    if (cur && cur.end > fromMs) yield cur;
  }
}

/** A calendar that is always open (clock time), for policies without business hours. */
export function twentyFourSeven(timezone = 'UTC'): BusinessCalendar {
  return new BusinessCalendar({
    timezone,
    intervals: [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, start: '00:00', end: '24:00' })),
    holidays: [],
  });
}
