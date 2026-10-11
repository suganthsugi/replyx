import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DIGEST_JOB, type DigestJobData } from '../../../src/notifications/channels/channel-scheduler.js';
import { PushChannel, type PushTransport } from '../../../src/notifications/channels/push.channel.js';
import { NotificationsConsumer } from '../../../src/notifications/notifications.consumer.js';
import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../../src/platform-kernel/ids.js';
import { QueueRegistry } from '../../../src/platform-kernel/jobs/queues.js';
import { MailQueue, type EmailJobData } from '../../../src/platform-kernel/mail/mail.service.js';
import { getTestApp, getTestWorker, service } from '../../support/app.js';
import { createTenant, createTicket, createUser, type TestTenant, type TestUser } from '../../support/factories.js';
import { asUser } from '../../support/http.js';
import { latestEventId } from '../../support/jobs.js';

import type { PushSubscription } from '../../../src/notifications/channels/push-subscriptions.js';
import type { Job } from 'bullmq';

/**
 * T244: push and email channels (US15, T243). Push goes through a fake transport on the worker's
 * PushChannel and email through a spy on the worker's MailQueue, so nothing leaves the test.
 * Grouped digests are delayed 2 minutes; the tests promote the delayed job instead of waiting.
 *
 * Covers per-channel toggles, the master switch (in-app kept, alerts stopped), burst grouping into
 * one message per channel, no duplicates per (recipient, event, channel), expired subscription
 * clean-up, the push-subscription and notification-defaults endpoints (success / 403 / 400) and
 * that another tenant's defaults are never touched.
 */

interface SentPush {
  endpoint: string;
  payload: { title: string; body: string | null; url: string; tag: string };
}

interface NotificationListBody {
  items: { eventType: string; count: number }[];
}

const SUBSCRIPTION = (name: string): PushSubscription => ({
  endpoint: `https://push.example.com/send/${name}-${uuidv7()}`,
  keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' },
});

let tenant: TestTenant;
let other: TestTenant;
let sent: SentPush[];
let failWith: ((subscription: PushSubscription) => number | undefined) | undefined;
let mailed: EmailJobData[];

class DeliveryRows extends TenantRepository {
  forRecipient(tx: TenantTransaction, recipientId: string) {
    return this.selectFrom(tx, 'notification_deliveries')
      .select(['event_id', 'channel', 'status'])
      .where('recipient_id', '=', recipientId)
      .execute();
  }
}

async function deliveries(user: TestUser) {
  const ctx = TenantContext.create({ tenantId: user.tenant.id, actor: { kind: 'system' }, requestId: 'test-deliveries' });
  const unitOfWork = await service(UnitOfWork);
  return unitOfWork.withTenantReadOnly(ctx, (tx) => new DeliveryRows(ctx).forRecipient(tx, user.id));
}

async function digestJobs(recipientId: string, states: ('delayed' | 'waiting' | 'completed' | 'active')[] = ['delayed', 'waiting']): Promise<Job<DigestJobData>[]> {
  const queue = (await service(QueueRegistry)).get('notifications');
  const jobs = (await queue.getJobs(states)) as Job<DigestJobData>[];
  return jobs.filter((job) => job.name === DIGEST_JOB && job.data.recipientId === recipientId);
}

async function subscribe(user: TestUser, name: string): Promise<PushSubscription> {
  const subscription = SUBSCRIPTION(name);
  const response = await asUser(user).post('/notification-preferences/push-subscriptions', subscription);
  expect(response.status).toBe(204);
  return subscription;
}

async function setPreferences(user: TestUser, body: { enabled: boolean; events: Record<string, { inApp?: boolean; push?: boolean; email?: boolean }> }) {
  const response = await asUser(user).put('/notification-preferences', body);
  expect(response.status).toBe(200);
}

const send = (customer: TestUser, body: string) => asUser(customer).post('/customer/messages', { body, clientMessageId: uuidv7() });

beforeAll(async () => {
  await getTestApp();
  const worker = await getTestWorker();
  [tenant, other] = await Promise.all([createTenant(), createTenant()]);

  const transport: PushTransport = (subscription, payload) => {
    const status = failWith?.(subscription);
    if (status !== undefined) return Promise.reject(Object.assign(new Error('push refused'), { statusCode: status }));
    sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) as SentPush['payload'] });
    return Promise.resolve();
  };
  worker.module.get(PushChannel).transport = transport;
  const mail = worker.module.get(MailQueue);
  vi.spyOn(mail, 'enqueue').mockImplementation((data) => {
    mailed.push(data);
    return Promise.resolve();
  });
});

afterEach(() => {
  sent = [];
  mailed = [];
  failWith = undefined;
});
sent = [];
mailed = [];

describe('notification channels: push and email (US15)', () => {
  it('email off and push on for "assigned to me": assigning sends one push and no email (independent test)', async () => {
    const admin = await createUser(tenant, { roles: ['admin'] });
    const agent = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, state: 'open' });
    const subscription = await subscribe(agent, 'agent');
    await setPreferences(agent, { enabled: true, events: { 'ticket.assigned_to_me': { push: true, email: false } } });

    expect((await asUser(admin).patch(`/tickets/${ticket.id}`, { ownerId: agent.id })).status).toBe(200);

    await vi.waitFor(() => expect(sent.filter((push) => push.endpoint === subscription.endpoint)).toHaveLength(1), { timeout: 15_000 });
    const push = sent.find((entry) => entry.endpoint === subscription.endpoint);
    expect(push?.payload).toMatchObject({ title: `#${ticket.number} was assigned to you`, url: `/desk/inbox?ticket=${ticket.id}` });
    await vi.waitFor(async () => expect((await deliveries(agent)).filter((row) => row.channel === 'push').map((row) => row.status)).toEqual(['sent']));
    expect((await deliveries(agent)).some((row) => row.channel === 'email')).toBe(false);
    expect(mailed.filter((mail) => mail.to === agent.email)).toHaveLength(0);
  });

  it('email on: the assignment arrives as one email with a link to the ticket', async () => {
    const admin = await createUser(tenant, { roles: ['admin'] });
    const agent = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, state: 'open' });
    await setPreferences(agent, { enabled: true, events: { 'ticket.assigned_to_me': { push: false, email: true } } });

    expect((await asUser(admin).patch(`/tickets/${ticket.id}`, { ownerId: agent.id })).status).toBe(200);

    await vi.waitFor(() => expect(mailed.filter((mail) => mail.to === agent.email)).toHaveLength(1), { timeout: 15_000 });
    const email = mailed.find((mail) => mail.to === agent.email);
    expect(email).toMatchObject({ template: 'notice', tenantId: tenant.id });
    expect(email?.vars.title).toBe(`#${ticket.number} was assigned to you`);
    expect(email?.vars.actionUrl).toContain(`/desk/inbox?ticket=${ticket.id}`);
    expect(sent).toHaveLength(0);
  });

  it('master switch off: the in-app entry is still recorded, but no push or email is scheduled', async () => {
    const admin = await createUser(tenant, { roles: ['admin'] });
    const agent = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, state: 'open' });
    await subscribe(agent, 'muted');
    await setPreferences(agent, { enabled: false, events: { 'ticket.assigned_to_me': { inApp: true, push: true, email: true } } });

    expect((await asUser(admin).patch(`/tickets/${ticket.id}`, { ownerId: agent.id })).status).toBe(200);

    await vi.waitFor(async () => {
      const list = (await asUser(agent).get('/notifications')).body as NotificationListBody;
      expect(list.items.map((item) => item.eventType)).toContain('ticket.assigned_to_me');
    });
    const channels = (await deliveries(agent)).map((row) => row.channel);
    expect(channels).toEqual(['in_app']);
    expect(await digestJobs(agent.id)).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(mailed).toHaveLength(0);
  });

  it('a burst of customer messages becomes one digest per channel, and a redelivered event adds nothing', async () => {
    const owner = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'], name: 'Ana' });
    const ticket = await createTicket(tenant, { customer, owner: owner.id, state: 'open' });
    const subscription = await subscribe(owner, 'owner');
    await setPreferences(owner, { enabled: true, events: { 'message.customer_on_my_ticket': { inApp: true, push: true, email: true } } });

    for (const body of ['One', 'Two', 'Three']) expect((await send(customer, body)).status).toBe(201);
    await vi.waitFor(async () => {
      const list = (await asUser(owner).get('/notifications')).body as NotificationListBody;
      expect(list.items.find((item) => item.eventType === 'message.customer_on_my_ticket')?.count).toBe(3);
    });
    await vi.waitFor(async () => expect((await deliveries(owner)).filter((row) => row.channel !== 'in_app')).toHaveLength(6));

    // The same event delivered again: no new delivery rows and no new job.
    const eventId = await latestEventId(tenant.id, 'message.created');
    expect(await (await getTestWorker()).module.get(NotificationsConsumer).process({ tenantId: tenant.id, eventId }, 'channels-redelivery')).toBe('skipped');
    expect((await deliveries(owner)).filter((row) => row.channel !== 'in_app')).toHaveLength(6);

    const jobs = await digestJobs(owner.id, ['delayed']);
    expect(jobs.map((job) => job.data.channel).sort()).toEqual(['email', 'push']);
    for (const job of jobs) await job.promote();

    await vi.waitFor(() => {
      expect(sent.filter((push) => push.endpoint === subscription.endpoint)).toHaveLength(1);
      expect(mailed.filter((mail) => mail.to === owner.email)).toHaveLength(1);
    }, { timeout: 15_000 });
    const push = sent.find((entry) => entry.endpoint === subscription.endpoint);
    expect(push?.payload.title).toBe(`Ana wrote on #${ticket.number} (3 messages)`);
    expect(push?.payload.tag).toBe(`ticket:${ticket.id}:customer_messages`);
    expect(mailed.find((mail) => mail.to === owner.email)?.vars.title).toBe(`Ana wrote on #${ticket.number} (3 messages)`);
    await vi.waitFor(async () => {
      const statuses = (await deliveries(owner)).filter((row) => row.channel !== 'in_app').map((row) => row.status);
      expect(new Set(statuses)).toEqual(new Set(['sent']));
    });
  });

  it('turning the master switch off before a digest is sent skips it', async () => {
    const owner = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    await createTicket(tenant, { customer, owner: owner.id, state: 'open' });
    await subscribe(owner, 'late-mute');
    await setPreferences(owner, { enabled: true, events: { 'message.customer_on_my_ticket': { push: true, email: false } } });

    expect((await send(customer, 'Hello')).status).toBe(201);
    await vi.waitFor(async () => expect(await digestJobs(owner.id, ['delayed'])).toHaveLength(1));
    await setPreferences(owner, { enabled: false, events: {} });
    const [job] = await digestJobs(owner.id, ['delayed']);
    await job!.promote();

    await vi.waitFor(async () => expect((await deliveries(owner)).filter((row) => row.channel === 'push').map((row) => row.status)).toEqual(['skipped']));
    expect(sent).toHaveLength(0);
  });

  it('a subscription the push service reports as gone (410) is removed; the other browser still gets the push', async () => {
    const admin = await createUser(tenant, { roles: ['admin'] });
    const agent = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, state: 'open' });
    const gone = await subscribe(agent, 'gone');
    const alive = await subscribe(agent, 'alive');
    failWith = (subscription) => (subscription.endpoint === gone.endpoint ? 410 : undefined);

    expect((await asUser(admin).patch(`/tickets/${ticket.id}`, { ownerId: agent.id })).status).toBe(200);
    await vi.waitFor(() => expect(sent.map((push) => push.endpoint)).toContain(alive.endpoint), { timeout: 15_000 });

    // Only the live browser is left: the next push reaches it alone.
    failWith = undefined;
    sent = [];
    const second = await createTicket(tenant, { customer, state: 'open' });
    expect((await asUser(admin).patch(`/tickets/${second.id}`, { ownerId: agent.id })).status).toBe(200);
    await vi.waitFor(() => expect(sent.map((push) => push.endpoint)).toEqual([alive.endpoint]), { timeout: 15_000 });
  });

  it('POST /notification-preferences/push-subscriptions refuses non-https, IP and localhost endpoints (400)', async () => {
    const agent = await createUser(tenant, { roles: ['admin'] });
    const keys = SUBSCRIPTION('x').keys;
    for (const endpoint of ['http://push.example.com/a', 'https://10.0.0.5/a', 'https://localhost/a', 'https://[::1]/a', 'https://api.internal/a', 'not a url']) {
      const response = await asUser(agent).post('/notification-preferences/push-subscriptions', { endpoint, keys });
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    }
    expect((await asUser(agent).post('/notification-preferences/push-subscriptions', { endpoint: 'https://push.example.com/a', keys, extra: 1 })).status).toBe(400);
  });

  it('GET /notification-preferences/push-key answers for staff (null without VAPID keys) and 404 for customers', async () => {
    const agent = await createUser(tenant, { roles: ['admin'] });
    const response = await asUser(agent).get('/notification-preferences/push-key');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ publicKey: null });
    const customer = await createUser(tenant, { roles: ['customer'] });
    expect((await asUser(customer).get('/notification-preferences/push-key')).status).toBe(404);
  });
});

describe('/notification-defaults (FR-080)', () => {
  it('an admin reads and changes the defaults; users without their own choice follow them; another tenant is untouched', async () => {
    const admin = await createUser(tenant, { roles: ['admin'] });
    const agent = await createUser(tenant, { roles: ['admin'] });

    const before = await asUser(admin).get('/notification-defaults');
    expect(before.status).toBe(200);
    expect((before.body as { events: Record<string, { email: boolean }> }).events['ticket.assigned_to_me']).toEqual({ inApp: true, push: true, email: false });

    const saved = await asUser(admin).put('/notification-defaults', { events: { 'ticket.assigned_to_me': { email: true } } });
    expect(saved.status).toBe(200);
    expect((saved.body as { events: Record<string, unknown> }).events['ticket.assigned_to_me']).toEqual({ inApp: true, push: true, email: true });

    const preferences = await asUser(agent).get('/notification-preferences');
    expect((preferences.body as { events: Record<string, unknown> }).events['ticket.assigned_to_me']).toEqual({ inApp: true, push: true, email: true });

    const otherAdmin = await createUser(other, { roles: ['admin'] });
    const otherDefaults = await asUser(otherAdmin).get('/notification-defaults');
    expect((otherDefaults.body as { events: Record<string, unknown> }).events['ticket.assigned_to_me']).toEqual({ inApp: true, push: true, email: false });

    const audit = await asUser(admin).get('/audit-logs?action=notification_defaults.changed');
    expect(audit.status).toBe(200);
    expect((audit.body as { items: { action: string }[] }).items.some((entry) => entry.action === 'notification_defaults.changed')).toBe(true);
  });

  it('staff without tenant_settings permissions get 403; unknown events are 400', async () => {
    const admin = await createUser(tenant, { roles: ['admin'] });
    const agent = await createUser(tenant, { roles: ['agent'] });
    expect((await asUser(agent).get('/notification-defaults')).status).toBe(403);
    expect((await asUser(agent).put('/notification-defaults', { events: {} })).status).toBe(403);
    expect((await asUser(admin).put('/notification-defaults', { events: { 'no.such_event': { push: true } } })).status).toBe(400);
  });
});
