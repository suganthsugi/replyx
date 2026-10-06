/**
 * Human durations from minutes, for SLA countdowns and the dashboard averages. `short` is for
 * pills and tiles ("2h 5m"), `long` for accessible names ("2 hours 5 minutes").
 */

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;

interface Parts {
  days: number;
  hours: number;
  minutes: number;
}

function split(totalMinutes: number): Parts {
  const whole = Math.max(0, Math.round(totalMinutes));
  return {
    days: Math.floor(whole / MINUTES_PER_DAY),
    hours: Math.floor((whole % MINUTES_PER_DAY) / MINUTES_PER_HOUR),
    minutes: whole % MINUTES_PER_HOUR,
  };
}

/** `0` and anything under a minute read "<1m"; two units at most (a day count drops the minutes). */
export function formatDurationShort(totalMinutes: number): string {
  if (totalMinutes < 1) return '<1m';
  const { days, hours, minutes } = split(totalMinutes);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

export function formatDurationLong(totalMinutes: number): string {
  if (totalMinutes < 1) return 'less than a minute';
  const { days, hours, minutes } = split(totalMinutes);
  const parts: string[] = [];
  if (days > 0) parts.push(plural(days, 'day'));
  if (hours > 0) parts.push(plural(hours, 'hour'));
  // Past a day, the minutes are noise.
  if (minutes > 0 && days === 0) parts.push(plural(minutes, 'minute'));
  return parts.join(' ');
}
