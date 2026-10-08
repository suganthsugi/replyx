import { describe, expect, it } from 'vitest';

import { createTenant, createUser } from '../support/factories.js';
import { asUser } from '../support/http.js';

/**
 * AI settings across tenants (specs/002-ai-assist T010, FR-027): settings are per tenant, so tenant
 * B's admin reads, changes and tests only its own row. Key, mode, pause and test results never
 * cross. The generated suite (cross-tenant.test.ts, fixture `ai_settings`) covers the reads too.
 */
describe('AI settings across tenants', () => {
  it("never shows or changes another tenant's settings or key", async () => {
    const [a, b] = [await createTenant(), await createTenant()];
    const adminA = await createUser(a, { roles: ['admin'] });
    const adminB = await createUser(b, { roles: ['admin'] });
    await asUser(adminA).put('/ai/settings/provider-key', { apiKey: 'fake-invalid-but-long-A111' });
    await asUser(adminA).patch('/ai/settings', { replyMode: 'auto' });

    const seenByB = await asUser(adminB).get('/ai/settings');
    expect(seenByB.body).toMatchObject({ replyMode: 'off', providerKey: null, paused: null });
    expect(JSON.stringify(seenByB.body)).not.toContain('A111');

    // B has no key of its own: A's key is never used for B's test.
    const testByB = await asUser(adminB).post('/ai/settings/provider-key/test');
    expect(testByB.status).toBe(409);
    expect(testByB.body).toMatchObject({ error: { code: 'AI_KEY_MISSING' } });

    // B's changes stay in B.
    await asUser(adminB).patch('/ai/settings', { replyMode: 'drafts' });
    await asUser(adminB).delete('/ai/settings/provider-key');
    expect((await asUser(adminA).get('/ai/settings')).body).toMatchObject({ replyMode: 'auto', providerKey: { last4: 'A111' } });
  });

  it("pausing one tenant leaves the other running", async () => {
    const [a, b] = [await createTenant(), await createTenant()];
    const adminA = await createUser(a, { roles: ['admin'] });
    const adminB = await createUser(b, { roles: ['admin'] });
    await asUser(adminA).put('/ai/settings/provider-key', { apiKey: 'fake-invalid' });
    await asUser(adminB).put('/ai/settings/provider-key', { apiKey: 'sk-or-v1-valid-B222' });
    await asUser(adminA).post('/ai/settings/provider-key/test');

    expect((await asUser(adminA).get('/ai/settings')).body).toMatchObject({ paused: { reason: 'invalid_key' } });
    expect((await asUser(adminB).get('/ai/settings')).body).toMatchObject({ paused: null });
    const notificationsB = (await asUser(adminB).get('/notifications')).body as { items: { eventType: string }[] };
    expect(notificationsB.items.some((n) => n.eventType === 'ai.paused')).toBe(false);
  });
});
