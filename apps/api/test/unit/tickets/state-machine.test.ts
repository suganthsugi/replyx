import { describe, expect, it } from 'vitest';

import {
  initialState,
  invalidTransition,
  isPending,
  transition,
  type TicketTimers,
} from '../../../src/tickets/state-machine.js';

import type { TicketState } from '../../../src/platform-kernel/db/tables/tickets.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const FUTURE = new Date('2026-01-02T00:00:00.000Z');
const GRACE_HOURS = 24;

function timers(state: TicketState, overrides: Partial<TicketTimers> = {}): TicketTimers {
  return {
    state,
    pendingUntil: null,
    resolvedAt: null,
    autoCloseAt: null,
    closedAt: null,
    ...overrides,
  };
}

const ALL_STATES: TicketState[] = ['new', 'open', 'pending_reminder', 'pending_close', 'resolved', 'closed'];

describe('initialState', () => {
  it('starts staff-started tickets open (FR-038a)', () => {
    expect(initialState('staff_started')).toBe('open');
  });

  it('starts every other origin new', () => {
    expect(initialState('customer_message')).toBe('new');
    expect(initialState('split')).toBe('new');
    expect(initialState('follow_up')).toBe('new');
  });
});

describe('isPending', () => {
  it('is true only for pending_reminder and pending_close', () => {
    expect(isPending('pending_reminder')).toBe(true);
    expect(isPending('pending_close')).toBe(true);
    for (const state of ['new', 'open', 'resolved', 'closed'] as TicketState[]) {
      expect(isPending(state)).toBe(false);
    }
  });
});

describe('invalidTransition', () => {
  it('builds a 409 INVALID_TRANSITION AppError with readable state labels', () => {
    const error = invalidTransition('pending_reminder', 'closed');
    expect(error).toMatchObject({
      code: 'INVALID_TRANSITION',
      httpStatus: 409,
      message: "A pending reminder ticket can't be set to closed",
    });
  });
});

describe('customer_message cause', () => {
  it('keeps new tickets new (nobody has replied yet)', () => {
    const result = transition(timers('new'), { cause: 'customer_message', now: NOW, gracePeriodHours: GRACE_HOURS });
    expect(result.stateChanged).toBe(false);
    expect(result.state).toBe('new');
    expect(result.changes).toEqual({});
  });

  it('leaves an already-open ticket open', () => {
    const result = transition(timers('open'), { cause: 'customer_message', now: NOW, gracePeriodHours: GRACE_HOURS });
    expect(result.state).toBe('open');
    expect(result.stateChanged).toBe(false);
  });

  it.each(['pending_reminder', 'pending_close'] as TicketState[])(
    'moves a %s ticket to open and clears pending_until',
    (state) => {
      const result = transition(timers(state, { pendingUntil: FUTURE }), {
        cause: 'customer_message',
        now: NOW,
        gracePeriodHours: GRACE_HOURS,
      });
      expect(result.state).toBe('open');
      expect(result.stateChanged).toBe(true);
      expect(result.reopened).toBe(false);
      expect(result.changes).toEqual({ pending_until: null });
    },
  );

  it('reopens a resolved ticket within grace period, clearing resolved/close timers', () => {
    const result = transition(
      timers('resolved', { resolvedAt: NOW, autoCloseAt: FUTURE }),
      { cause: 'customer_message', now: NOW, gracePeriodHours: GRACE_HOURS },
    );
    expect(result.state).toBe('open');
    expect(result.reopened).toBe(true);
    expect(result.changes).toEqual({ resolved_at: null, auto_close_at: null });
  });

  it('reopens a closed ticket, clearing closed_at', () => {
    const result = transition(timers('closed', { closedAt: NOW }), {
      cause: 'customer_message',
      now: NOW,
      gracePeriodHours: GRACE_HOURS,
    });
    expect(result.state).toBe('open');
    expect(result.reopened).toBe(true);
    expect(result.changes).toEqual({ closed_at: null });
  });
});

describe('agent_reply cause', () => {
  it('moves a new ticket to open on the first public reply', () => {
    const result = transition(timers('new'), { cause: 'agent_reply', now: NOW, gracePeriodHours: GRACE_HOURS });
    expect(result.state).toBe('open');
    expect(result.stateChanged).toBe(true);
  });

  it.each(['open', 'pending_reminder', 'pending_close', 'resolved', 'closed'] as TicketState[])(
    'leaves a %s ticket unchanged',
    (state) => {
      const result = transition(timers(state), { cause: 'agent_reply', now: NOW, gracePeriodHours: GRACE_HOURS });
      expect(result.state).toBe(state);
      expect(result.stateChanged).toBe(false);
    },
  );
});

describe('agent cause: allowed transitions (data-model.md "Ticket state machine")', () => {
  const ALLOWED: Array<[TicketState, TicketState]> = [
    ['new', 'open'],
    ['new', 'pending_reminder'],
    ['new', 'pending_close'],
    ['new', 'resolved'],
    ['open', 'pending_reminder'],
    ['open', 'pending_close'],
    ['open', 'resolved'],
    ['pending_reminder', 'open'],
    ['pending_reminder', 'resolved'],
    ['pending_close', 'open'],
    ['pending_close', 'resolved'],
    ['resolved', 'open'],
    ['resolved', 'closed'],
    ['closed', 'open'],
  ];

  it.each(ALLOWED)('allows %s -> %s', (from, to) => {
    const input = isPending(to)
      ? { cause: 'agent' as const, to, pendingUntil: FUTURE, now: NOW, gracePeriodHours: GRACE_HOURS }
      : { cause: 'agent' as const, to, now: NOW, gracePeriodHours: GRACE_HOURS };
    const result = transition(timers(from), input);
    expect(result.state).toBe(to);
    expect(result.stateChanged).toBe(true);
    expect(result.from).toBe(from);
  });

  const ALLOWED_SET = new Set(ALLOWED.map(([from, to]) => `${from}->${to}`));
  const FORBIDDEN = ALL_STATES.flatMap((from) =>
    ALL_STATES.filter((to) => to !== from && !ALLOWED_SET.has(`${from}->${to}`)).map(
      (to): [TicketState, TicketState] => [from, to],
    ),
  );

  it.each(FORBIDDEN)('rejects %s -> %s with 409 INVALID_TRANSITION', (from, to) => {
    expect(() =>
      transition(timers(from), { cause: 'agent', to, now: NOW, gracePeriodHours: GRACE_HOURS }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION', httpStatus: 409 }));
  });

  it('setting the current state again is a no-op', () => {
    const result = transition(timers('open'), { cause: 'agent', to: 'open', now: NOW, gracePeriodHours: GRACE_HOURS });
    expect(result.stateChanged).toBe(false);
    expect(result.changes).toEqual({});
  });

  it('setting the same pending state again with a new date updates only pending_until', () => {
    const laterDate = new Date(FUTURE.getTime() + 1000);
    const result = transition(timers('pending_reminder', { pendingUntil: FUTURE }), {
      cause: 'agent',
      to: 'pending_reminder',
      pendingUntil: laterDate,
      now: NOW,
      gracePeriodHours: GRACE_HOURS,
    });
    expect(result.stateChanged).toBe(false);
    expect(result.state).toBe('pending_reminder');
    expect(result.changes).toEqual({ pending_until: laterDate });
  });

  it('setting the same pending state with the same date makes no change', () => {
    const result = transition(timers('pending_close', { pendingUntil: FUTURE }), {
      cause: 'agent',
      to: 'pending_close',
      pendingUntil: FUTURE,
      now: NOW,
      gracePeriodHours: GRACE_HOURS,
    });
    expect(result.stateChanged).toBe(false);
    expect(result.changes).toEqual({});
  });

  it('requires a target state', () => {
    expect(() =>
      transition(timers('new'), { cause: 'agent', now: NOW, gracePeriodHours: GRACE_HOURS }),
    ).toThrow('A agent transition needs a target state');
  });

  it('requires pendingUntil when entering a pending state', () => {
    expect(() =>
      transition(timers('new'), { cause: 'agent', to: 'pending_reminder', now: NOW, gracePeriodHours: GRACE_HOURS }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', httpStatus: 400 }));
  });

  it('rejects a pendingUntil that is not later than now', () => {
    expect(() =>
      transition(timers('new'), {
        cause: 'agent',
        to: 'pending_close',
        pendingUntil: NOW,
        now: NOW,
        gracePeriodHours: GRACE_HOURS,
      }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', httpStatus: 400 }));
  });
});

describe('sweeper cause', () => {
  it('closes pending_close when its date passes', () => {
    const result = transition(timers('pending_close', { pendingUntil: NOW }), {
      cause: 'sweeper',
      to: 'closed',
      now: NOW,
      gracePeriodHours: GRACE_HOURS,
    });
    expect(result.state).toBe('closed');
    expect(result.closed).toBe(true);
    expect(result.changes).toMatchObject({ closed_at: NOW, pending_until: null });
  });

  it('closes resolved when the grace period ends', () => {
    const result = transition(timers('resolved', { resolvedAt: NOW, autoCloseAt: NOW }), {
      cause: 'sweeper',
      to: 'closed',
      now: NOW,
      gracePeriodHours: GRACE_HOURS,
    });
    expect(result.state).toBe('closed');
    expect(result.closed).toBe(true);
    expect(result.changes).toMatchObject({ closed_at: NOW, auto_close_at: null });
  });

  const SWEEPER_ALLOWED = new Set(['pending_close->closed', 'resolved->closed']);

  it.each(
    ALL_STATES.flatMap((from) =>
      ALL_STATES.filter((to) => !SWEEPER_ALLOWED.has(`${from}->${to}`)).map(
        (to): [TicketState, TicketState] => [from, to],
      ),
    ),
  )('rejects sweeper %s -> %s', (from, to) => {
    if (from === to) {
      // Same-state sweeper "transitions" are a no-op, not an error.
      const result = transition(timers(from), { cause: 'sweeper', to, now: NOW, gracePeriodHours: GRACE_HOURS });
      expect(result.stateChanged).toBe(false);
      return;
    }
    expect(() =>
      transition(timers(from), { cause: 'sweeper', to, now: NOW, gracePeriodHours: GRACE_HOURS }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION', httpStatus: 409 }));
  });
});

describe('timers', () => {
  it('sets resolved_at and auto_close_at using the tenant grace period on entering resolved', () => {
    const result = transition(timers('open'), { cause: 'agent', to: 'resolved', now: NOW, gracePeriodHours: 48 });
    expect(result.changes.resolved_at).toEqual(NOW);
    expect(result.changes.auto_close_at).toEqual(new Date(NOW.getTime() + 48 * 3_600_000));
  });

  it('does not reset resolved_at/auto_close_at when already resolved', () => {
    const result = transition(timers('resolved', { resolvedAt: NOW, autoCloseAt: FUTURE }), {
      cause: 'agent',
      to: 'resolved',
      now: NOW,
      gracePeriodHours: GRACE_HOURS,
    });
    expect(result.changes).toEqual({});
  });

  it('clears auto_close_at when leaving resolved for closed', () => {
    const result = transition(timers('resolved', { resolvedAt: NOW, autoCloseAt: FUTURE }), {
      cause: 'agent',
      to: 'closed',
      now: NOW,
      gracePeriodHours: GRACE_HOURS,
    });
    expect(result.changes).toMatchObject({ auto_close_at: null, closed_at: NOW });
  });

  it('sets closed_at only when newly entering closed', () => {
    const result = transition(timers('closed', { closedAt: NOW }), {
      cause: 'agent',
      to: 'open',
      now: NOW,
      gracePeriodHours: GRACE_HOURS,
    });
    expect(result.changes.closed_at).toBeNull();
  });

  it('keeps pending_until only while pending: clears it when leaving a pending state', () => {
    const result = transition(timers('pending_reminder', { pendingUntil: FUTURE }), {
      cause: 'agent',
      to: 'resolved',
      now: NOW,
      gracePeriodHours: GRACE_HOURS,
    });
    expect(result.changes.pending_until).toBeNull();
  });
});
