import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { getTestApp, service } from '../../support/app.js';
import { createGroup, createRole, createTenant, createTicket, createUser, type TestTenant, type TestUser } from '../../support/factories.js';
import { asUser } from '../../support/http.js';
import { connectSocket, waitForEvent } from '../../support/socket.js';

import type { Socket } from 'socket.io-client';

/**
 * Collision awareness and availability (US14, T238/T239; contracts/realtime-events.md): viewers and
 * typing reach other staff on the ticket within 2 s, `availability.changed` reaches staff who share
 * a group with the user, and none of it is written to ticket history or the outbox.
 */

interface Signal<D> {
  type: string;
  stream: string;
  data: D;
}
interface PresenceData {
  ticketId: string;
  viewers: { id: string }[];
}
interface TypingData {
  ticketId: string;
  user: { id: string };
  state: string;
}
interface AvailabilityData {
  userId: string;
  availability: string;
}

const LIVE_MS = 2_000;

class Inspect extends TenantRepository {
  async writes(tx: TenantTransaction, ticketId: string): Promise<{ history: number; events: number }> {
    const history = await this.selectFrom(tx, 'ticket_history').select((eb) => eb.fn.countAll<string>().as('n')).where('ticket_id', '=', ticketId).executeTakeFirstOrThrow();
    const events = await this.selectFrom(tx, 'outbox_events')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where(sql<boolean>`streams::text LIKE ${`%${ticketId}%`}`)
      .executeTakeFirstOrThrow();
    return { history: Number(history.n), events: Number(events.n) };
  }
}

async function writesFor(tenant: TestTenant, ticketId: string): Promise<{ history: number; events: number }> {
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'presence-test' });
  return (await service(UnitOfWork)).withTenant(ctx, (tx) => new Inspect(ctx).writes(tx, ticketId));
}

let tenant: TestTenant;
let sockets: Socket[] = [];

async function connect(user: TestUser): Promise<Socket> {
  const socket = await connectSocket(user);
  sockets.push(socket);
  return socket;
}

function ephemeral<D>(socket: Socket, type: string, match: (data: D) => boolean, timeoutMs = LIVE_MS): Promise<Signal<D>> {
  return waitForEvent<Signal<D>>(socket, 'ephemeral', (signal) => signal.type === type && match(signal.data), timeoutMs);
}

/** Resolves true if a matching signal arrives within `ms`, false otherwise. */
async function arrives<D>(socket: Socket, type: string, match: (data: D) => boolean, ms = 1_000): Promise<boolean> {
  return ephemeral(socket, type, match, ms).then(
    () => true,
    () => false,
  );
}

beforeAll(async () => {
  await getTestApp();
  tenant = await createTenant();
});

afterAll(() => {
  for (const socket of sockets) socket.close();
  sockets = [];
});

describe('viewing and typing', () => {
  it('shows another agent viewing and typing within 2 s and writes nothing to history or the outbox', async () => {
    const group = await createGroup(tenant);
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, group: group.id, state: 'open' });
    const first = await createUser(tenant, { roles: ['admin'] });
    const second = await createUser(tenant, { roles: ['admin'] });
    const [firstSocket, secondSocket] = await Promise.all([connect(first), connect(second)]);
    await Promise.all([
      firstSocket.emitWithAck('subscribe', { stream: `ticket:${ticket.id}` }),
      secondSocket.emitWithAck('subscribe', { stream: `ticket:${ticket.id}` }),
    ]);
    const before = await writesFor(tenant, ticket.id);

    const seen = ephemeral<PresenceData>(secondSocket, 'presence', (data) => data.viewers.some((viewer) => viewer.id === first.id));
    expect(await firstSocket.emitWithAck('viewing', { ticketId: ticket.id, state: 'enter' })).toEqual({ ok: true });
    expect((await seen).stream).toBe(`ticket:${ticket.id}`);

    const typing = ephemeral<TypingData>(secondSocket, 'typing', (data) => data.user.id === first.id && data.state === 'start');
    expect(await firstSocket.emitWithAck('typing', { ticketId: ticket.id, state: 'start' })).toEqual({ ok: true });
    expect((await typing).data.ticketId).toBe(ticket.id);

    const stopped = ephemeral<TypingData>(secondSocket, 'typing', (data) => data.user.id === first.id && data.state === 'stop');
    await firstSocket.emitWithAck('typing', { ticketId: ticket.id, state: 'stop' });
    await stopped;

    expect(await writesFor(tenant, ticket.id)).toEqual(before);
  });
});

describe('availability.changed', () => {
  it('reaches staff who can view one of the user’s groups, once, and not staff outside them', async () => {
    const shared = await createGroup(tenant);
    const elsewhere = await createGroup(tenant);
    const role = await createRole(tenant, { permissions: ['ticket.view'], groups: [{ group: shared.id, flags: { view: true } }] });
    const outsiderRole = await createRole(tenant, { permissions: ['ticket.view'], groups: [{ group: elsewhere.id, flags: { view: true } }] });
    const agent = await createUser(tenant, { roles: [{ id: role.id }] });
    const colleague = await createUser(tenant, { roles: [{ id: role.id }] });
    const outsider = await createUser(tenant, { roles: [{ id: outsiderRole.id }] });
    const [colleagueSocket, outsiderSocket] = await Promise.all([connect(colleague), connect(outsider)]);

    const received: Signal<AvailabilityData>[] = [];
    colleagueSocket.on('ephemeral', (signal: Signal<AvailabilityData>) => {
      if (signal.type === 'availability.changed' && signal.data.userId === agent.id) received.push(signal);
    });
    const colleagueHears = ephemeral<AvailabilityData>(colleagueSocket, 'availability.changed', (data) => data.userId === agent.id);
    const outsiderHears = arrives<AvailabilityData>(outsiderSocket, 'availability.changed', (data) => data.userId === agent.id);

    const response = await asUser(agent).patch('/me', { availability: 'away' });
    expect(response.status).toBe(200);
    expect((await colleagueHears).data).toEqual({ userId: agent.id, availability: 'away' });
    expect(await outsiderHears).toBe(false);
    expect(received).toHaveLength(1);
  });

  it('is not broadcast when the availability does not change', async () => {
    const group = await createGroup(tenant);
    const role = await createRole(tenant, { permissions: ['ticket.view'], groups: [{ group: group.id, flags: { view: true } }] });
    const agent = await createUser(tenant, { roles: [{ id: role.id }] });
    const colleague = await createUser(tenant, { roles: [{ id: role.id }] });
    // Set before the colleague connects, so this first change can't reach them.
    expect((await asUser(agent).patch('/me', { availability: 'online' })).status).toBe(200);
    const colleagueSocket = await connect(colleague);

    const hears = arrives<AvailabilityData>(colleagueSocket, 'availability.changed', (data) => data.userId === agent.id);
    expect((await asUser(agent).patch('/me', { availability: 'online' })).status).toBe(200);
    expect(await hears).toBe(false);
  });

  it('never reaches another tenant’s staff', async () => {
    const agent = await createUser(tenant, { roles: ['admin'] });
    const other = await createTenant();
    const otherAdmin = await createUser(other, { roles: ['admin'] });
    const otherSocket = await connect(otherAdmin);

    const hears = arrives<AvailabilityData>(otherSocket, 'availability.changed', (data) => data.userId === agent.id);
    expect((await asUser(agent).patch('/me', { availability: 'away' })).status).toBe(200);
    expect(await hears).toBe(false);
  });
});
