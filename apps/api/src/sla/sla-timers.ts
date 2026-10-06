import { isPending } from '../tickets/state-machine.js';

import type { BusinessCalendar } from './business-calendar.js';
import type { SlaStatus, SlaTarget } from '../platform-kernel/db/tables/sla.js';
import type { TicketState } from '../platform-kernel/db/tables/tickets.js';

/**
 * SLA timer arithmetic (research D15). Pure: no database, clock or Nest; `now` and `at` are passed
 * in. `SlaRecomputeService` loads the facts, calls `computeSlaTimes` and stores the result;
 * the sweeper uses `slaStatus`.
 *
 * - Due = anchor + the target's business minutes on the policy's calendar; warn = anchor +
 *   `minutes * warning_percent / 100` (rounded to a whole minute, at least 1 for percent >= 50).
 * - `first_response`: anchored at ticket creation (so time spent ungrouped counts, FR-085); runs
 *   until the first public staff reply (`tickets.first_agent_reply_at`).
 * - `next_response`: runs from the first customer message that follows the last staff reply
 *   (later customer messages keep it, they don't restart it) until the next public staff reply.
 *   It only exists after the first reply: before that, `first_response` covers the customer.
 * - `resolution`: anchored at creation; stops when the ticket is resolved or closed. A pending
 *   state pauses it (`paused_since`); leaving the state moves the due and warn times later by the
 *   business minutes spent paused. Response targets are never paused.
 * - A resolved or closed ticket has no running timers (all times null, status `ok`).
 */

export const SLA_TARGETS: readonly SlaTarget[] = ['first_response', 'next_response', 'resolution'];

export interface TargetTimes {
  dueAt: Date | null;
  warnAt: Date | null;
}

export interface SlaTimes {
  firstResponse: TargetTimes;
  nextResponse: TargetTimes;
  resolution: TargetTimes;
  /** Set while a pending state pauses the resolution timer. */
  pausedSince: Date | null;
}

export interface PolicyMinutes {
  id: string;
  firstResponseMinutes: number | null;
  nextResponseMinutes: number | null;
  resolutionMinutes: number | null;
  warningPercent: number;
}

export interface TimerFacts {
  createdAt: Date;
  state: TicketState;
  firstAgentReplyAt: Date | null;
}

export interface ExistingSla extends SlaTimes {
  policyId: string;
}

export interface ComputeInput {
  policy: PolicyMinutes;
  calendar: BusinessCalendar;
  ticket: TimerFacts;
  /** Earliest public customer message after the last public staff reply; null when none waits. */
  unansweredSince: Date | null;
  /** When the triggering change happened (pause start and resume instants). */
  at: Date;
  existing: ExistingSla | undefined;
  /**
   * Rebuild the resolution times from the ticket's creation instead of keeping the stored ones
   * (a policy or calendar was edited). Pauses already served are not re-applied.
   */
  reset?: boolean;
}

export const NO_TIMES: TargetTimes = { dueAt: null, warnAt: null };

export function targetTimes(calendar: BusinessCalendar, anchor: Date, minutes: number, warningPercent: number): TargetTimes {
  return {
    dueAt: calendar.addBusinessMinutes(anchor, minutes),
    warnAt: calendar.addBusinessMinutes(anchor, Math.round((minutes * warningPercent) / 100)),
  };
}

export function isCompleted(state: TicketState): boolean {
  return state === 'resolved' || state === 'closed';
}

export function computeSlaTimes(input: ComputeInput): SlaTimes {
  const { policy, calendar, ticket, existing } = input;
  if (isCompleted(ticket.state)) {
    return { firstResponse: NO_TIMES, nextResponse: NO_TIMES, resolution: NO_TIMES, pausedSince: null };
  }

  const firstResponse =
    policy.firstResponseMinutes !== null && ticket.firstAgentReplyAt === null
      ? targetTimes(calendar, ticket.createdAt, policy.firstResponseMinutes, policy.warningPercent)
      : NO_TIMES;

  const nextResponse =
    policy.nextResponseMinutes !== null && ticket.firstAgentReplyAt !== null && input.unansweredSince !== null
      ? targetTimes(calendar, input.unansweredSince, policy.nextResponseMinutes, policy.warningPercent)
      : NO_TIMES;

  if (policy.resolutionMinutes === null) {
    return { firstResponse, nextResponse, resolution: NO_TIMES, pausedSince: null };
  }

  const kept =
    input.reset !== true && existing !== undefined && existing.policyId === policy.id && existing.resolution.dueAt !== null
      ? existing.resolution
      : undefined;
  let resolution = kept ?? targetTimes(calendar, ticket.createdAt, policy.resolutionMinutes, policy.warningPercent);

  const wasPausedSince = existing?.pausedSince ?? null;
  let pausedSince: Date | null = null;
  if (isPending(ticket.state)) {
    pausedSince = wasPausedSince ?? input.at;
  } else if (wasPausedSince !== null && kept !== undefined && kept.dueAt !== null && kept.warnAt !== null) {
    const paused = calendar.businessMinutesBetween(wasPausedSince, input.at);
    if (paused > 0) {
      resolution = { dueAt: calendar.addBusinessMinutes(kept.dueAt, paused), warnAt: calendar.addBusinessMinutes(kept.warnAt, paused) };
    }
  }
  return { firstResponse, nextResponse, resolution, pausedSince };
}

/** The worst state over the targets that are running now (a paused resolution doesn't count). */
export function slaStatus(times: SlaTimes, now: Date): SlaStatus {
  const active: TargetTimes[] = [times.firstResponse, times.nextResponse];
  if (times.pausedSince === null) active.push(times.resolution);
  let status: SlaStatus = 'ok';
  for (const target of active) {
    if (target.dueAt !== null && target.dueAt.getTime() <= now.getTime()) return 'breached';
    if (target.warnAt !== null && target.warnAt.getTime() <= now.getTime()) status = 'warning';
  }
  return status;
}
