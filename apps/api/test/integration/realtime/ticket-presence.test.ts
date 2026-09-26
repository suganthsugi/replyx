import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getTestApp } from '../../support/app.js';
import { createGroup, createTenant, createTicket, createUser, type TestTenant } from '../../support/factories.js';
import { connectSocket, waitForEvent } from '../../support/socket.js';

import type { Socket } from 'socket.io-client';

/**
 * Staff presence on a ticket screen (T143, ticket-events.ts `TicketPresenceHandler`/`Gateway`):
 * `viewing` enter/leave broadcasts to the `ticket:{id}` room over the ephemeral channel (never the
 * outbox), and is refused as `NOT_FOUND` for a ticket a caller can't view — same as a missing one.
 */

interface PresenceSignal {
  type: string;
  stream: string;
  data: { ticketId: string; viewers: { id: string; name: string; avatarUrl: string | null }[]; typing: unknown[] };
}

let tenant: TestTenant;
let sockets: Socket[] = [];

async function connect(user: Parameters<typeof connectSocket>[0]): Promise<Socket> {
  const socket = await connectSocket(user);
  sockets.push(socket);
  return socket;
}

const presence = (socket: Socket, match: (s: PresenceSignal) => boolean, timeoutMs = 5_000) =>
  waitForEvent<PresenceSignal>(socket, 'ephemeral', (s) => s.type === 'presence' && match(s), timeoutMs);

beforeAll(async () => {
  await getTestApp();
  tenant = await createTenant();
});

afterAll(() => {
  for (const socket of sockets) socket.close();
  sockets = [];
});

describe('ticket presence', () => {
  it('broadcasts viewing enter and leave to everyone subscribed to the ticket', async () => {
    const group = await createGroup(tenant);
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, group: group.id, state: 'open' });
    const viewer = await createUser(tenant, { roles: ['admin'], name: 'Priya' });
    const watcher = await createUser(tenant, { roles: ['admin'] });
    const [viewerSocket, watcherSocket] = await Promise.all([connect(viewer), connect(watcher)]);
    await Promise.all([
      viewerSocket.emitWithAck('subscribe', { stream: `ticket:${ticket.id}` }),
      watcherSocket.emitWithAck('subscribe', { stream: `ticket:${ticket.id}` }),
    ]);

    const entered = presence(watcherSocket, (s) => s.data.viewers.some((v) => v.id === viewer.id));
    expect(await viewerSocket.emitWithAck('viewing', { ticketId: ticket.id, state: 'enter' })).toEqual({ ok: true });
    const enteredSignal = await entered;
    expect(enteredSignal).toEqual({
      type: 'presence',
      stream: `ticket:${ticket.id}`,
      data: { ticketId: ticket.id, viewers: [{ id: viewer.id, name: 'Priya', avatarUrl: null }], typing: [] },
    });

    const left = presence(watcherSocket, (s) => !s.data.viewers.some((v) => v.id === viewer.id));
    expect(await viewerSocket.emitWithAck('viewing', { ticketId: ticket.id, state: 'leave' })).toEqual({ ok: true });
    const leftSignal = await left;
    expect(leftSignal.data.viewers).toEqual([]);
  });

  it('refuses viewing on a ticket outside the caller’s groups, like a missing one', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const group = await createGroup(tenant);
    const ticket = await createTicket(tenant, { customer, group: group.id, state: 'open' });
    const outsider = await createUser(tenant, { roles: ['agent'] });
    const socket = await connect(outsider);

    expect(await socket.emitWithAck('viewing', { ticketId: ticket.id, state: 'enter' })).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Not found' },
    });
    expect(await socket.emitWithAck('viewing', { ticketId: '018f6e2e-0000-7000-8000-000000000000', state: 'enter' })).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Not found' },
    });
  });
});
