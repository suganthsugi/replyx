import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely';

import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { groupStream, ticketStream } from '../tickets/ticket-events.js';

import { slaStatus, SLA_TARGETS, type SlaTimes, type TargetTimes } from './sla-timers.js';

import type { Database } from '../platform-kernel/db/database.js';
import type { SlaEventKind, SlaStatus, SlaTarget } from '../platform-kernel/db/tables/sla.js';
import type { TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import type { OutboxService } from '../platform-kernel/outbox/outbox.service.js';

/**
 * The SLA half of the timer sweeper (T223, research D11 step 5 and D15; called by
 * `tickets/sweeper.job.ts` every 30 s, per tenant, after the ticket timers).
 *
 * - Candidates (`SlaSweepRepository.candidates`): running `ticket_sla` rows of tickets that are
 *   not resolved or closed where a warn or due time has passed and either no `sla_events` row
 *   exists for it yet, or the stored `status` is behind the clock. A paused resolution target
 *   (`paused_since`) does not count; response targets are never paused.
 * - `emitSlaEvents` re-locks the row (`FOR UPDATE OF ticket_sla SKIP LOCKED`, so a concurrent
 *   sweeper replica or recompute skips or waits) and, per target, inserts the `sla_events` row
 *   with `ON CONFLICT DO NOTHING`; the outbox event (`sla.warning` / `sla.breached`) is appended
 *   only when that insert happened, in the same transaction, so each fires exactly once even with
 *   concurrent sweeps. The row's `occurred_at` is the exact warn or due instant (research D11),
 *   not the sweep time.
 * - When a target's due time has also passed at the first sweep that sees it (the sweeper was
 *   down, or a policy change made it overdue), only the breach is announced: the warning row is
 *   recorded so it can't fire later, without an event.
 * - `ticket_sla.status` is set from the times and the clock; events go to `ticket:{id}` and the
 *   ticket's `tickets:group:*` room, which notifications and the view counts consume.
 */

const COLUMNS = {
  first_response: { due: 'ticket_sla.first_response_due_at', warn: 'ticket_sla.first_response_warn_at' },
  next_response: { due: 'ticket_sla.next_response_due_at', warn: 'ticket_sla.next_response_warn_at' },
  resolution: { due: 'ticket_sla.resolution_due_at', warn: 'ticket_sla.resolution_warn_at' },
} as const;

type SlaExpressionBuilder = ExpressionBuilder<Database, 'ticket_sla'>;

/** `warn`/`due` of a running target has passed. */
function passed(eb: SlaExpressionBuilder, target: SlaTarget, kind: 'warn' | 'due', now: Date): Expression<SqlBool> {
  const column = COLUMNS[target][kind];
  const crossed = eb(column, '<=', now);
  return target === 'resolution' ? eb.and([crossed, eb('ticket_sla.paused_since', 'is', null)]) : crossed;
}

/** No `sla_events` row yet for this ticket, target and kind. */
function notYetRecorded(eb: SlaExpressionBuilder, target: SlaTarget, kind: SlaEventKind): Expression<SqlBool> {
  return eb.not(
    eb.exists(
      eb
        .selectFrom('sla_events')
        .select(sql.lit(1).as('one'))
        .whereRef('sla_events.tenant_id', '=', 'ticket_sla.tenant_id')
        .whereRef('sla_events.ticket_id', '=', 'ticket_sla.ticket_id')
        .where('sla_events.target', '=', target)
        .where('sla_events.kind', '=', kind),
    ),
  );
}

export interface SlaSweepRow extends SlaTimes {
  status: SlaStatus;
  groupId: string | null;
}

export class SlaSweepRepository extends TenantRepository {
  /** Ticket ids with something to emit or a stale status; a lock-free scan, re-checked per row. */
  async candidates(tx: TenantTransaction, now: Date, limit: number): Promise<string[]> {
    const rows = await this.selectFrom(tx, 'ticket_sla')
      .innerJoin('tickets', (join) => join.onRef('tickets.tenant_id', '=', 'ticket_sla.tenant_id').onRef('tickets.id', '=', 'ticket_sla.ticket_id'))
      .select('ticket_sla.ticket_id')
      .where('tickets.state', 'not in', ['resolved', 'closed'])
      .where((eb) =>
        eb.or([
          ...SLA_TARGETS.flatMap((target) => [
            eb.and([passed(eb, target, 'warn', now), notYetRecorded(eb, target, 'warning')]),
            eb.and([passed(eb, target, 'due', now), notYetRecorded(eb, target, 'breached')]),
          ]),
          eb.and([eb('ticket_sla.status', '=', 'ok'), eb.or(SLA_TARGETS.map((target) => passed(eb, target, 'warn', now)))]),
          eb.and([eb('ticket_sla.status', '<>', 'breached'), eb.or(SLA_TARGETS.map((target) => passed(eb, target, 'due', now)))]),
        ]),
      )
      .orderBy('ticket_sla.ticket_id')
      .limit(limit)
      .execute();
    return rows.map((row) => row.ticket_id);
  }

  /** Locks the row; `undefined` if another worker holds it, it is gone, or the ticket is done. */
  async claim(tx: TenantTransaction, ticketId: string): Promise<SlaSweepRow | undefined> {
    const row = await this.selectFrom(tx, 'ticket_sla')
      .innerJoin('tickets', (join) => join.onRef('tickets.tenant_id', '=', 'ticket_sla.tenant_id').onRef('tickets.id', '=', 'ticket_sla.ticket_id'))
      .select([
        'ticket_sla.status',
        'ticket_sla.paused_since',
        'ticket_sla.first_response_due_at',
        'ticket_sla.first_response_warn_at',
        'ticket_sla.next_response_due_at',
        'ticket_sla.next_response_warn_at',
        'ticket_sla.resolution_due_at',
        'ticket_sla.resolution_warn_at',
        'tickets.group_id',
        'tickets.state',
      ])
      .where('ticket_sla.ticket_id', '=', ticketId)
      .forUpdate('ticket_sla')
      .skipLocked()
      .executeTakeFirst();
    if (row === undefined || row.state === 'resolved' || row.state === 'closed') return undefined;
    return {
      status: row.status,
      groupId: row.group_id,
      pausedSince: row.paused_since,
      firstResponse: { dueAt: row.first_response_due_at, warnAt: row.first_response_warn_at },
      nextResponse: { dueAt: row.next_response_due_at, warnAt: row.next_response_warn_at },
      resolution: { dueAt: row.resolution_due_at, warnAt: row.resolution_warn_at },
    };
  }

  /** True when this call recorded the event, false when it already existed (a concurrent sweep). */
  async record(tx: TenantTransaction, ticketId: string, target: SlaTarget, kind: SlaEventKind, occurredAt: Date): Promise<boolean> {
    const inserted = await this.insertInto(tx, 'sla_events', { ticket_id: ticketId, target, kind, occurred_at: occurredAt })
      .onConflict((oc) => oc.columns(['tenant_id', 'ticket_id', 'target', 'kind']).doNothing())
      .returning('sla_events.id')
      .executeTakeFirst();
    return inserted !== undefined;
  }

  async setStatus(tx: TenantTransaction, ticketId: string, status: SlaStatus): Promise<void> {
    await this.updateTable(tx, 'ticket_sla').set({ status }).where('ticket_sla.ticket_id', '=', ticketId).execute();
  }
}

function timesOf(row: SlaSweepRow, target: SlaTarget): TargetTimes {
  return target === 'first_response' ? row.firstResponse : target === 'next_response' ? row.nextResponse : row.resolution;
}

/**
 * Records and announces every warning and breach that has come due for one ticket. Call inside
 * `withTenant`; returns the number of events appended.
 */
export async function emitSlaEvents(repo: SlaSweepRepository, outbox: OutboxService, tx: TenantTransaction, ticketId: string, now: Date): Promise<number> {
  const row = await repo.claim(tx, ticketId);
  if (row === undefined) return 0;

  let emitted = 0;
  const streams = [ticketStream(ticketId), groupStream(row.groupId)];
  for (const target of SLA_TARGETS) {
    if (target === 'resolution' && row.pausedSince !== null) continue;
    const { dueAt, warnAt } = timesOf(row, target);
    const overdue = dueAt !== null && dueAt.getTime() <= now.getTime();

    if (warnAt !== null && warnAt.getTime() <= now.getTime() && dueAt !== null) {
      const recorded = await repo.record(tx, ticketId, target, 'warning', warnAt);
      if (recorded && !overdue) {
        await outbox.append(tx, { type: 'sla.warning', payload: { ticketId, target, dueAt: dueAt.toISOString() }, streams });
        emitted += 1;
      }
    }
    if (overdue) {
      const recorded = await repo.record(tx, ticketId, target, 'breached', dueAt);
      if (recorded) {
        await outbox.append(tx, { type: 'sla.breached', payload: { ticketId, target, dueAt: dueAt.toISOString() }, streams });
        emitted += 1;
      }
    }
  }

  const status = slaStatus(row, now);
  if (status !== row.status) await repo.setStatus(tx, ticketId, status);
  return emitted;
}
