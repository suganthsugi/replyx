import { sql, type Kysely } from 'kysely';
import { vi } from 'vitest';

import { PLATFORM_DB, type Database } from '../../src/platform-kernel/db/database.js';
import { TenantContext } from '../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../src/platform-kernel/db/unit-of-work.js';
import { QueueRegistry } from '../../src/platform-kernel/jobs/queues.js';
import { OutboxService } from '../../src/platform-kernel/outbox/outbox.service.js';
import { TagsService } from '../../src/tags/tags.service.js';
import { AccessLossConsumer } from '../../src/tickets/access-loss.consumer.js';
import { TicketSweeperJob } from '../../src/tickets/sweeper.job.js';
import { TicketHistoryService } from '../../src/tickets/ticket-history.service.js';

import { getTestApp, getTestWorker, service } from './app.js';

import type { Clock } from '../../src/platform-kernel/clock.js';


/**
 * Drives worker-only job classes directly, the way test/integration/attachments/attachments.test.ts
 * drives AttachmentScanConsumer: no BullMQ worker needed, so the timing is entirely in the test's
 * hands (TestClock, then one direct call).
 */

export async function accessLossConsumer(): Promise<AccessLossConsumer> {
  const [unitOfWork, outbox, history, tags] = await Promise.all([
    service(UnitOfWork),
    service(OutboxService),
    service(TicketHistoryService),
    service(TagsService),
  ]);
  return new AccessLossConsumer(unitOfWork, outbox, history, tags);
}

/** Runs the access-loss consumer over the latest event of `type` for the tenant. */
export async function runAccessLoss(tenantId: string, type: string): Promise<void> {
  const eventId = await latestEventId(tenantId, type);
  const consumer = await accessLossConsumer();
  const result = await consumer.process({ tenantId, eventId }, 'test-job');
  if (result !== 'handled') throw new Error(`Access-loss consumer did not run ${type}: ${result}`);
}

/** `sweeperClock` overrides the sweeper's own view of time (default: the app's TestClock), to stage a sweeper that sees a timer as due before the router does. */
export async function sweeperJob(sweeperClock?: Clock): Promise<TicketSweeperJob> {
  const { app, clock } = await getTestApp();
  const [unitOfWork, outbox, history, queues] = await Promise.all([
    service(UnitOfWork),
    service(OutboxService),
    service(TicketHistoryService),
    service(QueueRegistry),
  ]);
  const platformDb = app.get<Kysely<Database>>(PLATFORM_DB);
  return new TicketSweeperJob(unitOfWork, outbox, sweeperClock ?? clock, history, queues, platformDb);
}

class LatestEventRepository extends TenantRepository {
  latest(tx: TenantTransaction, type: string) {
    return this.selectFrom(tx, 'outbox_events').select('id').where('type', '=', type).orderBy('id', 'desc').limit(1).executeTakeFirst();
  }

  countByType(tx: TenantTransaction, type: string) {
    return this.selectFrom(tx, 'outbox_events')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('type', '=', type)
      .executeTakeFirstOrThrow();
  }
}

export async function latestEventId(tenantId: string, type: string): Promise<string> {
  const ctx = TenantContext.create({ tenantId, actor: { kind: 'system' }, requestId: 'test-latest-event' });
  const unitOfWork = await service(UnitOfWork);
  const row = await unitOfWork.withTenant(ctx, (tx) => new LatestEventRepository(ctx).latest(tx, type));
  if (row === undefined) throw new Error(`No "${type}" event found for tenant ${tenantId}`);
  return row.id;
}

export async function countEventsOfType(tenantId: string, type: string): Promise<number> {
  const ctx = TenantContext.create({ tenantId, actor: { kind: 'system' }, requestId: 'test-count-events' });
  const unitOfWork = await service(UnitOfWork);
  const row = await unitOfWork.withTenant(ctx, (tx) => new LatestEventRepository(ctx).countByType(tx, type));
  return Number(row.count);
}

/**
 * Starts the worker (relay) and waits until no outbox event, in any tenant, is unpublished. The
 * outbox is database-wide and shared by every file in a run, so a file that appends many events
 * without a worker leaves a backlog the next file's relay must chew through (id order, 500 per
 * batch, one BullMQ job per consumer) before its own events are delivered.
 */
export async function drainOutbox(timeoutMs = 120_000): Promise<void> {
  await getTestWorker();
  const { app } = await getTestApp();
  const platformDb = app.get<Kysely<Database>>(PLATFORM_DB);
  await vi.waitFor(
    async () => {
      const { rows } = await sql<{ count: string }>`SELECT count(*) AS count FROM outbox_events WHERE published_at IS NULL`.execute(platformDb);
      if (Number(rows[0]?.count ?? 0) !== 0) throw new Error('outbox backlog not drained');
    },
    { timeout: timeoutMs, interval: 250 },
  );
}
