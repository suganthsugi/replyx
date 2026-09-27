import { beforeAll, describe, expect, it, vi } from 'vitest';

import { NotificationsConsumer } from '../../../src/notifications/notifications.consumer.js';
import { uuidv7 } from '../../../src/platform-kernel/ids.js';
import { getTestApp, getTestWorker } from '../../support/app.js';
import { createRole, createTenant, createTicket, createUser, type TestTenant } from '../../support/factories.js';
import { asUser } from '../../support/http.js';
import { latestEventId } from '../../support/jobs.js';
import { connectSocket, waitForEvent } from '../../support/socket.js';

import type { Socket } from 'socket.io-client';

/**
 * T167: domain events become notification-center entries (notifications.consumer.ts, T163) and
 * reach the recipient's `user` stream and `/notifications` (notifications.service.ts, T164).
 * Cross-tenant coverage for the `notification` fixture (test/cross-tenant/fixtures.ts): the
 * generated suite checks GET /notifications and GET /notification-preferences (lists with no
 * path parameter); POST /notifications/read takes ids in the body, so it is checked by hand here.
 */

interface Envelope {
  id: string;
  type: string;
  stream: string;
  data: Record<string, unknown>;
}

interface NotificationDto {
  id: string;
  eventType: string;
  title: string;
  summary: string | null;
  ticketId: string | null;
  count: number;
  read: boolean;
  createdAt: string;
}

interface NotificationListBody {
  items: NotificationDto[];
  unreadCount: number;
  nextCursor: string | null;
}

const envelope = (socket: Socket, match: (e: Envelope) => boolean, timeoutMs = 10_000) => waitForEvent<Envelope>(socket, 'event', match, timeoutMs);

/** Resolves `true` if a matching envelope arrives within `ms`, `false` otherwise. */
const arrives = (socket: Socket, match: (e: Envelope) => boolean, ms: number) => envelope(socket, match, ms).then(() => true, () => false);

const send = (customer: Awaited<ReturnType<typeof createUser>>, body: string) => asUser(customer).post('/customer/messages', { body, clientMessageId: uuidv7() });

let tenant: TestTenant;
let other: TestTenant;

beforeAll(async () => {
  await getTestApp();
  await getTestWorker();
  [tenant, other] = await Promise.all([createTenant(), createTenant()]);
});

describe('notifications: domain events become notification-center entries', () => {
  it('several customer messages before the first reply produce exactly one "new ticket" notification', async () => {
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const socket = await connectSocket(admin);
    try {
      const created = envelope(socket, (e) => e.type === 'notification.created');
      expect((await send(customer, 'Anyone there?')).status).toBe(201);
      const first = await created;
      expect(first).toMatchObject({ stream: 'user', data: { eventType: 'ticket.ungrouped_created', count: 1 } });

      // Until support replies, further customer messages on the same (still unassigned) ticket
      // add nothing more: the "new ticket" notification above already stands for them.
      const nothingMore = arrives(socket, (e) => e.type === 'notification.created' || e.type === 'notification.updated', 1_500);
      expect((await send(customer, 'Still there?')).status).toBe(201);
      expect((await send(customer, 'Hello?')).status).toBe(201);
      expect(await nothingMore).toBe(false);

      const list = await asUser(admin).get('/notifications');
      expect(list.status).toBe(200);
      const body = list.body as NotificationListBody;
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({ eventType: 'ticket.ungrouped_created', count: 1, read: false });
      expect(body.unreadCount).toBe(1);
    } finally {
      socket.close();
    }
  });

  it('a burst of the same customer on an already-assigned ticket groups into one entry with a growing count', async () => {
    const owner = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    await createTicket(tenant, { customer, owner: owner.id, state: 'open' });
    const socket = await connectSocket(owner);
    try {
      const createdEnvelope = envelope(socket, (e) => e.type === 'notification.created');
      expect((await send(customer, 'One')).status).toBe(201);
      const createdPayload = (await createdEnvelope).data as { id: string; count: number; eventType: string };
      expect(createdPayload).toMatchObject({ count: 1, eventType: 'message.customer_on_my_ticket' });

      const updated1 = envelope(socket, (e) => e.type === 'notification.updated' && e.data.id === createdPayload.id);
      expect((await send(customer, 'Two')).status).toBe(201);
      expect((await updated1).data).toEqual({ id: createdPayload.id, count: 2 });

      const updated2 = envelope(socket, (e) => e.type === 'notification.updated' && e.data.id === createdPayload.id);
      expect((await send(customer, 'Three')).status).toBe(201);
      expect((await updated2).data).toEqual({ id: createdPayload.id, count: 3 });

      const list = await asUser(owner).get('/notifications');
      const entry = (list.body as NotificationListBody).items.find((item) => item.id === createdPayload.id);
      expect(entry).toMatchObject({ eventType: 'message.customer_on_my_ticket', count: 3, read: false });
    } finally {
      socket.close();
    }
  });

  it('never delivers the same domain event twice: redelivery is skipped and adds nothing (idempotent retry)', async () => {
    const owner = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    await createTicket(tenant, { customer, owner: owner.id, state: 'open' });

    expect((await send(customer, 'Hello')).status).toBe(201);
    await vi.waitFor(async () => {
      const list = await asUser(owner).get('/notifications');
      expect((list.body as NotificationListBody).items.length).toBeGreaterThan(0);
    });

    const before = (await asUser(owner).get('/notifications')).body as NotificationListBody;
    expect(before.items).toHaveLength(1);
    expect(before.items[0]?.count).toBe(1);

    const eventId = await latestEventId(tenant.id, 'message.created');
    const consumer = (await getTestWorker()).module.get(NotificationsConsumer);
    const result = await consumer.process({ tenantId: tenant.id, eventId }, 'redelivery-test');
    expect(result).toBe('skipped');

    const after = (await asUser(owner).get('/notifications')).body as NotificationListBody;
    expect(after).toEqual(before);
  });

  it('marking a notification read syncs the unread count to a second socket for the same user', async () => {
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const socketA = await connectSocket(admin);
    const socketB = await connectSocket(admin);
    try {
      const createdA = envelope(socketA, (e) => e.type === 'notification.created');
      const createdB = envelope(socketB, (e) => e.type === 'notification.created');
      expect((await send(customer, 'Hi')).status).toBe(201);
      const [payloadA] = await Promise.all([createdA, createdB]);
      const notificationId = (payloadA.data as { id: string }).id;

      const readA = envelope(socketA, (e) => e.type === 'notification.read');
      const readB = envelope(socketB, (e) => e.type === 'notification.read');
      const marked = await asUser(admin).post('/notifications/read', { ids: [notificationId] });
      expect(marked.status).toBe(200);
      expect(marked.body).toEqual({ unreadCount: 0 });

      expect((await readA).data).toEqual({ ids: [notificationId], unreadCount: 0 });
      expect((await readB).data).toEqual({ ids: [notificationId], unreadCount: 0 });
    } finally {
      socketA.close();
      socketB.close();
    }
  });

  it('@mentions a staff user in an internal note (US6 scenario 3), never the author', async () => {
    const author = await createUser(tenant, { roles: ['admin'], name: 'Priya' });
    const role = await createRole(tenant, { permissions: ['ticket.view', 'ticket.edit'], groups: [{ group: null, flags: { view: true, edit: true } }] });
    const mentioned = await createUser(tenant, { roles: [{ id: role.id }] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, state: 'open' });

    const socket = await connectSocket(mentioned);
    try {
      const mentionEvent = envelope(socket, (e) => e.type === 'notification.created');
      const response = await asUser(author).post(`/tickets/${ticket.id}/messages`, {
        visibility: 'internal',
        body: 'Can you take a look?',
        clientMessageId: uuidv7(),
        mentionIds: [mentioned.id],
      });
      expect(response.status).toBe(201);

      const event = await mentionEvent;
      expect(event).toMatchObject({ stream: 'user', data: { eventType: 'mention' } });
      expect((event.data as { title: string }).title).toContain('in a note');

      const list = (await asUser(mentioned).get('/notifications')).body as NotificationListBody;
      expect(list.items.some((item) => item.eventType === 'mention')).toBe(true);

      // The author never notifies themselves.
      const authorList = (await asUser(author).get('/notifications')).body as NotificationListBody;
      expect(authorList.items).toHaveLength(0);
    } finally {
      socket.close();
    }
  });

  it('customers never receive notifications: a customer session gets 404 on the staff routes, like an unknown route', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    for (const path of ['/notifications', '/notification-preferences']) {
      const response = await asUser(customer).get(path);
      expect(response.status).toBe(404);
      expect(response.body).toEqual((await asUser(customer).get('/no-such-route')).body);
    }
  });

  it("another tenant's notification id in POST /notifications/read changes nothing and leaks nothing (cross-tenant)", async () => {
    const adminA = await createUser(tenant, { roles: ['admin'] });
    const customerA = await createUser(tenant, { roles: ['customer'] });
    expect((await send(customerA, 'Hi')).status).toBe(201);
    await vi.waitFor(async () => {
      const list = await asUser(adminA).get('/notifications');
      expect((list.body as NotificationListBody).items.length).toBeGreaterThan(0);
    });
    const listA = (await asUser(adminA).get('/notifications')).body as NotificationListBody;
    const notificationIdA = listA.items[0]!.id;

    const adminB = await createUser(other, { roles: ['admin'] });
    const crossRead = await asUser(adminB).post('/notifications/read', { ids: [notificationIdA] });
    expect(crossRead.status).toBe(200);
    expect(crossRead.body).toEqual({ unreadCount: 0 });

    const stillUnread = (await asUser(adminA).get('/notifications')).body as NotificationListBody;
    expect(stillUnread.items[0]).toMatchObject({ id: notificationIdA, read: false });
  });
});
