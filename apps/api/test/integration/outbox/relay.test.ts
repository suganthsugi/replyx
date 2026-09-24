import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { bumpAccessVersion } from '../../../src/authorization/access-version.js';
import { createDatabase, type Database } from '../../../src/platform-kernel/db/database.js';
import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { JobRouter } from '../../../src/platform-kernel/jobs/jobs.module.js';
import { QueueRegistry } from '../../../src/platform-kernel/jobs/queues.js';
import { OutboxService } from '../../../src/platform-kernel/outbox/outbox.service.js';
import { OutboxRelay } from '../../../src/platform-kernel/outbox/relay.js';
import { service } from '../../support/app.js';
import { createTenant, createUser, setGroupAccess, type TestTenant } from '../../support/factories.js';
import { connectSocket } from '../../support/socket.js';

/**
 * The outbox relay and `sync` catch-up (research D7, D8; realtime-events "Tests that must
 * exist"). Relays are built directly so the test controls leadership and publishing.
 */

const metrics = { realtimeDeliveryLag: { record: vi.fn() }, outboxRelayLag: { record: vi.fn() } };
const CONSUMER = 'relay_test';

let platformDb: Kysely<Database>;
let queues: QueueRegistry;
let router: JobRouter;
let relays: OutboxRelay[] = [];
let unitOfWork: UnitOfWork;
let tenant: TestTenant;
const outbox = new OutboxService();

/** A relay that publishes only when the test calls `drain` (no leader loop). */
function newRelay(): OutboxRelay {
  const relay = new OutboxRelay(platformDb, router, queues, metrics as never);
  relay.start();
  relays.push(relay);
  return relay;
}

function ctxFor(t: { id: string }): TenantContext {
  return TenantContext.create({ tenantId: t.id, actor: { kind: 'system' }, requestId: 'relay-test' });
}

function appendChanged(tx: TenantTransaction, reason: string): Promise<string> {
  return outbox.append(tx, { type: 'access.changed', payload: { accessVersion: '0', reason }, streams: ['tenant'] });
}

async function rowsFor(ids: string[]): Promise<{ id: string; seq: string | null; published: boolean }[]> {
  const result = await sql<{ id: string; seq: string | null; published: boolean }>`
    SELECT id, seq::text AS seq, published_at IS NOT NULL AS published FROM outbox_events WHERE id = ANY(${ids}::uuid[])
  `.execute(platformDb);
  return result.rows;
}

/** Publishes everything pending, as the single relay would. */
async function drain(relay: OutboxRelay): Promise<void> {
  while ((await relay.publishBatch()) > 0) {
    // keep going
  }
}

beforeAll(async () => {
  platformDb = createDatabase(process.env.DATABASE_URL_PLATFORM as string, 'platform');
  queues = new QueueRegistry();
  router = new JobRouter(null as never);
  (router as unknown as { routes: Map<string, unknown> }).routes.set('access.changed', [{ queue: 'analytics', consumer: CONSUMER }]);
  unitOfWork = await service(UnitOfWork);
  tenant = await createTenant();
});

afterAll(async () => {
  await Promise.all(relays.map((relay) => relay.onApplicationShutdown()));
  relays = [];
  await queues.onApplicationShutdown();
  await platformDb.destroy();
});

describe('outbox relay', () => {
  it('elects exactly one leader and fails over', async () => {
    const [r1, r2] = [new OutboxRelay(platformDb, router, queues, metrics as never), new OutboxRelay(platformDb, router, queues, metrics as never)];
    relays.push(r1, r2);
    r1.onApplicationBootstrap();
    r2.onApplicationBootstrap();
    await vi.waitFor(() => expect([r1.isLeader(), r2.isLeader()].filter(Boolean)).toHaveLength(1), { timeout: 5_000 });

    const leader = r1.isLeader() ? r1 : r2;
    const follower = leader === r1 ? r2 : r1;
    await leader.onApplicationShutdown();
    await vi.waitFor(() => expect(follower.isLeader()).toBe(true), { timeout: 10_000, interval: 200 });
    await follower.onApplicationShutdown();
  });

  it('publishes only committed events and never rolled-back ones', async () => {
    const relay = newRelay();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let pendingId = '';
    const open = unitOfWork.withTenant(ctxFor(tenant), async (tx) => {
      pendingId = await appendChanged(tx, 'pending');
      await gate;
    });
    await vi.waitFor(() => expect(pendingId).not.toBe(''));
    await drain(relay);
    expect(await rowsFor([pendingId])).toEqual([]); // not visible before commit

    release();
    await open;
    await drain(relay);
    expect(await rowsFor([pendingId])).toEqual([expect.objectContaining({ published: true })]);

    let rolledBack = '';
    await unitOfWork
      .withTenant(ctxFor(tenant), async (tx) => {
        rolledBack = await appendChanged(tx, 'rolled-back');
        throw new Error('rollback');
      })
      .catch(() => undefined);
    await drain(relay);
    expect(await rowsFor([rolledBack])).toEqual([]);
  });

  it('assigns gap-free seq values to concurrent writers across tenants', async () => {
    const other = await createTenant();
    const relay = newRelay();
    const ids = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        unitOfWork.withTenant(ctxFor(index % 2 === 0 ? tenant : other), (tx) => appendChanged(tx, `concurrent-${index}`)),
      ),
    );
    await drain(relay);
    const seqs = (await rowsFor(ids)).map((row) => Number(row.seq)).sort((x, y) => x - y);
    expect(seqs).toHaveLength(30);
    expect(seqs.at(-1)! - seqs[0]!).toBe(29);
    const max = await sql<{ max: string }>`SELECT max(seq)::text AS max FROM outbox_events`.execute(platformDb);
    expect(Number(max.rows[0]?.max)).toBe(seqs.at(-1));
  });

  it('does not duplicate consumer jobs when a batch is published again', async () => {
    const relay = newRelay();
    const id = await unitOfWork.withTenant(ctxFor(tenant), (tx) => appendChanged(tx, 'republish'));
    await drain(relay);
    // A crash between fan-out and commit leaves the row unpublished: simulate it.
    await sql`UPDATE outbox_events SET published_at = NULL, seq = NULL WHERE id = ${id}::uuid`.execute(platformDb);
    await drain(relay);
    const jobs = await queues.get('analytics').getJobs(['waiting', 'delayed', 'active', 'completed']);
    expect(jobs.filter((job) => job.name === CONSUMER && (job.data as { eventId: string }).eventId === id)).toHaveLength(1);
    expect(await rowsFor([id])).toEqual([expect.objectContaining({ published: true })]);
  });
});

describe('sync catch-up', () => {
  it('replays missed events of visible streams in seq order', async () => {
    const relay = newRelay();
    const manager = await createUser(tenant, { roles: ['manager'] });
    const before = await sql<{ max: string }>`SELECT coalesce(max(seq), 0)::text AS max FROM outbox_events`.execute(platformDb);
    const afterSeq = Number(before.rows[0]?.max);

    // Missed while offline.
    await unitOfWork.withTenant(ctxFor(tenant), async (tx) => {
      await outbox.append(tx, { type: 'access.revoked', payload: { ticketIds: ['one'] }, streams: [`user:${manager.id}`] });
      await outbox.append(tx, { type: 'access.revoked', payload: { groupIds: [null] }, streams: ['tickets:group:ungrouped'] });
      await outbox.append(tx, { type: 'access.revoked', payload: { ticketIds: ['someone-else'] }, streams: [`user:${tenant.roles.admin}`] });
    });
    await drain(relay);

    const socket = await connectSocket(manager);
    const replayed: { seq: number; stream: string; data: unknown }[] = [];
    socket.on('event', (envelope: { seq: number; stream: string; data: unknown }) => replayed.push(envelope));
    const ack = (await socket.emitWithAck('sync', {
      streams: [
        { stream: 'user', afterSeq },
        { stream: 'tickets', afterSeq },
      ],
    })) as { ok: boolean; upToSeq: number; resyncRequired: string[] };
    await vi.waitFor(() => expect(replayed).toHaveLength(2));

    expect(ack).toEqual({ ok: true, upToSeq: expect.any(Number) as number, resyncRequired: [] });
    expect(replayed.map((envelope) => [envelope.stream, envelope.data])).toEqual([
      ['user', { ticketIds: ['one'] }],
      ['tickets', { groupIds: [null] }],
    ]);
    expect(replayed[0]!.seq).toBeLessThan(replayed[1]!.seq);
    socket.close();
  });

  it('excludes streams the user can no longer see', async () => {
    const relay = newRelay();
    const manager = await createUser(tenant, { roles: ['manager'] });
    const start = await sql<{ max: string }>`SELECT coalesce(max(seq), 0)::text AS max FROM outbox_events`.execute(platformDb);
    await unitOfWork.withTenant(ctxFor(tenant), (tx) =>
      outbox.append(tx, { type: 'access.revoked', payload: { groupIds: [] }, streams: ['tickets:group:ungrouped'] }),
    );
    // The Manager role loses Ungrouped view (the version bump makes the policy re-read grants).
    await setGroupAccess(tenant, 'manager', null, {});
    await drain(relay);

    const socket = await connectSocket(manager);
    const replayed: unknown[] = [];
    socket.on('event', (envelope: unknown) => replayed.push(envelope));
    const ack = (await socket.emitWithAck('sync', { streams: [{ stream: 'tickets', afterSeq: Number(start.rows[0]?.max) }] })) as {
      ok: boolean;
    };
    expect(ack.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(replayed).toEqual([]);
    socket.close();
    // Restore for later tests in this file.
    await setGroupAccess(tenant, 'manager', null, { view: true, edit: true });
  });

  it('asks for a resync when the cursor is older than retention', async () => {
    const relay = newRelay();
    const user = await createUser(tenant, { roles: ['admin'] });
    await unitOfWork.withTenant(ctxFor(tenant), async (tx) => {
      await outbox.append(tx, { type: 'access.revoked', payload: {}, streams: [`user:${user.id}`] });
      await bumpAccessVersion(tx, tenant.id, 'resync-test');
    });
    await drain(relay);
    // Simulate pruning: drop the oldest published rows, as the relay does after 7 days.
    await sql`DELETE FROM outbox_events WHERE seq < (SELECT max(seq) - 1 FROM outbox_events)`.execute(platformDb);

    const socket = await connectSocket(user);
    const ack = (await socket.emitWithAck('sync', {
      streams: [
        { stream: 'user', afterSeq: 1 },
        { stream: 'views', afterSeq: 1 },
      ],
    })) as { resyncRequired: string[] };
    expect(ack.resyncRequired).toEqual(['user', 'views']);
    socket.close();
  });
});
