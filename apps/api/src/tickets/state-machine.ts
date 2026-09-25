import { conflict, validationFailed } from '../platform-kernel/http/app-error.js';

import type { TicketOrigin, TicketState } from '../platform-kernel/db/tables/tickets.js';

/**
 * The ticket state machine (data-model.md "Ticket state machine", FR-033–FR-035). Pure: it takes
 * the ticket's current state and timers and returns the next state with the timer columns to
 * write, or throws 409 `INVALID_TRANSITION`. Callers persist the result, write history and
 * append the outbox events.
 *
 * Causes:
 * - `customer_message`: `new` stays `new` (nobody has replied yet); every other state moves to
 *   `open`. Whether a closed ticket may be reopened this way is the conversation router's call
 *   (`after_close_behavior`); the machine only allows it.
 * - `agent_reply`: the first public reply moves `new` to `open`; otherwise nothing changes.
 * - `agent`: an explicit state change, limited to the arrows of the diagram. Setting the current
 *   state again is a no-op, except for a pending state with a new date.
 * - `sweeper`: `pending_close` → `closed` when its date passes, `resolved` → `closed` when the
 *   grace period ends.
 *
 * Timers: entering `resolved` sets `resolved_at` and `auto_close_at` (+ grace period); leaving it
 * clears `auto_close_at`. Entering `closed` sets `closed_at`. Reopening (to `open` from
 * `resolved` or `closed`) clears `resolved_at` and `closed_at`, keeping group and owner, which the
 * machine never touches. `pending_until` is set only while in a pending state.
 */

export type TransitionCause = 'agent' | 'agent_reply' | 'customer_message' | 'sweeper';

export interface TicketTimers {
  state: TicketState;
  pendingUntil: Date | null;
  resolvedAt: Date | null;
  autoCloseAt: Date | null;
  closedAt: Date | null;
}

export interface TransitionInput {
  cause: TransitionCause;
  /** Target state; required for `agent` and `sweeper`, ignored otherwise. */
  to?: TicketState;
  /** Required when `to` is a pending state; must be later than `now`. */
  pendingUntil?: Date | null;
  now: Date;
  /** The tenant's grace period (FR-035), used when entering `resolved`. */
  gracePeriodHours: number;
}

/** Only the timer columns whose value changes. */
export interface TimerChanges {
  pending_until?: Date | null;
  resolved_at?: Date | null;
  auto_close_at?: Date | null;
  closed_at?: Date | null;
}

export interface TransitionResult {
  from: TicketState;
  state: TicketState;
  /** The state changed (a pending date change alone is not a state change). */
  stateChanged: boolean;
  changes: TimerChanges;
  /** `resolved` or `closed` → `open`. */
  reopened: boolean;
  closed: boolean;
}

const PENDING: ReadonlySet<TicketState> = new Set(['pending_reminder', 'pending_close']);

/** Explicit agent changes (the diagram's "agent" arrows). */
const AGENT_TARGETS: Readonly<Record<TicketState, readonly TicketState[]>> = {
  new: ['open', 'pending_reminder', 'pending_close', 'resolved'],
  open: ['pending_reminder', 'pending_close', 'resolved'],
  pending_reminder: ['open', 'resolved'],
  pending_close: ['open', 'resolved'],
  resolved: ['open', 'closed'],
  closed: ['open'],
};

const SWEEPER_TARGETS: Readonly<Record<TicketState, readonly TicketState[]>> = {
  new: [],
  open: [],
  pending_reminder: [],
  pending_close: ['closed'],
  resolved: ['closed'],
  closed: [],
};

const HOUR_MS = 3_600_000;

export function isPending(state: TicketState): boolean {
  return PENDING.has(state);
}

/** Staff-started tickets begin `open` (FR-038a); every other origin begins `new`. */
export function initialState(origin: TicketOrigin): TicketState {
  return origin === 'staff_started' ? 'open' : 'new';
}

export function invalidTransition(from: TicketState, to: TicketState) {
  return conflict('INVALID_TRANSITION', `A ${label(from)} ticket can't be set to ${label(to)}`);
}

function label(state: TicketState): string {
  return state.replace('_', ' ');
}

function targetFor(current: TicketState, input: TransitionInput): TicketState {
  switch (input.cause) {
    case 'customer_message':
      return current === 'new' ? 'new' : 'open';
    case 'agent_reply':
      return current === 'new' ? 'open' : current;
    case 'agent':
    case 'sweeper': {
      if (input.to === undefined) throw new Error(`A ${input.cause} transition needs a target state`);
      if (input.to === current) return current;
      const allowed = (input.cause === 'agent' ? AGENT_TARGETS : SWEEPER_TARGETS)[current];
      if (!allowed.includes(input.to)) throw invalidTransition(current, input.to);
      return input.to;
    }
  }
}

export function transition(current: TicketTimers, input: TransitionInput): TransitionResult {
  const from = current.state;
  const state = targetFor(from, input);
  const next: TimerChanges = {};

  if (isPending(state)) {
    // A new pending date is only taken from an explicit agent change.
    const settingPending = input.cause === 'agent' && input.to === state;
    if (settingPending) {
      const until = input.pendingUntil ?? null;
      if (until === null) throw validationFailed([{ path: 'pendingUntil', issue: 'required' }]);
      if (until.getTime() <= input.now.getTime()) throw validationFailed([{ path: 'pendingUntil', issue: 'too_small' }]);
      next.pending_until = until;
    }
  } else {
    next.pending_until = null;
  }

  if (state === 'resolved' && from !== 'resolved') {
    next.resolved_at = input.now;
    next.auto_close_at = new Date(input.now.getTime() + input.gracePeriodHours * HOUR_MS);
  }
  if (state !== 'resolved') next.auto_close_at = null;
  if (state === 'closed' && from !== 'closed') next.closed_at = input.now;

  const reopened = state === 'open' && (from === 'resolved' || from === 'closed');
  if (state === 'open') {
    next.resolved_at = null;
    next.closed_at = null;
  }

  return {
    from,
    state,
    stateChanged: state !== from,
    changes: onlyChanged(current, next),
    reopened,
    closed: state === 'closed' && from !== 'closed',
  };
}

function onlyChanged(current: TicketTimers, next: TimerChanges): TimerChanges {
  const existing: Record<keyof TimerChanges, Date | null> = {
    pending_until: current.pendingUntil,
    resolved_at: current.resolvedAt,
    auto_close_at: current.autoCloseAt,
    closed_at: current.closedAt,
  };
  const result: TimerChanges = {};
  for (const key of Object.keys(next) as (keyof TimerChanges)[]) {
    const value = next[key] ?? null;
    if ((value?.getTime() ?? null) !== (existing[key]?.getTime() ?? null)) result[key] = value;
  }
  return result;
}
