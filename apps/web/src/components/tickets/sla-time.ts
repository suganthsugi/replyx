import { formatDurationLong, formatDurationShort } from '../data-display/duration';

import type { SlaSummary } from '../../data/tickets';

/**
 * What an SLA pill says for a moment in time (pure, so the pill and its tests share it). The
 * server decides the status; the clock only adds the remaining time, and flips a pill whose due
 * time has passed to "breached" before the server's sweep has recorded it.
 */

export type SlaTone = 'success' | 'warning' | 'error';

export interface SlaPresentation {
  tone: SlaTone;
  /** The pill text: "12m left", "Overdue 5m", or the status word when there is no due time. */
  text: string;
  /** The full sentence for assistive technology. */
  label: string;
}

const TARGET_NAMES: Record<NonNullable<SlaSummary['target']>, string> = {
  first_response: 'First response',
  next_response: 'Next response',
  resolution: 'Resolution',
};

const STATUS_WORDS = { ok: 'On track', warning: 'At risk', breached: 'Breached' } as const;

export function presentSla(sla: SlaSummary, now: number): SlaPresentation | null {
  if (sla.status === 'none') return null;
  const target = sla.target === undefined ? 'SLA' : TARGET_NAMES[sla.target];
  const due = sla.nextDueAt === null || sla.nextDueAt === undefined ? Number.NaN : Date.parse(sla.nextDueAt);

  if (Number.isNaN(due)) {
    const word = STATUS_WORDS[sla.status];
    return { tone: sla.status === 'ok' ? 'success' : sla.status === 'warning' ? 'warning' : 'error', text: word, label: `${target}: ${word.toLowerCase()}` };
  }

  const minutes = (due - now) / 60_000;
  if (minutes < 0 || sla.status === 'breached') {
    const over = Math.max(0, -minutes);
    return {
      tone: 'error',
      text: `Overdue ${formatDurationShort(over)}`,
      label: over < 1 ? `${target} just became overdue` : `${target} overdue by ${formatDurationLong(over)}`,
    };
  }
  return {
    tone: sla.status === 'warning' ? 'warning' : 'success',
    text: `${formatDurationShort(minutes)} left`,
    label: `${target} due in ${minutes < 1 ? 'less than a minute' : formatDurationLong(minutes)}${sla.status === 'warning' ? ', at risk' : ''}`,
  };
}
