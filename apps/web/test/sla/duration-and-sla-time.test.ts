import { describe, expect, it } from 'vitest';

import { formatDurationLong, formatDurationShort } from '../../src/components/data-display/duration';
import { presentSla } from '../../src/components/tickets/sla-time';

import type { SlaSummary } from '../../src/data/tickets';

describe('duration formatting', () => {
  it.each([
    [0, '<1m'],
    [0.4, '<1m'],
    [1, '1m'],
    [12, '12m'],
    [60, '1h'],
    [125, '2h 5m'],
    [1440, '1d'],
    [1500, '1d 1h'],
    [2885, '2d'],
  ])('short: %s minutes is %s', (minutes, text) => {
    expect(formatDurationShort(minutes)).toBe(text);
  });

  it.each([
    [0.5, 'less than a minute'],
    [1, '1 minute'],
    [12, '12 minutes'],
    [60, '1 hour'],
    [125, '2 hours 5 minutes'],
    [1500, '1 day 1 hour'],
    [1505, '1 day 1 hour'],
  ])('long: %s minutes is %s', (minutes, text) => {
    expect(formatDurationLong(minutes)).toBe(text);
  });
});

const NOW = Date.parse('2026-10-07T10:00:00.000Z');
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

describe('presentSla', () => {
  it('has nothing to say for a ticket outside any policy', () => {
    expect(presentSla({ status: 'none' }, NOW)).toBeNull();
  });

  it('on track: time left, success tone, no warning wording', () => {
    const sla: SlaSummary = { status: 'ok', target: 'resolution', nextDueAt: at(125) };
    expect(presentSla(sla, NOW)).toEqual({ tone: 'success', text: '2h 5m left', label: 'Resolution due in 2 hours 5 minutes' });
  });

  it('at risk: warning tone and the sentence says so', () => {
    const sla: SlaSummary = { status: 'warning', target: 'first_response', nextDueAt: at(12) };
    expect(presentSla(sla, NOW)).toEqual({ tone: 'warning', text: '12m left', label: 'First response due in 12 minutes, at risk' });
  });

  it('under a minute left', () => {
    const shown = presentSla({ status: 'warning', target: 'next_response', nextDueAt: at(0.5) }, NOW);
    expect(shown?.text).toBe('<1m left');
    expect(shown?.label).toBe('Next response due in less than a minute, at risk');
  });

  it('breached by the server: overdue by the time past due', () => {
    const shown = presentSla({ status: 'breached', target: 'first_response', nextDueAt: at(-5) }, NOW);
    expect(shown).toEqual({ tone: 'error', text: 'Overdue 5m', label: 'First response overdue by 5 minutes' });
  });

  it('is overdue once past due even before the server records the breach', () => {
    const shown = presentSla({ status: 'ok', target: 'resolution', nextDueAt: at(-90) }, NOW);
    expect(shown).toEqual({ tone: 'error', text: 'Overdue 1h 30m', label: 'Resolution overdue by 1 hour 30 minutes' });
  });

  it('with no due time falls back to the status word', () => {
    expect(presentSla({ status: 'breached', target: 'resolution' }, NOW)).toEqual({ tone: 'error', text: 'Breached', label: 'Resolution: breached' });
    expect(presentSla({ status: 'ok' }, NOW)).toEqual({ tone: 'success', text: 'On track', label: 'SLA: on track' });
    expect(presentSla({ status: 'warning', nextDueAt: null }, NOW)?.tone).toBe('warning');
  });
});
