import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { WebhookDeliveryJob, WebhookTransport, type WebhookRequest } from '../../../src/integrations/webhooks/delivery.job.js';
import { verifyWebhookSignature } from '../../../src/integrations/webhooks/webhook-signature.js';
import { WebhookSweepJob } from '../../../src/integrations/webhooks/webhook-sweep.job.js';
import { SecretBox } from '../../../src/platform-kernel/crypto/secret-box.js';
import { PLATFORM_DB, type Database } from '../../../src/platform-kernel/db/database.js';
import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../../src/platform-kernel/ids.js';
import { getTestApp, getTestWorker, service, type TestWorker } from '../../support/app.js';
import { createRole, createTenant, createTicket, createUser, type TestTenant, type TestUser } from '../../support/factories.js';
import { asUser } from '../../support/http.js';

import type { Kysely } from 'kysely';

/**
 * T262 (US18, FR-090, FR-091, research D16): webhooks.
 *
 * - CRUD with success / 403 / 404 and validation; the secret is returned once (create, rotate) and
 *   never listed (the generated cross-tenant suite covers the `webhook` fixture).
 * - The independent test: an endpoint that fails twice then succeeds gets the signed delivery,
 *   and every attempt is in its history.
 * - SSRF: private, loopback, link-local and metadata targets are refused on save and, for a URL
 *   that already points there, at delivery time; plain http is refused outside development.
 * - Internal notes are never sent; another tenant's endpoints never get this tenant's events; a
 *   switched-off endpoint gets nothing; suspended tenants' deliveries wait; deliveries go after
 *   30 days.
 *
 * The receiving endpoint is the worker's `WebhookTransport`, stubbed per test; the SSRF cases use
 * the real one (it refuses before connecting).
 */

const WAIT = { timeout: 20_000, interval: 200 };

interface DeliveryRowView {
  id: string;
  attempt: number;
  status: string;
  event_type: string;
  response_code: number | null;
  error: string | null;
  next_attempt_at: Date | null;
  body: string;
}

let worker: TestWorker;
let sent: WebhookRequest[];

class WebhookRows extends TenantRepository {
  deliveries(tx: TenantTransaction, webhookId?: string) {
    let query = this.selectFrom(tx, 'webhook_deliveries').select([
      'webhook_deliveries.id',
      'webhook_deliveries.attempt',
      'webhook_deliveries.status',
      'webhook_deliveries.event_type',
      'webhook_deliveries.response_code',
      'webhook_deliveries.error',
      'webhook_deliveries.next_attempt_at',
      'webhook_deliveries.body',
    ]);
    if (webhookId !== undefined) query = query.where('webhook_deliveries.webhook_id', '=', webhookId);
    return query.orderBy('webhook_deliveries.created_at').orderBy('webhook_deliveries.attempt').execute();
  }

  /** A stored endpoint the save-time check would refuse: a URL whose host now points inside. */
  insertWebhook(tx: TenantTransaction, url: string, secretEncrypted: string) {
    return this.insertInto(tx, 'webhooks', { url, events: ['ticket.created'], enabled: true, secret_encrypted: secretEncrypted, created_by: null }).returning('id').executeTakeFirstOrThrow();
  }

  insertOld(tx: TenantTransaction, webhookId: string, createdAt: Date) {
    return this.insertInto(tx, 'webhook_deliveries', {
      webhook_id: webhookId,
      event_id: uuidv7(),
      event_type: 'ticket.created',
      attempt: 1,
      status: 'succeeded',
      body: '{}',
      created_at: createdAt,
    }).execute();
  }

  auditActions(tx: TenantTransaction, webhookId: string) {
    return this.selectFrom(tx, 'audit_logs').select(['audit_logs.action', 'audit_logs.details']).where('audit_logs.resource_id', '=', webhookId).orderBy('audit_logs.occurred_at').execute();
  }
}

async function rows<T>(t: TestTenant, run: (repo: WebhookRows, tx: TenantTransaction) => Promise<T>): Promise<T> {
  const ctx = TenantContext.create({ tenantId: t.id, actor: { kind: 'system' }, requestId: 'test-webhooks' });
  return (await service(UnitOfWork)).withTenant(ctx, (tx) => run(new WebhookRows(ctx), tx));
}

const deliveriesOf = (t: TestTenant, webhookId?: string): Promise<DeliveryRowView[]> => rows(t, (repo, tx) => repo.deliveries(tx, webhookId));

async function createWebhook(user: TestUser, body: Record<string, unknown> = {}): Promise<{ id: string; secret: string }> {
  const response = await asUser(user).post('/webhooks', { url: 'https://hooks.example.invalid/replyx', events: ['ticket.created'], enabled: true, ...body });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body as { id: string; secret: string };
}

async function customerWrites(t: TestTenant, body = 'Help please'): Promise<TestUser> {
  const customer = await createUser(t, { roles: ['customer'] });
  expect((await asUser(customer).post('/customer/messages', { body, clientMessageId: uuidv7() })).status).toBe(201);
  return customer;
}

/** The endpoint answers each request with the next status (the last one repeats). */
function endpointAnswers(...statuses: number[]): void {
  let call = 0;
  vi.spyOn(worker.module.get(WebhookTransport), 'send').mockImplementation((request: WebhookRequest) => {
    sent.push(request);
    const status = statuses[Math.min(call, statuses.length - 1)]!;
    call += 1;
    return Promise.resolve({ status });
  });
}

const deliveryJob = () => worker.module.get(WebhookDeliveryJob);
const sweepJob = () => worker.module.get(WebhookSweepJob);

beforeAll(async () => {
  await getTestApp();
  worker = await getTestWorker();
});

afterEach(() => {
  vi.restoreAllMocks();
  sent = [];
});

sent = [];

describe('/webhooks CRUD', () => {
  it('creates with a one-time secret, lists without it, replaces, rotates and deletes; audited without the URL', async () => {
    const t = await createTenant();
    const admin = await createUser(t, { roles: ['admin'] });
    const created = await createWebhook(admin, { url: 'https://hooks.example.invalid/in?token=abc', events: ['ticket.created', 'message.created', 'ticket.created'] });
    expect(created.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(created).toMatchObject({ url: 'https://hooks.example.invalid/in?token=abc', events: ['ticket.created', 'message.created'], enabled: true, lastDeliveryStatus: null });

    const listed = await asUser(admin).get('/webhooks');
    const listedBody = listed.body as { items: Record<string, unknown>[] };
    expect(listed.status).toBe(200);
    expect(listedBody.items).toEqual([expect.objectContaining({ id: created.id })]);
    expect(JSON.stringify(listed.body)).not.toContain(created.secret);
    expect(listedBody.items[0]).not.toHaveProperty('secret');

    const replaced = await asUser(admin).put(`/webhooks/${created.id}`, { url: 'https://hooks.example.invalid/v2', events: ['ticket.closed'], enabled: false });
    expect(replaced.status).toBe(200);
    expect(replaced.body).toMatchObject({ url: 'https://hooks.example.invalid/v2', events: ['ticket.closed'], enabled: false });

    const rotated = await asUser(admin).post(`/webhooks/${created.id}/rotate-secret`, {});
    const rotatedSecret = (rotated.body as { secret: string }).secret;
    expect(rotated.status).toBe(200);
    expect(rotatedSecret).toMatch(/^whsec_/);
    expect(rotatedSecret).not.toBe(created.secret);

    expect((await asUser(admin).delete(`/webhooks/${created.id}`)).status).toBe(204);
    expect((await asUser(admin).get('/webhooks')).body).toEqual({ items: [] });

    const audit = await rows(t, (repo, tx) => repo.auditActions(tx, created.id));
    expect(audit.map((entry) => entry.action)).toEqual(['webhook.created', 'webhook.updated', 'webhook.secret_rotated', 'webhook.deleted']);
    expect(audit[0]!.details).toMatchObject({ host: 'hooks.example.invalid', events: ['ticket.created', 'message.created'], enabled: true });
    expect(JSON.stringify(audit)).not.toContain('token=abc');
  });

  it('refuses non-https and internal targets on save, and unknown events', async () => {
    const t = await createTenant();
    const admin = await createUser(t, { roles: ['admin'] });
    const cases: [string, string][] = [
      ['http://hooks.example.invalid/x', 'not_https'],
      ['https://127.0.0.1/x', 'private_address'],
      ['https://10.1.2.3/x', 'private_address'],
      ['https://169.254.169.254/latest/meta-data', 'private_address'],
      ['https://[::1]/x', 'private_address'],
      ['https://localhost/x', 'private_address'],
      ['https://user:pass@hooks.example.invalid/x', 'invalid_url'],
      ['not a url', 'invalid_url'],
    ];
    for (const [url, issue] of cases) {
      const response = await asUser(admin).post('/webhooks', { url, events: ['ticket.created'], enabled: true });
      expect(response.status, url).toBe(400);
      expect((response.body as { error: { details: unknown } }).error.details, url).toEqual([{ path: 'url', issue }]);
    }
    const badEvent = await asUser(admin).post('/webhooks', { url: 'https://hooks.example.invalid/x', events: ['ticket.deleted'], enabled: true });
    expect(badEvent.status).toBe(400);
    const noEvents = await asUser(admin).post('/webhooks', { url: 'https://hooks.example.invalid/x', events: [], enabled: true });
    expect(noEvents.status).toBe(400);
  });

  it('needs webhook permissions; unknown ids are 404', async () => {
    const t = await createTenant();
    const admin = await createUser(t, { roles: ['admin'] });
    const agent = await createUser(t, { roles: ['agent'] });
    const { id } = await createWebhook(admin);
    expect((await asUser(agent).get('/webhooks')).status).toBe(403);
    expect((await asUser(agent).post('/webhooks', { url: 'https://hooks.example.invalid/x', events: ['ticket.created'], enabled: true })).status).toBe(403);
    expect((await asUser(agent).post(`/webhooks/${id}/rotate-secret`, {})).status).toBe(403);
    expect((await asUser(agent).get(`/webhooks/${id}/deliveries`)).status).toBe(403);

    const viewer = await createRole(t, { name: 'Webhook viewer', permissions: ['webhook.view'] });
    const reader = await createUser(t, { roles: [viewer] });
    expect((await asUser(reader).get('/webhooks')).status).toBe(200);
    expect((await asUser(reader).put(`/webhooks/${id}`, { url: 'https://hooks.example.invalid/y', events: ['ticket.created'], enabled: true })).status).toBe(403);

    const unknown = uuidv7();
    expect((await asUser(admin).put(`/webhooks/${unknown}`, { url: 'https://hooks.example.invalid/y', events: ['ticket.created'], enabled: true })).status).toBe(404);
    expect((await asUser(admin).delete(`/webhooks/${unknown}`)).status).toBe(404);
    expect((await asUser(admin).post(`/webhooks/${unknown}/rotate-secret`, {})).status).toBe(404);
    expect((await asUser(admin).get(`/webhooks/${unknown}/deliveries`)).status).toBe(404);
  });
});

describe('delivery', () => {
  it('an endpoint that fails twice then succeeds gets the signed delivery; every attempt is in its history (independent test)', async () => {
    endpointAnswers(500, 503, 200);
    const t = await createTenant();
    const admin = await createUser(t, { roles: ['admin'] });
    const { id: webhookId, secret } = await createWebhook(admin);
    await customerWrites(t);

    const first = await vi.waitFor(async () => {
      const [row] = await deliveriesOf(t, webhookId);
      expect(row?.status).toBe('failed');
      return row!;
    }, WAIT);
    expect(first).toMatchObject({ attempt: 1, response_code: 500, error: 'HTTP 500' });
    // About a minute later (±10% jitter).
    const delay = first.next_attempt_at!.getTime() - worker.clock.nowMs();
    expect(delay).toBeGreaterThanOrEqual(54_000);
    expect(delay).toBeLessThanOrEqual(66_000);

    // Attempt 2 is pending until then; move the clock and run it (the queued job fires in a minute).
    let [, second] = await deliveriesOf(t, webhookId);
    expect(second).toMatchObject({ attempt: 2, status: 'pending' });
    expect(await deliveryJob().process({ tenantId: t.id, deliveryId: second!.id })).toBe('skipped');
    worker.clock.advance(70_000);
    expect(await deliveryJob().process({ tenantId: t.id, deliveryId: second!.id })).toBe('failed');
    [, second] = await deliveriesOf(t, webhookId);
    // About five minutes after attempt 2.
    expect(second!.next_attempt_at!.getTime() - worker.clock.nowMs()).toBeGreaterThanOrEqual(270_000);

    const third = (await deliveriesOf(t, webhookId))[2]!;
    worker.clock.advance(6 * 60_000);
    expect(await deliveryJob().process({ tenantId: t.id, deliveryId: third.id })).toBe('succeeded');

    const history = await deliveriesOf(t, webhookId);
    expect(history.map((row) => [row.attempt, row.status, row.response_code])).toEqual([
      [1, 'failed', 500],
      [2, 'failed', 503],
      [3, 'succeeded', 200],
    ]);

    // Every attempt sent the same signed body with the contract's headers.
    expect(sent).toHaveLength(3);
    const body = JSON.parse(sent[0]!.body) as { id: string; type: string; tenant: { slug: string }; data: { ticket: Record<string, unknown> } };
    expect(body).toMatchObject({ type: 'ticket.created', tenant: { slug: t.slug } });
    expect(body.data.ticket).toMatchObject({ state: expect.any(String) as string, customer: { email: expect.stringContaining('@') as string }, tags: [] });
    sent.forEach((request, index) => {
      expect(request.url).toBe('https://hooks.example.invalid/replyx');
      expect(request.body).toBe(sent[0]!.body);
      expect(request.headers).toMatchObject({
        'Content-Type': 'application/json',
        'User-Agent': 'ReplyX-Webhooks/1',
        'ReplyX-Event-Id': body.id,
        'ReplyX-Event-Type': 'ticket.created',
        'ReplyX-Delivery-Attempt': String(index + 1),
      });
    });
    const last = sent[2]!;
    expect(verifyWebhookSignature(secret, last.headers['ReplyX-Signature']!, last.body, Math.floor(worker.clock.nowMs() / 1000))).toBe(true);
    expect(verifyWebhookSignature('whsec_wrong', last.headers['ReplyX-Signature']!, last.body, Math.floor(worker.clock.nowMs() / 1000))).toBe(false);
    expect(verifyWebhookSignature(secret, last.headers['ReplyX-Signature']!, `${last.body} `, Math.floor(worker.clock.nowMs() / 1000))).toBe(false);

    // The API's history: newest first, paged.
    const page = await asUser(admin).get(`/webhooks/${webhookId}/deliveries?limit=2`);
    const pageBody = page.body as { items: { attempt: number }[]; nextCursor: string };
    expect(page.status).toBe(200);
    expect(pageBody.items.map((item) => item.attempt)).toEqual([3, 2]);
    expect(pageBody.items[0]).not.toHaveProperty('body');
    const rest = await asUser(admin).get(`/webhooks/${webhookId}/deliveries?limit=2&cursor=${pageBody.nextCursor}`);
    expect(rest.body).toMatchObject({ items: [expect.objectContaining({ attempt: 1, status: 'failed', responseCode: 500 })], nextCursor: null });
    expect((await asUser(admin).get('/webhooks')).body).toMatchObject({ items: [{ lastDeliveryStatus: 'succeeded' }] });
  });

  it('gives up after the 8th failed attempt', async () => {
    endpointAnswers(500);
    const t = await createTenant();
    const admin = await createUser(t, { roles: ['admin'] });
    const { id: webhookId } = await createWebhook(admin);
    await customerWrites(t);
    await vi.waitFor(async () => expect((await deliveriesOf(t, webhookId))[0]?.status).toBe('failed'), WAIT);
    for (let attempt = 2; attempt <= 8; attempt += 1) {
      const pending = (await deliveriesOf(t, webhookId)).find((row) => row.status === 'pending')!;
      expect(pending.attempt).toBe(attempt);
      worker.clock.advance(14 * 3_600_000);
      await deliveryJob().process({ tenantId: t.id, deliveryId: pending.id });
    }
    const history = await deliveriesOf(t, webhookId);
    expect(history).toHaveLength(8);
    expect(history.at(-1)).toMatchObject({ attempt: 8, status: 'gave_up', next_attempt_at: null });
  });

  it('refuses private, loopback, link-local and metadata targets at delivery time, and http outside development', async () => {
    const t = await createTenant();
    const sealed = new SecretBox().seal('whsec_test');
    const targets: [string, string][] = [
      ['https://127.0.0.1:9/hook', 'Refused: the host resolves to a private or reserved address'],
      ['https://169.254.169.254/latest/meta-data', 'Refused: the host resolves to a private or reserved address'],
      ['https://[::1]/hook', 'Refused: the host resolves to a private or reserved address'],
      ['https://192.168.1.10/hook', 'Refused: the host resolves to a private or reserved address'],
      ['https://localhost/hook', 'Refused: the host resolves to a private or reserved address'],
      ['http://hooks.example.invalid/hook', 'Refused: the URL must use https'],
    ];
    const ids = new Map<string, string>();
    for (const [url] of targets) ids.set(url, (await rows(t, (repo, tx) => repo.insertWebhook(tx, url, sealed))).id);
    await customerWrites(t);
    for (const [url, error] of targets) {
      await vi.waitFor(async () => expect((await deliveriesOf(t, ids.get(url)))[0], url).toMatchObject({ attempt: 1, status: 'failed', response_code: null, error }), WAIT);
    }
  });

  it('never sends internal notes; public replies carry the message', async () => {
    endpointAnswers(200);
    const t = await createTenant();
    const admin = await createUser(t, { roles: ['admin'] });
    const { id: webhookId } = await createWebhook(admin, { events: ['message.created'] });
    const customer = await createUser(t, { roles: ['customer'] });
    const ticket = await createTicket(t, { customer, state: 'open', owner: admin.id });

    const note = await asUser(admin).post(`/tickets/${ticket.id}/messages`, { visibility: 'internal', body: 'Secret internal note', clientMessageId: uuidv7() });
    expect(note.status).toBe(201);
    const reply = await asUser(admin).post(`/tickets/${ticket.id}/messages`, { visibility: 'public', body: 'Public answer', clientMessageId: uuidv7() });
    expect(reply.status).toBe(201);

    await vi.waitFor(async () => expect(await deliveriesOf(t, webhookId)).toEqual([expect.objectContaining({ status: 'succeeded' })]), WAIT);
    // Give the worker time to (not) act on the note as well.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const all = await deliveriesOf(t, webhookId);
    expect(all).toHaveLength(1);
    const body = JSON.parse(all[0]!.body) as { type: string; data: { ticketId: string; message: Record<string, unknown> } };
    expect(body).toMatchObject({ type: 'message.created', data: { ticketId: ticket.id, message: { authorKind: 'staff', body: 'Public answer', author: { id: admin.id } } } });
    expect(body.data.message).not.toHaveProperty('visibility');
    expect(sent.map((request) => request.body).join('\n')).not.toContain('Secret internal note');
  });

  it('sends ticket.assigned and ticket.closed with their data', async () => {
    endpointAnswers(200);
    const t = await createTenant();
    const admin = await createUser(t, { roles: ['admin'] });
    const { id: webhookId } = await createWebhook(admin, { events: ['ticket.assigned', 'ticket.closed', 'ticket.updated'] });
    const customer = await createUser(t, { roles: ['customer'] });
    const ticket = await createTicket(t, { customer, state: 'resolved' });

    expect((await asUser(admin).patch(`/tickets/${ticket.id}`, { ownerId: admin.id })).status).toBe(200);
    expect((await asUser(admin).patch(`/tickets/${ticket.id}`, { state: 'closed' })).status).toBe(200);
    const bodies = await vi.waitFor(async () => {
      const all = await deliveriesOf(t, webhookId);
      expect(all.map((row) => row.event_type).sort()).toEqual(['ticket.assigned', 'ticket.closed', 'ticket.updated', 'ticket.updated']);
      return all.map((row) => JSON.parse(row.body) as { type: string; data: Record<string, unknown> });
    }, WAIT);
    expect(bodies.find((body) => body.type === 'ticket.assigned')!.data).toMatchObject({ previousOwner: null, owner: { id: admin.id, email: admin.email } });
    expect(bodies.find((body) => body.type === 'ticket.closed')!.data).toMatchObject({ closedBy: 'agent', ticket: { id: ticket.id, state: 'closed' } });
    expect(bodies.find((body) => body.type === 'ticket.updated')!.data).toMatchObject({ changes: expect.any(Array) as unknown[] });
  });

  it("never sends one tenant's events to another tenant's endpoints", async () => {
    endpointAnswers(200);
    const a = await createTenant();
    const b = await createTenant();
    const adminB = await createUser(b, { roles: ['admin'] });
    const { id: hookB } = await createWebhook(adminB, { url: 'https://hooks.example.invalid/tenant-b' });
    const adminA = await createUser(a, { roles: ['admin'] });
    const { id: hookA } = await createWebhook(adminA, { url: 'https://hooks.example.invalid/tenant-a' });

    await customerWrites(a, 'Tenant A only');
    await vi.waitFor(async () => expect(await deliveriesOf(a, hookA)).toEqual([expect.objectContaining({ status: 'succeeded' })]), WAIT);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await deliveriesOf(b, hookB)).toEqual([]);
    // `sent` may also hold retries left by earlier tests; none of it went to tenant B.
    expect(sent.some((request) => request.url === 'https://hooks.example.invalid/tenant-a')).toBe(true);
    expect(sent.some((request) => request.url === 'https://hooks.example.invalid/tenant-b')).toBe(false);
    expect((await asUser(adminB).get(`/webhooks/${hookA}/deliveries`)).status).toBe(404);
  });

  it('sends nothing to a switched-off endpoint, and gives up its pending attempts', async () => {
    endpointAnswers(500);
    const t = await createTenant();
    const admin = await createUser(t, { roles: ['admin'] });
    const { id: webhookId } = await createWebhook(admin);
    await customerWrites(t);
    await vi.waitFor(async () => expect((await deliveriesOf(t, webhookId))[0]?.status).toBe('failed'), WAIT);

    expect((await asUser(admin).put(`/webhooks/${webhookId}`, { url: 'https://hooks.example.invalid/replyx', events: ['ticket.created'], enabled: false })).status).toBe(200);
    const pending = (await deliveriesOf(t, webhookId)).find((row) => row.status === 'pending')!;
    worker.clock.advance(2 * 60_000);
    expect(await deliveryJob().process({ tenantId: t.id, deliveryId: pending.id })).toBe('skipped');
    expect((await deliveriesOf(t, webhookId)).find((row) => row.id === pending.id)).toMatchObject({ status: 'gave_up', error: 'Not sent: the endpoint is switched off' });

    const callsBefore = sent.length;
    await customerWrites(t, 'After switching off');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await deliveriesOf(t, webhookId)).toHaveLength(2);
    expect(sent).toHaveLength(callsBefore);
  });

  it('holds deliveries while the tenant is suspended and sends them after reactivation (FR-004)', async () => {
    endpointAnswers(200);
    const t = await createTenant();
    const admin = await createUser(t, { roles: ['admin'] });
    const { id: webhookId } = await createWebhook(admin);
    const platformDb = (await getTestApp()).app.get<Kysely<Database>>(PLATFORM_DB);
    const setStatus = (status: 'active' | 'suspended') =>
      platformDb.updateTable('tenants').set({ status, suspended_at: status === 'suspended' ? new Date() : null }).where('id', '=', t.id).execute();

    // A pending attempt written as if by the consumer, while the tenant is suspended.
    const customer = await createUser(t, { roles: ['customer'] });
    await createTicket(t, { customer, state: 'open' });
    await setStatus('suspended');
    try {
      const [row] = await rows(t, async (repo, tx) => {
        await tx
          .insertInto('webhook_deliveries')
          .values({ tenant_id: t.id, webhook_id: webhookId, event_id: uuidv7(), event_type: 'ticket.created', attempt: 1, body: '{"id":"x"}', next_attempt_at: worker.clock.now() })
          .execute();
        return repo.deliveries(tx, webhookId);
      });
      expect(await deliveryJob().process({ tenantId: t.id, deliveryId: row!.id })).toBe('paused');
      expect((await deliveriesOf(t, webhookId))[0]!.status).toBe('pending');
      expect(sent).toHaveLength(0);
    } finally {
      await setStatus('active');
    }

    const swept = await sweepJob().sweepTenant(t.id, new Date(worker.clock.nowMs() + 3 * 60_000));
    expect(swept.requeued).toHaveLength(1);
    await vi.waitFor(async () => expect((await deliveriesOf(t, webhookId))[0]!.status).toBe('succeeded'), WAIT);
  });

  it('deletes deliveries older than 30 days', async () => {
    const t = await createTenant();
    const admin = await createUser(t, { roles: ['admin'] });
    const { id: webhookId } = await createWebhook(admin);
    const now = worker.clock.now();
    await rows(t, (repo, tx) => repo.insertOld(tx, webhookId, new Date(now.getTime() - 31 * 86_400_000)));
    await rows(t, (repo, tx) => repo.insertOld(tx, webhookId, new Date(now.getTime() - 29 * 86_400_000)));
    const swept = await sweepJob().sweepTenant(t.id, now);
    expect(swept.purged).toBe(1);
    expect(await deliveriesOf(t, webhookId)).toHaveLength(1);
  });
});
