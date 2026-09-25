import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { UnitOfWork } from '../../../src/platform-kernel/db/unit-of-work.js';
import { OutboxService } from '../../../src/platform-kernel/outbox/outbox.service.js';
import { getTestApp, getTestWorker, service } from '../../support/app.js';
import { createGroup, createRole, createTenant, createUser, type TestTenant, type TestUser } from '../../support/factories.js';
import { asUser } from '../../support/http.js';
import { connectSocket, waitForEvent } from '../../support/socket.js';

import type { Socket } from 'socket.io-client';

/**
 * Live revocation (T096, FR-025, SC-011): a role edit reaches connected users within 2 s. Their
 * socket leaves the group's `tickets:group:*` room and gets `access.revoked`, and their very next
 * request uses the new access without signing in again.
 *
 * Room membership is observed from outside: a probe event appended to the group's stream is
 * delivered to every socket in the room, so after the edit it must reach a control socket that
 * kept access and not the revoked user.
 */

interface Envelope {
  id: string;
  type: string;
  stream: string;
  data: Record<string, unknown>;
}

const SC_011_MS = 2_000;

let tenant: TestTenant;
let admin: TestUser;
let sockets: Socket[] = [];

async function connect(user: TestUser): Promise<Socket> {
  const socket = await connectSocket(user);
  sockets.push(socket);
  return socket;
}

/** Appends a probe event to the group's list stream and returns its id. */
async function probeGroupStream(groupId: string): Promise<string> {
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'live-revocation-probe' });
  const outbox = await service(OutboxService);
  return (await service(UnitOfWork)).withTenant(ctx, (tx) =>
    outbox.append(tx, { type: 'user.deactivated', payload: { userId: admin.id }, streams: [`tickets:group:${groupId}`] }),
  );
}

const envelope = (socket: Socket, match: (e: Envelope) => boolean, timeoutMs = 5_000) =>
  waitForEvent<Envelope>(socket, 'event', match, timeoutMs);

/** Resolves true if a matching envelope arrives within `ms`, false otherwise. */
const arrives = (socket: Socket, match: (e: Envelope) => boolean, ms: number) =>
  envelope(socket, match, ms).then(
    () => true,
    () => false,
  );

beforeAll(async () => {
  await getTestApp();
  await getTestWorker();
  tenant = await createTenant();
  admin = await createUser(tenant, { roles: ['admin'] });
});

afterAll(() => {
  for (const socket of sockets) socket.close();
  sockets = [];
});

describe('live revocation (SC-011)', () => {
  it('removes a connected user from the group room within 2 s and blocks their next write', async () => {
    const role = await createRole(tenant, { permissions: ['ticket.view', 'ticket.edit', 'group.view', 'group.edit'] });
    const group = await createGroup(tenant, { access: [{ role: { id: role.id }, flags: { view: true, edit: true } }] });
    const user = await createUser(tenant, { roles: [{ id: role.id }] });

    const userSocket = await connect(user);
    const adminSocket = await connect(admin);

    // Before: both sockets are in the group's room, and the user may edit the group.
    const before = await probeGroupStream(group.id);
    await Promise.all([envelope(userSocket, (e) => e.id === before), envelope(adminSocket, (e) => e.id === before)]);
    expect((await asUser(user).patch(`/groups/${group.id}`, { description: 'Before' })).status).toBe(200);

    const revoked = envelope(userSocket, (e) => e.type === 'access.revoked', 5_000);
    const started = Date.now();
    const edit = await asUser(admin).put(`/roles/${role.id}`, {
      name: 'Lost the group',
      permissions: ['ticket.view', 'ticket.edit', 'group.view'],
      groupAccess: [],
    });
    expect(edit.status).toBe(200);

    const event = await revoked;
    expect(Date.now() - started).toBeLessThan(SC_011_MS);
    expect(event).toMatchObject({ stream: 'user', data: { groupIds: [group.id] } });

    // After: list updates for the group reach the admin but no longer the user.
    const after = await probeGroupStream(group.id);
    const userGotIt = arrives(userSocket, (e) => e.id === after, 1_500);
    await envelope(adminSocket, (e) => e.id === after);
    expect(await userGotIt).toBe(false);

    // Same session, new access: group.edit is gone (403); the owner picker on a group the user
    // can no longer view answers like an unknown group (404).
    const write = await asUser(user).patch(`/groups/${group.id}`, { description: 'After' });
    expect(write.status).toBe(403);
    expect((await asUser(user).get(`/groups/${group.id}/eligible-owners`)).status).toBe(404);
    expect((await asUser(user).get('/me')).status).toBe(200);
  });

  it('gives a user new group rooms without reconnecting when access is granted', async () => {
    const role = await createRole(tenant, { permissions: ['ticket.view'] });
    const group = await createGroup(tenant);
    const user = await createUser(tenant, { roles: [{ id: role.id }] });
    const userSocket = await connect(user);

    const changed = envelope(userSocket, (e) => e.type === 'access.changed');
    await asUser(admin).put(`/roles/${role.id}`, {
      name: role.name,
      permissions: ['ticket.view'],
      groupAccess: [{ groupId: group.id, view: true, create: false, edit: false, delete: false }],
    });
    await changed;

    const probe = await probeGroupStream(group.id);
    await expect(envelope(userSocket, (e) => e.id === probe)).resolves.toMatchObject({ stream: 'tickets' });
  });

  it('answers a customer session on a staff route with 404, like an unknown route', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    for (const path of ['/roles', '/groups', '/permissions']) {
      const response = await asUser(customer).get(path);
      expect(response.status).toBe(404);
      expect(response.body).toEqual((await asUser(customer).get('/no-such-route')).body);
    }
  });
});
