import { Injectable, Logger } from '@nestjs/common';
import { ZodError } from 'zod';

import { Clock } from '../platform-kernel/clock.js';
import { tenantScopeOf, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { OutboxService } from '../platform-kernel/outbox/outbox.service.js';
import { groupStream, ticketStream } from '../tickets/ticket-events.js';

import { BusinessCalendarError } from './business-calendar.js';
import { businessHoursRowToCalendar } from './business-hours.mapper.js';
import { firstMatchingPolicy } from './policy-matching.js';
import { computeSlaTimes, isCompleted, slaStatus, type SlaTimes, type TargetTimes } from './sla-timers.js';
import { SlaRepository, type StoredSla } from './sla.repository.js';

import type { SlaStatus } from '../platform-kernel/db/tables/sla.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

export type RecomputeOutcome = 'created' | 'updated' | 'unchanged' | 'removed' | 'skipped';

export interface RecomputeOptions {
  /** When the change that triggered the recompute happened; defaults to now. Never later than now. */
  at?: Date;
  /** Rebuild the resolution times from creation (a policy or its business hours were edited). */
  reset?: boolean;
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  return a === null || b === null ? a === b : a.getTime() === b.getTime();
}

function sameTarget(a: TargetTimes, b: TargetTimes): boolean {
  return sameInstant(a.dueAt, b.dueAt) && sameInstant(a.warnAt, b.warnAt);
}

function sameTimes(a: SlaTimes, b: SlaTimes): boolean {
  return (
    sameTarget(a.firstResponse, b.firstResponse) &&
    sameTarget(a.nextResponse, b.nextResponse) &&
    sameTarget(a.resolution, b.resolution) &&
    sameInstant(a.pausedSince, b.pausedSince)
  );
}

/**
 * Recomputes one ticket's `ticket_sla` row from its current facts (research D15, T223): picks the
 * first matching policy, computes the due and warn times on that policy's calendar and stores the
 * row, or removes it when no policy applies. Always computed from the ticket's current state, so
 * events processed late or out of order converge on the same row. Public: the SLA consumer calls
 * it per event, and the policy and business-hours admin services (T224) call it with
 * `reset: true` for open tickets after an edit.
 *
 * Runs in the caller's transaction (`tx` from `withTenant`), so the row and the `sla.updated`
 * outbox event commit together. Recomputes of one ticket serialize on an advisory lock.
 */
@Injectable()
export class SlaRecomputeService {
  private readonly logger = new Logger('SlaRecomputeService');

  constructor(
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  async recompute(tx: TenantTransaction, ticketId: string, options: RecomputeOptions = {}): Promise<RecomputeOutcome> {
    const ctx = this.requireScope(tx);
    const repo = new SlaRepository(ctx);
    await repo.lockTicket(tx, ticketId);

    const ticket = await repo.ticket(tx, ticketId);
    if (ticket === undefined) return 'skipped'; // deleted meanwhile (the FK cascade removed its row)
    const stored = await repo.stored(tx, ticketId);

    const policy = firstMatchingPolicy(await repo.policies(tx), { priority: ticket.priority, groupId: ticket.groupId });
    if (policy === undefined) {
      if (stored === undefined) return 'skipped';
      await repo.remove(tx, ticketId);
      await this.announce(tx, ticket.id, ticket.groupId, 'none', stored.status);
      return 'removed';
    }

    const now = this.clock.now();
    const at = options.at !== undefined && options.at.getTime() < now.getTime() ? options.at : now;

    let times: SlaTimes;
    try {
      const hours = await repo.businessHours(tx, policy.businessHoursId);
      if (hours === undefined) throw new BusinessCalendarError('Business hours not found');
      const completed = isCompleted(ticket.state);
      const waitsForNext = !completed && policy.nextResponseMinutes !== null && ticket.firstAgentReplyAt !== null;
      times = computeSlaTimes({
        policy,
        calendar: businessHoursRowToCalendar(hours),
        ticket: { createdAt: ticket.createdAt, state: ticket.state, firstAgentReplyAt: ticket.firstAgentReplyAt },
        unansweredSince: waitsForNext ? await repo.unansweredSince(tx, ticket.id, ticket.lastAgentReplyAt) : null,
        at,
        existing: stored,
        ...(options.reset === true ? { reset: true } : {}),
      });
    } catch (error) {
      if (!(error instanceof BusinessCalendarError) && !(error instanceof ZodError)) throw error;
      // An unusable calendar (no intervals, every day a holiday) can't be retried into working:
      // leave the row as it is and say so, without failing the job.
      this.logger.warn(`SLA skipped for ticket ${ticket.id}: policy ${policy.id} has an unusable business-hours calendar`);
      return 'skipped';
    }

    const status = slaStatus(times, now);
    if (stored === undefined) {
      if (isCompleted(ticket.state)) return 'skipped'; // nothing ever ran for it
      await repo.insert(tx, ticket.id, policy.id, times, status);
      await this.announce(tx, ticket.id, ticket.groupId, status, 'none');
      return 'created';
    }
    if (stored.policyId === policy.id && stored.status === status && sameTimes(stored, times)) return 'unchanged';
    await repo.update(tx, ticket.id, policy.id, times, status);
    await this.announce(tx, ticket.id, ticket.groupId, status, stored.status);
    return 'updated';
  }

  private async announce(tx: TenantTransaction, ticketId: string, groupId: string | null, status: SlaStatus | 'none', previousStatus: StoredSla['status'] | 'none'): Promise<void> {
    await this.outbox.append(tx, {
      type: 'sla.updated',
      payload: { ticketId, status, previousStatus },
      streams: [ticketStream(ticketId), groupStream(groupId)],
    });
  }

  private requireScope(tx: TenantTransaction): TenantContext {
    const ctx = tenantScopeOf(tx);
    if (ctx === undefined) throw new Error('SlaRecomputeService must run inside withTenant');
    return ctx;
  }
}

