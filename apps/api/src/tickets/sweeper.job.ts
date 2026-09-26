import { Inject, Injectable, Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';

import { lockCustomer, stateChanges, timersOf } from '../messaging/customer-message-router.js';
import { Clock } from '../platform-kernel/clock.js';
import { PLATFORM_DB, type Database } from '../platform-kernel/db/database.js';
import { TenantContext } from '../platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../platform-kernel/ids.js';
import { JobProcessor } from '../platform-kernel/jobs/job-processor.js';
import { QueueRegistry } from '../platform-kernel/jobs/queues.js';
import { OutboxService } from '../platform-kernel/outbox/outbox.service.js';
import { TenantSettingsRepository } from '../tenancy/tenant-settings.js';

import { transition } from './state-machine.js';
import { groupStream, summaryOf, ticketStream } from './ticket-events.js';
import { TicketHistoryService } from './ticket-history.service.js';
import { TICKET_COLUMNS, TicketsRepository, type TicketRow } from './tickets.repository.js';

import type { TicketState } from '../platform-kernel/db/tables/tickets.js';
import type { ExpressionBuilder, Kysely } from 'kysely';

/**
 * The timer sweeper (T144, research D11, FR-034): a BullMQ repeatable job every 30 s that finds
 * due timers with `FOR UPDATE SKIP LOCKED`, in batches, across every tenant, and processes each
 * row in its own tenant unit of work.
 *
 * - `pending_reminder` past `pending_until` → `ticket.reminder_reached`, state unchanged. Fires
 *   once per date (`tickets.reminder_notified_at`, migration 0009c): a due row is skipped once
 *   already notified for its current `pending_until`, and re-armed the moment a later date is set
 *   (a transition never moves `pending_until` backwards, so a stale notified time always compares
 *   before the new one — no separate clearing needed elsewhere).
 * - `pending_close` past `pending_until`, or `resolved` past `auto_close_at` (the grace period) →
 *   close, reusing `state-machine.ts` and the same steps `CustomerMessageRouter.closeExpired`
 *   takes for a resolved ticket found expired mid-routing: `transition(cause: 'sweeper')`, update,
 *   `ticket.updated` + `ticket.closed`, history as `system`.
 * - Every close takes the customer's advisory lock (`lockCustomer`, D10) **before** locking the
 *   ticket row, the same order `CustomerMessageRouter.accept` uses (advisory lock, then row
 *   locks) — reversing it would deadlock the two. The row is re-locked and its due-ness re-checked
 *   under the lock, so a customer message racing an auto-close lands on exactly one ticket.
 *
 * Batches are discovered per tenant with a plain (lock-free) scan; each candidate id is then
 * re-locked (`FOR UPDATE SKIP LOCKED`) and re-checked in its own transaction, so a slow row or a
 * concurrent sweeper replica never blocks the rest of the batch, and a row already claimed
 * elsewhere is skipped rather than waited on.
 */

const SWEEP_INTERVAL_MS = 30_000;
const BATCH_SIZE = 200;

type RawTicketRow = Omit<TicketRow, 'number'> & { number: string };

function toTicketRow(row: RawTicketRow): TicketRow {
  return { ...row, number: Number(row.number) };
}

/** `pending_reminder`/`pending_close` past `pending_until`, or `resolved` past `auto_close_at`. */
function dueFilter(now: Date) {
  return (eb: ExpressionBuilder<Database, 'tickets'>) =>
    eb.or([
      eb.and([
        eb('tickets.state', '=', 'pending_reminder' as const),
        eb('tickets.pending_until', '<=', now),
        eb.or([eb('tickets.reminder_notified_at', 'is', null), eb('tickets.reminder_notified_at', '<', eb.ref('tickets.pending_until'))]),
      ]),
      eb.and([eb('tickets.state', '=', 'pending_close' as const), eb('tickets.pending_until', '<=', now)]),
      eb.and([eb('tickets.state', '=', 'resolved' as const), eb('tickets.auto_close_at', '<=', now)]),
    ]);
}

class SweeperRepository extends TenantRepository {
  /** Candidate ids for this tenant's batch; a lock-free scan, re-checked per row before acting. */
  async dueCandidates(tx: TenantTransaction, now: Date, limit: number): Promise<string[]> {
    const rows = await this.selectFrom(tx, 'tickets').select('tickets.id').where(dueFilter(now)).orderBy('tickets.id').limit(limit).execute();
    return rows.map((row) => row.id);
  }

  /** Enough to route to the right branch and, for a close, know which customer to lock. No row lock yet. */
  async peek(tx: TenantTransaction, id: string, now: Date): Promise<{ state: TicketState; customerId: string } | undefined> {
    const row = await this.selectFrom(tx, 'tickets')
      .select(['tickets.state', 'tickets.customer_id'])
      .where('tickets.id', '=', id)
      .where(dueFilter(now))
      .executeTakeFirst();
    return row === undefined ? undefined : { state: row.state, customerId: row.customer_id };
  }

  /** Re-locks and re-checks one candidate; `undefined` if another sweeper claimed it or it moved on. */
  async claim(tx: TenantTransaction, id: string, now: Date): Promise<TicketRow | undefined> {
    const row = await this.selectFrom(tx, 'tickets')
      .select(TICKET_COLUMNS)
      .where('tickets.id', '=', id)
      .where(dueFilter(now))
      .forUpdate()
      .skipLocked()
      .executeTakeFirst();
    return row === undefined ? undefined : toTicketRow(row);
  }

  async markReminderNotified(tx: TenantTransaction, id: string, now: Date): Promise<void> {
    await this.updateTable(tx, 'tickets').set({ reminder_notified_at: now }).where('tickets.id', '=', id).execute();
  }
}

@Injectable()
export class TicketSweeperJob extends JobProcessor implements OnApplicationBootstrap {
  readonly queue = 'sweeper' as const;
  readonly jobName = 'ticket-sweep';
  private readonly logger = new Logger('TicketSweeperJob');

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    private readonly history: TicketHistoryService,
    private readonly queues: QueueRegistry,
    @Inject(PLATFORM_DB) private readonly platformDb: Kysely<Database>,
  ) {
    super();
  }

  /** Schedules the repeatable job; BullMQ dedupes by name + repeat options, safe on every boot. */
  async onApplicationBootstrap(): Promise<void> {
    await this.queues.get(this.queue).add(this.jobName, {}, { jobId: this.jobName, repeat: { every: SWEEP_INTERVAL_MS } });
  }

  async process(): Promise<void> {
    const now = this.clock.now();
    const tenants = await this.platformDb.selectFrom('tenants').select('id').where('status', '=', 'active').execute();
    for (const { id: tenantId } of tenants) {
      await this.sweepTenant(tenantId, now);
    }
  }

  private async sweepTenant(tenantId: string, now: Date): Promise<void> {
    const ctx = TenantContext.create({ tenantId, actor: { kind: 'system' }, requestId: `sweeper:${uuidv7()}` });
    let ids: string[];
    try {
      ids = await this.unitOfWork.withTenant(ctx, (tx) => new SweeperRepository(ctx).dueCandidates(tx, now, BATCH_SIZE));
    } catch (error) {
      this.logger.error(`Sweeper scan failed for tenant ${tenantId}: ${error instanceof Error ? error.message : 'unknown'}`);
      return;
    }
    for (const ticketId of ids) {
      try {
        await this.sweepTicket(ctx, ticketId, now);
      } catch (error) {
        this.logger.error(`Sweeper failed for ticket ${ticketId}: ${error instanceof Error ? error.message : 'unknown'}`);
      }
    }
  }

  private async sweepTicket(ctx: TenantContext, ticketId: string, now: Date): Promise<void> {
    await this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new SweeperRepository(ctx);
      const peeked = await repo.peek(tx, ticketId, now);
      if (peeked === undefined) return; // no longer due: another sweeper already handled it, or it moved on

      if (peeked.state === 'pending_reminder') {
        const ticket = await repo.claim(tx, ticketId, now);
        if (ticket === undefined) return; // claimed by a concurrent sweeper replica
        await repo.markReminderNotified(tx, ticket.id, now);
        await this.outbox.append(tx, {
          type: 'ticket.reminder_reached',
          payload: { ticketId: ticket.id, ownerId: ticket.owner_id },
          streams: [ticketStream(ticket.id)],
        });
        return;
      }

      // `pending_close` due, or `resolved` past its grace period: the advisory lock first, in the
      // same order `CustomerMessageRouter.accept` takes it, then the row, re-checked under it.
      await lockCustomer(tx, ctx.tenantId, peeked.customerId);
      const ticket = await repo.claim(tx, ticketId, now);
      if (ticket === undefined) return;

      const settings = await new TenantSettingsRepository(ctx).conversation(tx);
      const moved = transition(timersOf(ticket), { cause: 'sweeper', to: 'closed', now, gracePeriodHours: settings.gracePeriodHours });
      const row = await new TicketsRepository(ctx).update(tx, ticket.id, { state: moved.state, ...moved.changes });
      const changes = stateChanges(ticket, moved);
      const eventId = await this.outbox.append(tx, {
        type: 'ticket.updated',
        payload: { ticket: await summaryOf(ctx, tx, row), changes },
        streams: [ticketStream(row.id), groupStream(row.group_id)],
      });
      await this.outbox.append(tx, { type: 'ticket.closed', payload: { ticketId: row.id }, streams: [ticketStream(row.id)] });
      await this.history.record(tx, row.id, changes, { eventId, actorKind: 'system' });
    });
  }
}

/** Worker-only: the sweeper (jobs.module.ts discovers `TicketSweeperJob` and routes its queue). */
@Module({ providers: [TicketSweeperJob] })
export class TicketSweeperModule {}
