import { WEEKDAYS, type TimeRange, type Weekday } from './business-hours-model';

/**
 * One-line descriptions of a weekly schedule for list rows: days with the same hours are joined
 * ("Mon-Fri 09:00-17:00; Sat 10:00-14:00"), closed days are left out, and `24:00` reads as "24h".
 */

const SHORT_DAYS: Record<Weekday, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

function rangesText(ranges: readonly TimeRange[]): string {
  if (ranges.length === 1 && ranges[0]?.from === '00:00' && (ranges[0].to === '24:00' || ranges[0].to === '00:00')) return '24h';
  return ranges.map((range) => `${range.from}-${range.to}`).join(', ');
}

export function summarizeIntervals(intervals: Partial<Record<string, readonly TimeRange[]>>): string {
  const runs: { days: Weekday[]; text: string }[] = [];
  for (const { key } of WEEKDAYS) {
    const ranges = intervals[key] ?? [];
    if (ranges.length === 0) continue;
    const text = rangesText(ranges);
    const last = runs[runs.length - 1];
    const previousDay = last?.days[last.days.length - 1];
    const adjacent = previousDay !== undefined && WEEKDAYS.findIndex((day) => day.key === previousDay) === WEEKDAYS.findIndex((day) => day.key === key) - 1;
    if (last !== undefined && adjacent && last.text === text) last.days.push(key);
    else runs.push({ days: [key], text });
  }
  if (runs.length === 0) return 'Closed every day';
  return runs
    .map(({ days, text }) => {
      const first = days[0];
      const end = days[days.length - 1];
      const label = days.length === 1 || first === undefined || end === undefined ? SHORT_DAYS[first ?? 'mon'] : `${SHORT_DAYS[first]}-${SHORT_DAYS[end]}`;
      return `${label} ${text}`;
    })
    .join('; ');
}

