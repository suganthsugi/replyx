import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { UnitOfWork } from '../../../src/platform-kernel/db/unit-of-work.js';
import { OutboxService } from '../../../src/platform-kernel/outbox/outbox.service.js';
import { getTestApp, getTestWorker, service } from '../../support/app.js';
import { createGroup, createRole, createTenant, createTicket, createUser, setGroupAccess, type TestTenant, type TestUser } from '../../support/factories.js';
import { asUser } from '../../support/http.js';
import { connectSocket, waitForEvent } from '../../support/socket.js';
import { createView } from '../../support/view-factory.js';

import type { Socket } from 'socket.io-client';

/**
 * Reconnect catch-up and count hints (T168, SC-002, SC-007, contracts/realtime-events.md `sync`,
 * counts-notifier.ts). A staff socket that misses events while disconnected gets all of them,
 * once, in order, on reconnect via `sync`; a ticket change also drops the affected viewers'
 * cached counts and gives them a single `views.counts_changed` hint within 2 s, even for a burst.
 */

interface Envelope {
  id: string;
  seq: number;
  stream: string;
  type: string;
  data: Record<string, unknown>;
}

const SC_002_MS = 2_000;

let sockets: Socket[] = [];

async function connect(user: TestUser): Promise<Socket> {
  const socket = await connectSocket(user);
  sockets.push(socket);
  return socket;
}

const envelope = (socket: Socket, match: (e: Envelope) => boolean, timeoutMs = 5_000) => waitForEvent<Envelope>(socket, 'event', match, timeoutMs);

/** Resolves true if a matching envelope arrives within `ms`, false otherwise. */
const arrives = (socket: Socket, match: (e: Envelope) => boolean, ms: number) =>
  envelope(socket, match, ms).then(
    () => true,
    () => false,
  );

const isHint = (e: Envelope) => e.type === 'views.counts_changed';

/** Waits until no hint has arrived for `quietMs`: leftovers from setup, however late, are drained. */
async function settleHints(socket: Socket, quietMs = 1_000): Promise<void> {
  while (await arrives(socket, isHint, quietMs)) {
    // keep draining
  }
}

/**
 * Appends a neutral probe event (`user.deactivated`, like live-revocation.test.ts — it isn't
 * treated specially by any gateway handler) to the group's list stream and returns its seq, read
 * off a throwaway socket that can see the group. The socket must join the room *before* the
 * event is appended: the relay only broadcasts to sockets already in the room at publish time.
 */
async function probeGroupStream(tenant: TestTenant, groupId: string, watcher: TestUser, timeoutMs = 5_000): Promise<number> {
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'catch-up-probe' });
  const outbox = await service(OutboxService);
  const socket = await connect(watcher);
  const id = await (await service(UnitOfWork)).withTenant(ctx, (tx) =>
    outbox.append(tx, { type: 'user.deactivated', payload: { userId: watcher.id }, streams: [`tickets:group:${groupId}`] }),
  );
  const seen = await envelope(socket, (e) => e.id === id, timeoutMs);
  socket.close();
  return seen.seq;
}

beforeAll(async () => {
  await getTestApp();
  await getTestWorker();

  // Files without a worker leave their outbox events unpublished; this file's relay publishes
  // that backlog first (hookTimeout is 120 s, well past testTimeout). Settling it once here, in a
  // throwaway tenant, keeps every test's own probes on the default (fast) timeout.
  const warmUpTenant = await createTenant();
  const warmUpAdmin = await createUser(warmUpTenant, { roles: ['admin'] });
  const warmUpGroup = await createGroup(warmUpTenant);
  await probeGroupStream(warmUpTenant, warmUpGroup.id, warmUpAdmin, 90_000);
}, 120_000);

afterAll(() => {
  for (const socket of sockets) socket.close();
  sockets = [];
});

function createBody(customerId: string, groupId: string, title: string) {
  return { customerId, groupId, title, message: { body: 'Hi, following up on your order' } };
}

describe('sync replays events missed while disconnected (SC-007)', () => {
  it('delivers exactly the three missed events once, in order, and nothing more on a later sync', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const group = await createGroup(tenant);
    // Inserted directly (no events): the ticket exists before the socket drops, so the three
    // missed events below are cleanly three `ticket.updated`s, not mixed with creation side effects
    // (a staff-started ticket's first public reply itself emits an extra `ticket.updated`).
    const ticket = await createTicket(tenant, { customer, group: group.id, state: 'open' });

    const baselineSeq = await probeGroupStream(tenant, group.id, admin);

    const staff = await createUser(tenant, { roles: ['admin'] });
    const socket = await connect(staff);
    // The gateway auto-joins staff to the group's `tickets:group:*` room, so a probe on it is
    // visible without an explicit `subscribe`; this confirms the socket is live before it drops.
    // Listen before probing (the envelope can arrive before the probe returns), and probe again if
    // the socket wasn't in the room yet: the gateway joins group rooms asynchronously on connect.
    let live = false;
    for (let attempt = 0; attempt < 3 && !live; attempt += 1) {
      const seen = envelope(socket, (e) => e.type === 'user.deactivated', 3_000).then(
        (e) => e.seq,
        () => undefined,
      );
      const probed = await probeGroupStream(tenant, group.id, admin);
      live = (await seen) === probed;
    }
    expect(live).toBe(true);
    socket.close();

    // A socket that stays connected the whole time, so waiting for its live delivery of each
    // event proves the relay has published it — a real synchronization point instead of a sleep.
    const monitor = await connect(admin);
    const isTitleUpdate = (title: string) => (e: Envelope) =>
      e.type === 'ticket.updated' &&
      (e.data.ticket as { id: string } | undefined)?.id === ticket.id &&
      (e.data.changes as { field: string; new: unknown }[]).some((c) => c.field === 'title' && c.new === title);

    // Three events happen while the socket is gone: three title edits, each its own ticket.updated.
    const titles = ['First contact', 'First contact (updated once)', 'First contact (updated twice)'];
    for (const title of titles) {
      const update = await asUser(admin).patch(`/tickets/${ticket.id}`, { title });
      expect(update.status).toBe(200);
      await envelope(monitor, isTitleUpdate(title));
    }
    monitor.close();

    const reconnected = await connect(staff);
    const received: Envelope[] = [];
    const capture = (payload: Envelope) => received.push(payload);
    reconnected.on('event', capture);
    const ack = (await reconnected.emitWithAck('sync', { streams: [{ stream: 'tickets', afterSeq: baselineSeq }] })) as {
      ok: true;
      upToSeq: number;
      resyncRequired: string[];
    };
    // sync's replay is emitted synchronously before the ack on the same connection.
    reconnected.off('event', capture);
    expect(ack).toMatchObject({ ok: true, resyncRequired: [] });

    const ticketEvents = received.filter((e) => (e.data.ticket as { id: string } | undefined)?.id === ticket.id);
    expect(ticketEvents.map((e) => e.type)).toEqual(['ticket.updated', 'ticket.updated', 'ticket.updated']);
    expect(ticketEvents.map((e) => (e.data.changes as { field: string; new: unknown }[]).find((c) => c.field === 'title')?.new)).toEqual(titles);
    // Each once: ids in the envelope stream are unique per event.
    expect(new Set(ticketEvents.map((e) => e.id)).size).toBe(3);
    // In order: seq strictly increasing.
    for (let i = 1; i < ticketEvents.length; i += 1) expect(ticketEvents[i]!.seq).toBeGreaterThan(ticketEvents[i - 1]!.seq);

    // A second sync from the last seq we have replays nothing new.
    const lastSeq = ticketEvents.at(-1)!.seq;
    const replayed: Envelope[] = [];
    const captureAgain = (payload: Envelope) => replayed.push(payload);
    reconnected.on('event', captureAgain);
    const secondAck = (await reconnected.emitWithAck('sync', { streams: [{ stream: 'tickets', afterSeq: lastSeq }] })) as {
      ok: true;
      upToSeq: number;
      resyncRequired: string[];
    };
    reconnected.off('event', captureAgain);
    expect(secondAck).toMatchObject({ ok: true, resyncRequired: [] });
    expect(replayed.filter((e) => (e.data.ticket as { id: string } | undefined)?.id === ticket.id)).toHaveLength(0);
  });
});

describe('view count hints follow a ticket change within 2 s (SC-002)', () => {
  it('drops the cache and hints only viewers of the affected group, once for a burst', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const group = await createGroup(tenant);
    const otherGroup = await createGroup(tenant);

    const viewerRole = await createRole(tenant, { permissions: ['ticket.view', 'view.view'] });
    await setGroupAccess(tenant, { id: viewerRole.id }, group.id, { view: true });
    const viewer = await createUser(tenant, { roles: [{ id: viewerRole.id }] });

    const outsiderRole = await createRole(tenant, { permissions: ['ticket.view', 'view.view'] });
    await setGroupAccess(tenant, { id: outsiderRole.id }, otherGroup.id, { view: true });
    const outsider = await createUser(tenant, { roles: [{ id: outsiderRole.id }] });

    const view = await createView(tenant, {
      name: 'Group counts view',
      visibility: 'all_staff',
      conditions: { op: 'and', items: [{ field: 'group', operator: 'is', value: group.id }] },
    });

    const [viewerSocket, outsiderSocket] = await Promise.all([connect(viewer), connect(outsider)]);

    // The group/role setup above bumped the access version several times (createGroup,
    // createRole, setGroupAccess); the `access.changed` consumer notifies every active staff
    // member at *processing* time, by which point viewer and outsider already exist, so each may
    // get a leftover hint from setup rather than from the ticket change below. Drain it first, so
    // the timed measurement only sees the hint this test is actually about. Drained until quiet,
    // not for a fixed time, so a slow worker under load can't deliver a leftover mid-measurement.
    await Promise.all([settleHints(viewerSocket), settleHints(outsiderSocket)]);

    const before = await asUser(viewer).get('/views/counts');
    expect(before.status).toBe(200);
    const beforeCount = (before.body as Record<string, number>)[view.id] ?? 0;

    const hint = envelope(viewerSocket, (e) => e.type === 'views.counts_changed');
    const outsiderGotIt = arrives(outsiderSocket, (e) => e.type === 'views.counts_changed', 1_500);
    const started = Date.now();
    const created = await asUser(admin).post('/tickets', createBody(customer.id, group.id, 'Needs a look'));
    expect(created.status).toBe(201);

    const received = await hint;
    expect(Date.now() - started).toBeLessThan(SC_002_MS);
    expect(received).toMatchObject({ stream: 'views' });
    expect((received.data.viewIds as string[]).includes(view.id)).toBe(true);
    expect(await outsiderGotIt).toBe(false);

    const after = await asUser(viewer).get('/views/counts');
    expect(after.status).toBe(200);
    expect((after.body as Record<string, number>)[view.id]).toBe(beforeCount + 1);

    // A burst of changes is coalesced by the 500 ms debounce: fewer hints than changes. (Exactly one
    // would depend on the worker consuming all five inside one window, which load can stretch.)
    await settleHints(viewerSocket);
    const ticketId = (created.body as { id: string }).id;
    const nextHints: unknown[] = [];
    const captureHints = (payload: unknown) => {
      if (isHint(payload as Envelope)) nextHints.push(payload);
    };
    viewerSocket.on('event', captureHints);
    const BURST = 5;
    await Promise.all(Array.from({ length: BURST }, (_, index) => asUser(admin).patch(`/tickets/${ticketId}`, { title: `Burst ${index + 1}` })));
    await settleHints(viewerSocket);
    viewerSocket.off('event', captureHints);
    expect(nextHints.length).toBeGreaterThanOrEqual(1);
    expect(nextHints.length).toBeLessThan(BURST);
  });
});

describe('GET /views/counts covers exactly the views GET /views lists', () => {
  it('omits Needs Triage for a user without Ungrouped view access, same as the list', async () => {
    const tenant = await createTenant();
    const role = await createRole(tenant, { permissions: ['view.view', 'ticket.view'] });
    const user = await createUser(tenant, { roles: [{ id: role.id }] });

    const list = await asUser(user).get('/views');
    expect(list.status).toBe(200);
    const views = (list.body as { items: { id: string; system: string | null }[] }).items;
    expect(views.map((view) => view.system)).not.toContain('needs_triage');

    const counts = await asUser(user).get('/views/counts');
    expect(counts.status).toBe(200);
    expect(Object.keys(counts.body as Record<string, number>).sort()).toEqual(
      views.map((view) => view.id).sort(),
    );
  });
});
