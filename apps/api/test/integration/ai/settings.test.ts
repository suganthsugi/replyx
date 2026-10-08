import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DEFAULT_LEVEL_MODELS } from '../../../src/ai/providers/catalog.js';
import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { UnitOfWork } from '../../../src/platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../../src/platform-kernel/ids.js';
import { QueueRegistry } from '../../../src/platform-kernel/jobs/queues.js';
import { getTestApp, getTestWorker, service } from '../../support/app.js';
import { createTenant, createUser, type TestTenant, type TestUser } from '../../support/factories.js';
import { asUser } from '../../support/http.js';
import { countEventsOfType, drainOutbox } from '../../support/jobs.js';

/**
 * AI settings (specs/002-ai-assist T009/T010, FR-001 to FR-005): the triad for every route, the key
 * as write-only (never in a response, the audit log, an event or a log line), catalog validation,
 * and pausing on the fake provider's `auth` error until a good test resumes it. The fake provider
 * treats the key `fake-invalid` as rejected (401) and `fake-no-credit` as out of credit (402).
 */

const VALID_KEY = 'sk-or-v1-valid-key-Q7ZX';
const ROUTES = [
  ['get', '/ai/settings'],
  ['patch', '/ai/settings'],
  ['put', '/ai/settings/provider-key'],
  ['delete', '/ai/settings/provider-key'],
  ['post', '/ai/settings/provider-key/test'],
  ['get', '/ai/models'],
] as const;

const BODIES: Partial<Record<string, object>> = {
  'patch /ai/settings': { replyMode: 'drafts' },
  'put /ai/settings/provider-key': { apiKey: VALID_KEY },
};

const contextOf = (tenant: { id: string }) => TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'ai-settings-test' });

/** Everything the tenant stored that could carry the key: audit details and outbox payloads. */
async function storedText(tenant: TestTenant): Promise<string> {
  return (await service(UnitOfWork)).withTenantReadOnly(contextOf(tenant), async (tx) => {
    const audit = await tx.selectFrom('audit_logs').select('details').where('tenant_id', '=', tenant.id).execute();
    const events = await tx.selectFrom('outbox_events').select(['payload', 'customer_payload']).where('tenant_id', '=', tenant.id).execute();
    const settings = await tx.selectFrom('ai_settings').selectAll().where('tenant_id', '=', tenant.id).execute();
    return JSON.stringify({ audit, events, settings });
  });
}

async function auditActions(tenant: TestTenant): Promise<string[]> {
  return (await service(UnitOfWork)).withTenantReadOnly(contextOf(tenant), async (tx) =>
    (await tx.selectFrom('audit_logs').select('action').where('tenant_id', '=', tenant.id).where('action', 'like', 'ai\\_settings.%').orderBy('occurred_at').orderBy('id').execute()).map(
      (row) => row.action,
    ),
  );
}

let logged: string[] = [];
const spies: { mockRestore(): void }[] = [];

beforeAll(async () => {
  await getTestApp();
  // Every Nest log line written while this file runs (app services log through Logger).
  for (const method of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
    spies.push(vi.spyOn(Logger.prototype, method).mockImplementation((...args: unknown[]) => void logged.push(JSON.stringify(args))));
  }
});

afterAll(() => {
  for (const spy of spies) spy.mockRestore();
});

describe('access', () => {
  let admin: TestUser;
  let agent: TestUser;

  beforeAll(async () => {
    const tenant = await createTenant();
    admin = await createUser(tenant, { roles: ['admin'] });
    agent = await createUser(tenant, { roles: ['agent'] });
  });

  for (const [method, path] of ROUTES) {
    it(`${method.toUpperCase()} ${path}: allowed with ai_settings.manage, 403 without`, async () => {
      const body = BODIES[`${method} ${path}`];
      const denied = await asUser(agent)[method](path, body);
      expect(denied.status).toBe(403);
      expect((denied.body as { error: { code: string } }).error.code).toBe('PERMISSION_DENIED');

      if (path === '/ai/settings/provider-key/test') {
        await asUser(admin).put('/ai/settings/provider-key', { apiKey: VALID_KEY });
      }
      const allowed = await asUser(admin)[method](path, body);
      expect(allowed.status).toBe(method === 'delete' ? 204 : 200);
    });
  }
});

describe('settings', () => {
  it('starts off with the catalog defaults and no key', async () => {
    const admin = await createUser(await createTenant(), { roles: ['admin'] });
    const response = await asUser(admin).get('/ai/settings');
    expect(response.body).toEqual({
      replyMode: 'off',
      routingEnabled: false,
      routingThreshold: 0.7,
      models: DEFAULT_LEVEL_MODELS,
      provider: 'openrouter',
      providerKey: null,
      paused: null,
    });
  });

  it('saves the reply mode, routing and models, and audits the change', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const response = await asUser(admin).patch('/ai/settings', {
      replyMode: 'auto',
      routingEnabled: true,
      routingThreshold: 0.8,
      models: { fast: 'qwen/qwen3.7-flash' },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      replyMode: 'auto',
      routingEnabled: true,
      routingThreshold: 0.8,
      models: { fast: 'qwen/qwen3.7-flash', standard: DEFAULT_LEVEL_MODELS.standard, advanced: DEFAULT_LEVEL_MODELS.advanced },
    });
    expect((await asUser(admin).get('/ai/settings')).body).toEqual(response.body);
    expect(await auditActions(tenant)).toEqual(['ai_settings.updated']);
    // Mode changes tell every open conversation to refetch its responder.
    expect(await countEventsOfType(tenant.id, 'ai.responder_scope_changed')).toBe(1);
  });

  it('rejects a model outside the level catalog and a threshold out of range with 400', async () => {
    const admin = await createUser(await createTenant(), { roles: ['admin'] });
    const wrongLevel = await asUser(admin).patch('/ai/settings', { models: { fast: DEFAULT_LEVEL_MODELS.advanced } });
    expect(wrongLevel.status).toBe(400);
    expect(wrongLevel.body).toMatchObject({ error: { code: 'VALIDATION_FAILED', details: [{ path: 'models.fast', issue: 'invalid_model' }] } });
    const unknown = await asUser(admin).patch('/ai/settings', { models: { standard: 'made/up-model' } });
    expect(unknown.status).toBe(400);
    for (const routingThreshold of [0.49, 1]) {
      expect((await asUser(admin).patch('/ai/settings', { routingThreshold })).status).toBe(400);
    }
    expect((await asUser(admin).patch('/ai/settings', {})).status).toBe(400);
    expect((await asUser(admin).patch('/ai/settings', { replyMode: 'sometimes' })).status).toBe(400);
  });

  it('lists the selectable models per level with prices and the defaults marked', async () => {
    const admin = await createUser(await createTenant(), { roles: ['admin'] });
    const response = await asUser(admin).get('/ai/models');
    const body = response.body as { decisionModel: string; levels: Record<string, { id: string; isDefault: boolean; inputPerMillionUsd: number }[]> };
    expect(body.decisionModel).toBe('typesafe/jev-1.13');
    for (const [level, model] of Object.entries(DEFAULT_LEVEL_MODELS)) {
      expect(body.levels[level]?.filter((option) => option.isDefault).map((option) => option.id)).toEqual([model]);
      expect(body.levels[level]?.every((option) => typeof option.inputPerMillionUsd === 'number')).toBe(true);
    }
  });
});

describe('provider key', () => {
  it('is write-only: responses carry last4, and the key is stored sealed and never logged or audited', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    logged = [];

    const saved = await asUser(admin).put('/ai/settings/provider-key', { apiKey: VALID_KEY });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ providerKey: { last4: 'Q7ZX' } });
    const read = await asUser(admin).get('/ai/settings');
    const tested = await asUser(admin).post('/ai/settings/provider-key/test');
    expect(tested.body).toEqual({ ok: true, detail: 'Connected to OpenRouter.', creditRemainingUsd: 5 });

    for (const response of [saved, read, tested]) expect(JSON.stringify(response.body)).not.toContain(VALID_KEY);
    const stored = await storedText(tenant);
    expect(stored).not.toContain(VALID_KEY);
    expect(stored).toContain('v1:');
    expect(logged.join('\n')).not.toContain(VALID_KEY);
    expect(await auditActions(tenant)).toEqual(['ai_settings.key_saved', 'ai_settings.key_tested']);
  });

  it('removes the key; testing without one is 409 AI_KEY_MISSING', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    await asUser(admin).put('/ai/settings/provider-key', { apiKey: VALID_KEY });
    expect((await asUser(admin).delete('/ai/settings/provider-key')).status).toBe(204);
    expect((await asUser(admin).get('/ai/settings')).body).toMatchObject({ providerKey: null });
    const test = await asUser(admin).post('/ai/settings/provider-key/test');
    expect(test.status).toBe(409);
    expect(test.body).toMatchObject({ error: { code: 'AI_KEY_MISSING' } });
  });

  it('rejects a key that is too short with 400', async () => {
    const admin = await createUser(await createTenant(), { roles: ['admin'] });
    expect((await asUser(admin).put('/ai/settings/provider-key', { apiKey: 'short' })).status).toBe(400);
    expect((await asUser(admin).put('/ai/settings/provider-key', { apiKey: VALID_KEY, extra: 1 })).status).toBe(400);
  });

  it('records each connection test as an ai_runs row', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    await asUser(admin).put('/ai/settings/provider-key', { apiKey: VALID_KEY });
    await asUser(admin).post('/ai/settings/provider-key/test');
    const runs = await (await service(UnitOfWork)).withTenantReadOnly(contextOf(tenant), (tx) =>
      tx.selectFrom('ai_runs').select(['purpose', 'outcome']).where('tenant_id', '=', tenant.id).execute(),
    );
    expect(runs).toEqual([{ purpose: 'connection_test', outcome: 'ok' }]);
  });
});

describe('pausing', () => {
  it('pauses on a rejected key, notifies the admins once, and a good test after a key replace resumes', async () => {
    await getTestWorker();
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const otherAdmin = await createUser(tenant, { roles: ['admin'] });
    const agent = await createUser(tenant, { roles: ['agent'] });
    await asUser(admin).patch('/ai/settings', { replyMode: 'auto' });
    await asUser(admin).put('/ai/settings/provider-key', { apiKey: 'fake-invalid' });

    const failed = await asUser(admin).post('/ai/settings/provider-key/test');
    expect(failed.status).toBe(200);
    expect(failed.body).toMatchObject({ ok: false, error: 'invalid_key' });
    const paused = (await asUser(admin).get('/ai/settings')).body as { paused: { reason: string; since: string } | null };
    expect(paused.paused).toMatchObject({ reason: 'invalid_key' });

    // A second failure while paused changes nothing: one pause, one notification each.
    await asUser(admin).post('/ai/settings/provider-key/test');
    expect(await countEventsOfType(tenant.id, 'ai.paused')).toBe(1);
    for (const user of [admin, otherAdmin]) {
      const items = (await asUser(user).get('/notifications')).body as { items: { eventType: string; ticketId: string | null }[] };
      expect(items.items.filter((n) => n.eventType === 'ai.paused')).toEqual([expect.objectContaining({ ticketId: null })]);
    }
    const agentItems = (await asUser(agent).get('/notifications')).body as { items: { eventType: string }[] };
    expect(agentItems.items.some((n) => n.eventType === 'ai.paused')).toBe(false);

    // While paused, a customer message queues no AI work.
    const customer = await createUser(tenant, { roles: ['customer'] });
    expect((await asUser(customer).post('/customer/messages', { body: 'Where is my order?', clientMessageId: uuidv7() })).status).toBe(201);
    await drainOutbox();
    const aiJobs = await (await service(QueueRegistry)).get('ai').getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']);
    expect(aiJobs.filter((job) => JSON.stringify(job.data).includes(tenant.id))).toEqual([]);

    // Replacing the key clears the pause; a good test keeps it clear.
    const replaced = await asUser(admin).put('/ai/settings/provider-key', { apiKey: VALID_KEY });
    expect(replaced.body).toMatchObject({ paused: null });
    expect(await countEventsOfType(tenant.id, 'ai.resumed')).toBe(1);
    expect((await asUser(admin).post('/ai/settings/provider-key/test')).body).toMatchObject({ ok: true });
    expect(await auditActions(tenant)).toEqual([
      'ai_settings.updated',
      'ai_settings.key_saved',
      'ai_settings.key_tested',
      'ai_settings.paused',
      'ai_settings.key_tested',
      'ai_settings.key_saved',
      'ai_settings.resumed',
      'ai_settings.key_tested',
    ]);
  });

  it('pauses with no_credit when the account is out of credit', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    await asUser(admin).put('/ai/settings/provider-key', { apiKey: 'fake-no-credit' });
    expect((await asUser(admin).post('/ai/settings/provider-key/test')).body).toMatchObject({ ok: false, error: 'no_credit' });
    expect((await asUser(admin).get('/ai/settings')).body).toMatchObject({ paused: { reason: 'no_credit' } });
  });
});
