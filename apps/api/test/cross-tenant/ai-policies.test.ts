import { describe, expect, it } from 'vitest';

import { PolicySearch } from '../../src/ai/knowledge/policy-search.js';
import { UnitOfWork } from '../../src/platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../src/platform-kernel/ids.js';
import { service } from '../support/app.js';
import { createTenant, createUser } from '../support/factories.js';
import { asUser } from '../support/http.js';
import { contextOf, createPolicy, newestVersionId, runIndex } from '../support/policies.js';

/**
 * Policy documents across tenants (specs/002-ai-assist T016, FR-027): the generated suite covers
 * the `/ai/policies/{id}` routes (fixture `ai_knowledge`); this adds what it cannot see, the
 * assistant's own retrieval and the stored passages.
 */

describe('AI policies across tenants', () => {
  it("lists, shows, changes and deletes only the caller's own documents", async () => {
    const [a, b] = [await createTenant(), await createTenant()];
    const adminA = await createUser(a, { roles: ['admin'] });
    const adminB = await createUser(b, { roles: ['admin'] });
    const idA = (await createPolicy(adminA, { title: 'Shared title', text: 'Zebrafish quarantine procedure applies.' })).id;

    // The same title is free in B: titles are unique per tenant.
    const own = await createPolicy(adminB, { title: 'Shared title', text: 'Something else entirely.' });
    expect(own.status).toBe(201);
    expect(own.id).not.toBe(idA);

    const listB = (await asUser(adminB).get('/ai/policies')).body as { items: { id: string }[] };
    expect(listB.items.map((item) => item.id)).toEqual([own.id]);

    const cross = await asUser(adminB).get(`/ai/policies/${idA}`);
    const unknown = await asUser(adminB).get(`/ai/policies/${uuidv7()}`);
    expect([cross.status, cross.body]).toEqual([404, unknown.body]);
    expect((await asUser(adminB).delete(`/ai/policies/${idA}`)).status).toBe(404);
    expect((await asUser(adminB).patch(`/ai/policies/${idA}`, { title: 'Hijacked' })).status).toBe(404);
    expect((await asUser(adminB).post(`/ai/policies/${idA}/versions`, { text: 'Hijacked text' })).status).toBe(404);
    expect((await asUser(adminA).get(`/ai/policies/${idA}`)).body).toMatchObject({ title: 'Shared title', text: null });
  });

  it("treats another tenant's attachment id like a missing one", async () => {
    const [a, b] = [await createTenant(), await createTenant()];
    await createUser(a, { roles: ['admin'] });
    const adminB = await createUser(b, { roles: ['admin'] });
    const response = await asUser(adminB).post('/ai/policies', { title: 'From foreign file', attachmentId: uuidv7() });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: 'VALIDATION_FAILED', details: [{ path: 'attachmentId' }] } });
  });

  it("PolicySearch never returns another tenant's passages, and stores none in its rows", async () => {
    const [a, b] = [await createTenant(), await createTenant()];
    const adminA = await createUser(a, { roles: ['admin'] });
    const adminB = await createUser(b, { roles: ['admin'] });
    for (const admin of [adminA, adminB]) await asUser(admin).put('/ai/settings/provider-key', { apiKey: 'sk-or-v1-valid-key-Q7ZX' });
    const docA = await createPolicy(adminA, { title: 'Refunds A', text: 'Zebrafish refunds are processed within 14 days.' });
    const docB = await createPolicy(adminB, { title: 'Shipping B', text: 'Giraffe shipping takes three business days.' });
    expect((await runIndex(a, docA.id, await newestVersionId(adminA, docA.id))).outcome).toBe('active');
    expect((await runIndex(b, docB.id, await newestVersionId(adminB, docB.id))).outcome).toBe('active');

    const search = await service(PolicySearch);
    const foundByA = await search.search(contextOf(a), 'zebrafish refunds giraffe shipping');
    expect(foundByA.map((p) => p.documentTitle)).toEqual(['Refunds A']);
    const foundByB = await search.search(contextOf(b), 'zebrafish refunds giraffe shipping');
    expect(foundByB.map((p) => p.documentTitle)).toEqual(['Shipping B']);

    // Without a key of its own, a tenant gets full-text results from its own passages only.
    const c = await createTenant();
    expect(await search.search(contextOf(c), 'zebrafish refunds giraffe shipping')).toEqual([]);
    const rows = await (await service(UnitOfWork)).withTenantReadOnly(contextOf(c), (tx) => tx.selectFrom('ai_policy_chunks').select('id').execute());
    expect(rows).toEqual([]);
  });
});
