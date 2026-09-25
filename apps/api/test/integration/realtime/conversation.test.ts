import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../../src/platform-kernel/ids.js';
import { getTestApp, getTestWorker, service } from '../../support/app.js';
import { createGroup, createTenant, createTicket, createUser, type TestTenant, type TestUser } from '../../support/factories.js';
import { asUser } from '../../support/http.js';
import { connectSocket, waitForEvent } from '../../support/socket.js';

import type { Socket } from 'socket.io-client';

/**
 * The customer conversation in real time (T111, contracts/realtime-events.md, FR-053, FR-056):
 * every device of the customer gets the same thread, typing crosses between staff and customer,
 * internal notes never reach the customer, and customer sockets see nothing but their own
 * conversation.
 */

interface Envelope {
  id: string;
  type: string;
  stream: string;
  actor: Record<string, unknown>;
  data: Record<string, unknown>;
}

interface Signal {
  type: string;
  stream: string;
  data: Record<string, unknown>;
}

const FORBIDDEN = ['ticketId', 'number', 'state', 'group', 'owner', 'priority', 'sla', 'visibility'];

let tenant: TestTenant;
let sockets: Socket[] = [];

async function connect(user: TestUser): Promise<Socket> {
  const socket = await connectSocket(user);
  sockets.push(socket);
  return socket;
}

const envelope = (socket: Socket, match: (e: Envelope) => boolean, timeoutMs = 5_000) => waitForEvent<Envelope>(socket, 'event', match, timeoutMs);
const signal = (socket: Socket, match: (s: Signal) => boolean, timeoutMs = 5_000) => waitForEvent<Signal>(socket, 'ephemeral', match, timeoutMs);
const never = <T>(promise: Promise<T>) =>
  promise.then(
    () => false,
    () => true,
  );

function keysDeep(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => keysDeep(item, keys));
  else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      keysDeep(child, keys);
    }
  }
  return keys;
}

beforeAll(async () => {
  await getTestApp();
  await getTestWorker();
  tenant = await createTenant();

  // Files without a worker leave their outbox events unpublished; this file's relay publishes
  // that backlog first. Wait until it has caught up so the timings below are about this file.
  const warmUp = await createUser(tenant, { roles: ['customer'] });
  const socket = await connect(warmUp);
  const sent = await asUser(warmUp).post('/customer/messages', { body: 'warm up', clientMessageId: uuidv7() });
  await envelope(socket, (e) => e.data.id === (sent.body as { id: string }).id, 90_000);
});

afterAll(() => {
  for (const socket of sockets) socket.close();
  sockets = [];
});

describe('customer conversation stream', () => {
  it('echoes a sent message to every device of the customer, and only to them', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const neighbour = await createUser(tenant, { roles: ['customer'] });
    const [phone, laptop, other] = await Promise.all([connect(customer), connect(customer), connect(neighbour)]);

    const onPhone = envelope(phone, (e) => e.type === 'conversation.message');
    const onLaptop = envelope(laptop, (e) => e.type === 'conversation.message');
    const onOther = never(envelope(other, (e) => e.type === 'conversation.message', 1_500));
    const sent = await asUser(customer).post('/customer/messages', { body: 'Where is my parcel?', clientMessageId: uuidv7() });
    expect(sent.status).toBe(201);

    const [a, b] = await Promise.all([onPhone, onLaptop]);
    expect(a.data).toEqual(sent.body);
    expect(b.id).toBe(a.id);
    expect(a).toMatchObject({ stream: 'conversation', actor: { kind: 'user' } });
    expect(Object.keys(a.actor)).toEqual(['kind']);
    expect(await onOther).toBe(true);
  });

  it('sends a public reply as a projection and never an internal note', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const agent = await createUser(tenant, { roles: ['admin'], name: 'Priya' });
    const group = await createGroup(tenant);
    const ticket = await createTicket(tenant, { customer, group: group.id, state: 'open', messages: [{ body: 'Help' }] });
    const [customerSocket, staffSocket] = await Promise.all([connect(customer), connect(agent)]);
    expect(await staffSocket.emitWithAck('subscribe', { stream: `ticket:${ticket.id}` })).toEqual({ ok: true });

    const noteForStaff = envelope(staffSocket, (e) => e.type === 'message.created' && e.data.visibility === 'internal');
    const noteForCustomer = never(envelope(customerSocket, (e) => e.type === 'conversation.message', 1_500));
    const note = await asUser(agent).post(`/tickets/${ticket.id}/messages`, { visibility: 'internal', body: 'Refund approved internally', clientMessageId: uuidv7() });
    expect(note.status).toBe(201);
    expect((await noteForStaff).data.body).toBe('Refund approved internally');
    expect(await noteForCustomer).toBe(true);

    const reply = envelope(customerSocket, (e) => e.type === 'conversation.message');
    const status = envelope(customerSocket, (e) => e.type === 'conversation.status');
    const answer = await asUser(agent).post(`/tickets/${ticket.id}/messages`, { visibility: 'public', body: 'Your refund is on its way', clientMessageId: uuidv7() });
    expect(answer.status).toBe(201);
    const received = await reply;
    expect(received.data).toMatchObject({ body: 'Your refund is on its way', from: { kind: 'support', name: 'Priya', avatarUrl: null } });
    expect((await status).data).toEqual({ code: 'answered', text: 'Support has replied' });
    const keys = keysDeep(received);
    for (const key of FORBIDDEN) expect(keys).not.toContain(key);
    expect(JSON.stringify(received)).not.toContain(ticket.id);
  });

  it('marks the customer’s messages read when support replies (✓✓ on every device)', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const agent = await createUser(tenant, { roles: ['admin'] });
    const socket = await connect(customer);
    const sent = await asUser(customer).post('/customer/messages', { body: 'Hello?', clientMessageId: uuidv7() });
    const messageId = (sent.body as { id: string }).id;
    const ticketId = await ticketOf(tenant, messageId);

    const delivered = envelope(socket, (e) => e.type === 'conversation.delivery' && e.data.delivery === 'delivered');
    expect((await asUser(agent).get(`/tickets/${ticketId}/messages`)).status).toBe(200);
    expect((await delivered).data).toEqual({ messageId, delivery: 'delivered' });

    const read = envelope(socket, (e) => e.type === 'conversation.delivery' && e.data.delivery === 'read');
    await asUser(agent).post(`/tickets/${ticketId}/messages`, { visibility: 'public', body: 'Hi!', clientMessageId: uuidv7() });
    expect((await read).data).toEqual({ messageId, delivery: 'read' });
  });
});

/** The ticket a customer message landed on (customers never learn it; staff tests need it). */
async function ticketOf(owner: TestTenant, messageId: string): Promise<string> {
  const ctx = TenantContext.create({ tenantId: owner.id, actor: { kind: 'system' }, requestId: 'test-ticket-of' });
  return (await service(UnitOfWork)).withTenantReadOnly(ctx, async (tx) => new Lookup(ctx).ticketOf(tx, messageId));
}

class Lookup extends TenantRepository {
  async ticketOf(tx: TenantTransaction, messageId: string): Promise<string> {
    const row = await this.selectFrom(tx, 'ticket_messages').select('ticket_id').where('id', '=', messageId).executeTakeFirstOrThrow();
    return row.ticket_id;
  }
}

describe('typing', () => {
  it('shows staff typing to the customer by name, but not while writing a note', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const agent = await createUser(tenant, { roles: ['admin'], name: 'Sam' });
    const ticket = await createTicket(tenant, { customer, state: 'open' });
    const [customerSocket, staffSocket] = await Promise.all([connect(customer), connect(agent)]);

    const typing = signal(customerSocket, (s) => s.type === 'conversation.typing');
    expect(await staffSocket.emitWithAck('typing', { ticketId: ticket.id, state: 'start' })).toEqual({ ok: true });
    const shown = await typing;
    expect(shown).toEqual({ type: 'conversation.typing', stream: 'conversation', data: { name: 'Sam', avatarUrl: null, state: 'start' } });

    const hidden = never(signal(customerSocket, () => true, 1_000));
    expect(await staffSocket.emitWithAck('typing', { ticketId: ticket.id, state: 'start', visibility: 'internal' })).toEqual({ ok: true });
    expect(await hidden).toBe(true);
  });

  it('shows customer typing to staff viewing the active ticket', async () => {
    const customer = await createUser(tenant, { roles: ['customer'], name: 'Casey' });
    const agent = await createUser(tenant, { roles: ['admin'] });
    const ticket = await createTicket(tenant, { customer, state: 'new' });
    const [customerSocket, staffSocket] = await Promise.all([connect(customer), connect(agent)]);
    await staffSocket.emitWithAck('subscribe', { stream: `ticket:${ticket.id}` });

    const typing = signal(staffSocket, (s) => s.type === 'typing');
    expect(await customerSocket.emitWithAck('customer.typing', { state: 'start' })).toEqual({ ok: true });
    expect(await typing).toEqual({
      type: 'typing',
      stream: `ticket:${ticket.id}`,
      data: { ticketId: ticket.id, user: { kind: 'customer', name: 'Casey' }, state: 'start' },
    });
    expect(await customerSocket.emitWithAck('customer.typing', { state: 'dancing' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
  });

  it('refuses staff typing on tickets outside their groups', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const agent = await createUser(tenant, { roles: ['agent'] });
    const ticket = await createTicket(tenant, { customer, group: (await createGroup(tenant)).id, state: 'open' });
    const socket = await connect(agent);
    expect(await socket.emitWithAck('typing', { ticketId: ticket.id, state: 'start' })).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
  });
});

describe('customer sockets', () => {
  it('cannot subscribe to anything but their conversation', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, state: 'open' });
    const socket = await connect(customer);
    for (const stream of [`ticket:${ticket.id}`, 'user', 'views', 'tickets', `conversation:${customer.id}`]) {
      expect(await socket.emitWithAck('subscribe', { stream })).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
    }
    expect(await socket.emitWithAck('subscribe', { stream: 'conversation' })).toEqual({ ok: true });
    // Staff-only messages are not handled on the customer namespace at all.
    const noAnswer = await socket.timeout(1_000).emitWithAck('typing', { ticketId: ticket.id, state: 'start' }).then(
      () => 'answered',
      () => 'ignored',
    );
    expect(noAnswer).toBe('ignored');
  });
});
