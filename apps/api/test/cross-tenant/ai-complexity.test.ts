import { describe, expect, it } from 'vitest';

import { createGroup, createTenant, createUser } from '../support/factories.js';
import { asUser } from '../support/http.js';

/**
 * Complexity settings and group AI descriptions across tenants and permissions (specs/002-ai-assist
 * T031). `/ai/complexity` has no id: tenant B's admin reads and replaces only B's own set, and staff
 * without `ai_settings.manage` get 403. A group AI description is reached through the group, so
 * tenant B's admin gets the unknown-id 404 for A's group.
 */

const FACTOR = {
  key: 'tenant_a_marker',
  label: 'Tenant A marker',
  kind: 'noul',
  weight: 3,
  instructions: 'Decide whether the request mentions tenant A.',
  criteria: { true: 'Yes.', false: 'No.' },
} as const;

describe('complexity across tenants', () => {
  it("403 without ai_settings.manage, and never shows or replaces another tenant's factors", async () => {
    const [a, b] = [await createTenant(), await createTenant()];
    const [adminA, agentA, adminB] = [await createUser(a, { roles: ['admin'] }), await createUser(a, { roles: ['agent'] }), await createUser(b, { roles: ['admin'] })];

    const saved = await asUser(adminA).put('/ai/complexity', { thresholds: { standard: 0.3, advanced: 0.6 }, factors: [FACTOR] });
    expect(saved.status).toBe(200);

    for (const response of [await asUser(agentA).get('/ai/complexity'), await asUser(agentA).put('/ai/complexity', { thresholds: { standard: 0.3, advanced: 0.6 }, factors: [FACTOR] })]) {
      expect([response.status, (response.body as { error?: { code?: string } }).error?.code]).toEqual([403, 'PERMISSION_DENIED']);
    }

    const seenByB = await asUser(adminB).get('/ai/complexity');
    expect(seenByB.status).toBe(200);
    expect(JSON.stringify(seenByB.body)).not.toContain('tenant_a_marker');
    expect(seenByB.body).toMatchObject({ thresholds: { standard: 0.45, advanced: 0.8 } });

    expect((await asUser(adminB).put('/ai/complexity', { thresholds: { standard: 0.5, advanced: 0.9 }, factors: [{ ...FACTOR, key: 'tenant_b_marker' }] })).status).toBe(200);
    expect((await asUser(adminA).get('/ai/complexity')).body).toEqual({ thresholds: { standard: 0.3, advanced: 0.6 }, factors: [FACTOR] });
  });

  it("refuses a customer_tag factor that points at another tenant's tag", async () => {
    const [a, b] = [await createTenant(), await createTenant()];
    const [adminA, adminB] = [await createUser(a, { roles: ['admin'] }), await createUser(b, { roles: ['admin'] })];
    const tagA = (await asUser(adminA).post('/tags', { name: 'VIP A' })).body as { id: string };
    const response = await asUser(adminB).put('/ai/complexity', {
      thresholds: { standard: 0.45, advanced: 0.8 },
      factors: [{ key: 'vip', label: 'VIP', kind: 'customer_tag', weight: 1, tagId: tagA.id }],
    });
    expect(response.status).toBe(400);
    expect((response.body as { error: { details: unknown } }).error.details).toEqual([{ path: 'factors.0.tagId', issue: 'not_found' }]);
  });
});

describe('group AI descriptions across tenants', () => {
  it("gives tenant B's admin the unknown-id 404 for tenant A's group", async () => {
    const [a, b] = [await createTenant(), await createTenant()];
    const adminB = await createUser(b, { roles: ['admin'] });
    const groupA = await createGroup(a);
    const cross = await asUser(adminB).patch(`/groups/${groupA.id}`, { aiDescription: 'Taken over by B' });
    const unknown = await asUser(adminB).patch('/groups/0192f3c4-0000-7000-8000-00000000abcd', { aiDescription: 'Taken over by B' });
    expect([cross.status, cross.body]).toEqual([404, unknown.body]);
  });
});
