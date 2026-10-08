import { beforeAll, describe, expect, it } from 'vitest';

import { AiAudience } from '../../../src/ai/ai-audience.js';
import { ProviderError, type Usage } from '../../../src/ai/providers/ports.js';
import { AiRunsRecorder } from '../../../src/ai/runs/ai-runs.recorder.js';
import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { UnitOfWork } from '../../../src/platform-kernel/db/unit-of-work.js';
import { getTestApp, service } from '../../support/app.js';
import { createTenant, createUser, type TestTenant } from '../../support/factories.js';

/**
 * The AI module skeleton (specs/002-ai-assist T006): permissions granted to Admin only, one
 * `ai_runs` row per provider call with no content, and the admin audience for AI events.
 */

const AI_KEYS = ['ai_knowledge.manage', 'ai_settings.manage', 'ai_usage.view'];

const contextOf = (tenant: { id: string }) =>
  TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'ai-foundation' });

async function rolePermissions(tenant: TestTenant, roleId: string): Promise<string[]> {
  return (await service(UnitOfWork)).withTenantReadOnly(contextOf(tenant), async (tx) =>
    (
      await tx
        .selectFrom('role_permissions')
        .select('permission_key')
        .where('tenant_id', '=', tenant.id)
        .where('role_id', '=', roleId)
        .where('permission_key', 'like', 'ai\\_%')
        .orderBy('permission_key')
        .execute()
    ).map((row) => row.permission_key),
  );
}

async function runsOf(tenant: TestTenant) {
  return (await service(UnitOfWork)).withTenantReadOnly(contextOf(tenant), (tx) =>
    tx.selectFrom('ai_runs').selectAll().where('tenant_id', '=', tenant.id).orderBy('created_at').orderBy('id').execute(),
  );
}

const usage = (costUsd: number | null): Usage => ({ inputTokens: 1_000, outputTokens: 200, costUsd });

let tenant: TestTenant;

beforeAll(async () => {
  await getTestApp();
  tenant = await createTenant();
});

describe('AI permissions', () => {
  it('are granted to the Admin role and to no other default role', async () => {
    expect(await rolePermissions(tenant, tenant.roles.admin)).toEqual(AI_KEYS);
    for (const role of ['manager', 'agent', 'customer'] as const) {
      expect(await rolePermissions(tenant, tenant.roles[role])).toEqual([]);
    }
  });
});

describe('AiRunsRecorder', () => {
  it('records a successful call with the provider cost and no content', async () => {
    const own = await createTenant();
    const recorder = await service(AiRunsRecorder);
    const result = await recorder.track(contextOf(own), { purpose: 'reply', model: 'anthropic/claude-haiku-5.5', level: 'fast' }, () =>
      Promise.resolve({ content: 'Secret reply text', usage: usage(0.0042) }),
    );
    expect(result.content).toBe('Secret reply text');

    const [run, ...rest] = await runsOf(own);
    expect(rest).toEqual([]);
    expect(run).toMatchObject({
      purpose: 'reply',
      provider: 'openrouter',
      model: 'anthropic/claude-haiku-5.5',
      level: 'fast',
      input_tokens: 1_000,
      output_tokens: 200,
      cost_estimated: false,
      outcome: 'ok',
    });
    expect(Number(run?.cost_usd)).toBeCloseTo(0.0042, 6);
    expect(JSON.stringify(run)).not.toContain('Secret reply text');
  });

  it('estimates the cost from list prices when the provider gives none', async () => {
    const own = await createTenant();
    await (await service(AiRunsRecorder)).record(contextOf(own), {
      purpose: 'embedding',
      model: 'openai/text-embedding-3-small',
      outcome: 'ok',
      durationMs: 12,
      usage: usage(null),
    });
    const [run] = await runsOf(own);
    expect(run?.cost_estimated).toBe(true);
    expect(Number(run?.cost_usd)).toBeGreaterThan(0);
  });

  it('records a provider error by kind and rethrows it', async () => {
    const own = await createTenant();
    const recorder = await service(AiRunsRecorder);
    await expect(
      recorder.track(contextOf(own), { purpose: 'routing', model: 'typesafe/jev-1.13' }, () =>
        Promise.reject(new ProviderError('auth', 'Invalid key', 401)),
      ),
    ).rejects.toMatchObject({ kind: 'auth' });

    const [run, ...rest] = await runsOf(own);
    expect(rest).toEqual([]);
    expect(run).toMatchObject({ purpose: 'routing', outcome: 'auth', input_tokens: 0, output_tokens: 0, cost_usd: null, cost_estimated: false });
  });

  it('does not record errors that are not provider errors', async () => {
    const own = await createTenant();
    await expect(
      (await service(AiRunsRecorder)).track(contextOf(own), { purpose: 'reply', model: 'x/y' }, () => Promise.reject(new TypeError('bug'))),
    ).rejects.toBeInstanceOf(TypeError);
    expect(await runsOf(own)).toEqual([]);
  });

  it("never shows one tenant's runs to another", async () => {
    const [a, b] = [await createTenant(), await createTenant()];
    await (await service(AiRunsRecorder)).record(contextOf(a), { purpose: 'draft', model: 'x/y', outcome: 'ok', durationMs: 1 });
    expect(await runsOf(a)).toHaveLength(1);
    // RLS: reading as tenant B sees nothing, even without the tenant filter.
    const seenByB = await (await service(UnitOfWork)).withTenantReadOnly(contextOf(b), (tx) => tx.selectFrom('ai_runs').select('id').execute());
    expect(seenByB).toEqual([]);
  });
});

describe('AiAudience', () => {
  it('targets the user streams of active staff holding the permission', async () => {
    const own = await createTenant();
    const admin = await createUser(own, { roles: ['admin'], session: false });
    await createUser(own, { roles: ['admin'], status: 'deactivated', session: false });
    await createUser(own, { roles: ['agent'], session: false });

    const streams = await (await service(UnitOfWork)).withTenantReadOnly(contextOf(own), (tx) =>
      new AiAudience().streamsFor(tx, contextOf(own), 'ai_settings.manage'),
    );
    expect(streams).toEqual([`user:${admin.id}`]);
  });

  it('falls back to the tenant control stream when nobody holds it', async () => {
    const own = await createTenant();
    const streams = await (await service(UnitOfWork)).withTenantReadOnly(contextOf(own), (tx) =>
      new AiAudience().streamsFor(tx, contextOf(own), 'ai_usage.view'),
    );
    expect(streams).toEqual(['tenant']);
  });
});
