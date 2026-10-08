import { describe, expect, it, vi } from 'vitest';

import { PolicySearch } from '../../../src/ai/knowledge/policy-search.js';
import { AI_PROVIDER } from '../../../src/ai/providers/ports.js';
import { UnitOfWork } from '../../../src/platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../../src/platform-kernel/ids.js';
import { getTestApp, service } from '../../support/app.js';
import { createGroup, createRole, createTenant, createTicket, createUser } from '../../support/factories.js';
import { asUser } from '../../support/http.js';
import { chunkCount, contextOf, createPolicy, newestVersionId, runIndex, uploadFile, uploadFileRaw } from '../../support/policies.js';

import type { FakeAiProvider } from '../../../src/ai/providers/fake/fake.provider.js';

/**
 * Review follow-ups for policy documents (specs/002-ai-assist T014/T015 review): who may upload a
 * policy file, search without an embedding while paused, heading-only passages, and the ordering
 * guarantees of the swap.
 */

const KEY = 'sk-or-v1-valid-key-Q7ZX';
const TEXT = 'Items can be returned within thirty days of delivery for a full refund.';

const error = (response: { body: unknown }) => (response.body as { error: { code: string; details?: { path: string; issue: string }[] } }).error;

async function tenantWithAdmin(key: string | null = KEY) {
  const tenant = await createTenant();
  const admin = await createUser(tenant, { roles: ['admin'] });
  if (key !== null) await asUser(admin).put('/ai/settings/provider-key', { apiKey: key });
  return { tenant, admin };
}

async function runsOf(tenantId: string) {
  return (await service(UnitOfWork)).withTenantReadOnly(contextOf({ id: tenantId }), (tx) =>
    tx.selectFrom('ai_runs').select(['purpose', 'outcome', 'ticket_id']).where('tenant_id', '=', tenantId).execute(),
  );
}

describe('POST /attachments access (RequireAnyPermission)', () => {
  it('allows ticket.edit alone, ai_knowledge.manage alone, and refuses neither with 403', async () => {
    const tenant = await createTenant();
    const ticketOnly = await createUser(tenant, { roles: [await createRole(tenant, { permissions: ['ticket.edit'] })] });
    const policyOnly = await createUser(tenant, { roles: [await createRole(tenant, { permissions: ['ai_knowledge.manage'] })] });
    const neither = await createUser(tenant, { roles: [await createRole(tenant, { permissions: ['ticket.view'] })] });

    expect((await uploadFileRaw(ticketOnly, Buffer.from(TEXT), 'a.txt')).status).toBe(201);
    expect((await uploadFileRaw(policyOnly, Buffer.from(TEXT), 'b.txt')).status).toBe(201);
    const denied = await uploadFileRaw(neither, Buffer.from(TEXT), 'c.txt');
    expect(denied.status).toBe(403);
    expect(error(denied).code).toBe('PERMISSION_DENIED');
  });

  it('is still 404 for a customer on the staff upload route', async () => {
    const tenant = await createTenant();
    const customer = await createUser(tenant, { roles: ['customer'] });
    expect((await uploadFileRaw(customer, Buffer.from(TEXT), 'd.txt')).status).toBe(404);
  });
});

describe('policy files by role', () => {
  it('lets a role with only ai_knowledge.manage upload a file and create a policy from it', async () => {
    const tenant = await createTenant();
    const editor = await createUser(tenant, { roles: [await createRole(tenant, { permissions: ['ai_knowledge.manage'] })] });
    const attachmentId = await uploadFile(editor, Buffer.from(TEXT), 'editor.txt');
    const response = await asUser(editor).post('/ai/policies', { title: 'By editor', attachmentId });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ source: 'file', fileName: 'editor.txt' });
  });

  it('refuses a file uploaded by a ticket-only user with 400 on attachmentId', async () => {
    const tenant = await createTenant();
    const editor = await createUser(tenant, { roles: [await createRole(tenant, { permissions: ['ai_knowledge.manage'] })] });
    const ticketOnly = await createUser(tenant, { roles: [await createRole(tenant, { permissions: ['ticket.edit'] })] });
    const attachmentId = await uploadFile(ticketOnly, Buffer.from(TEXT), 'ticket-user.txt');
    const response = await asUser(editor).post('/ai/policies', { title: 'From ticket user', attachmentId });
    expect(response.status).toBe(400);
    expect(error(response).details).toEqual([{ path: 'attachmentId', issue: 'invalid_value' }]);
  });

  it('refuses an attachment already linked to a message with 400', async () => {
    const { tenant, admin } = await tenantWithAdmin(null);
    const customer = await createUser(tenant, { roles: ['customer'] });
    const group = await createGroup(tenant);
    const ticket = await createTicket(tenant, { customer, group: group.id, messages: [{ body: 'Hello' }] });
    const attachmentId = await uploadFile(admin, Buffer.from(TEXT), 'linked.txt');
    const note = await asUser(admin).post(`/tickets/${ticket.id}/messages`, {
      visibility: 'internal',
      body: 'Internal',
      clientMessageId: uuidv7(),
      attachmentIds: [attachmentId],
      mentionIds: [],
    });
    expect(note.status).toBe(201);
    const response = await asUser(admin).post('/ai/policies', { title: 'Linked', attachmentId });
    expect(response.status).toBe(400);
    expect(error(response).details).toEqual([{ path: 'attachmentId', issue: 'invalid_value' }]);
  });
});

describe('search without a usable key', () => {
  it('answers by full text, without an embedding call or ai_runs row, while the tenant is paused or has no key', async () => {
    const { app } = await getTestApp();
    const provider = app.get<FakeAiProvider>(AI_PROVIDER);
    const embeds = () => provider.calls.filter((call) => call.kind === 'embed').length;
    const { tenant, admin } = await tenantWithAdmin();
    const doc = await createPolicy(admin, { title: 'Quokka', text: 'Quokka adoption fees are refunded in full.' });
    expect((await runIndex(tenant, doc.id, await newestVersionId(admin, doc.id))).outcome).toBe('active');
    const search = await service(PolicySearch);
    const ctx = contextOf(tenant);

    // Active: the query is embedded, and that call is the one new ai_runs row (purpose embedding, no ticket).
    const runsBefore = (await runsOf(tenant.id)).length;
    const embedsBefore = embeds();
    expect((await search.search(ctx, 'quokka fees')).map((p) => p.documentTitle)).toEqual(['Quokka']);
    expect(embeds() - embedsBefore).toBe(1);
    expect((await runsOf(tenant.id)).slice(runsBefore)).toEqual([{ purpose: 'embedding', outcome: 'ok', ticket_id: null }]);

    // Paused after a rejected key.
    await asUser(admin).put('/ai/settings/provider-key', { apiKey: 'fake-invalid' });
    await asUser(admin).post('/ai/settings/provider-key/test');
    expect((await asUser(admin).get('/ai/settings')).body).toMatchObject({ paused: { reason: 'invalid_key' } });
    const pausedRuns = (await runsOf(tenant.id)).length;
    const pausedEmbeds = embeds();
    expect((await search.search(ctx, 'quokka fees')).map((p) => p.documentTitle)).toEqual(['Quokka']);
    expect(embeds()).toBe(pausedEmbeds);
    expect((await runsOf(tenant.id)).length).toBe(pausedRuns);

    // No key at all.
    await asUser(admin).delete('/ai/settings/provider-key');
    expect((await search.search(ctx, 'quokka fees')).map((p) => p.documentTitle)).toEqual(['Quokka']);
    expect(embeds()).toBe(pausedEmbeds);
    expect((await runsOf(tenant.id)).length).toBe(pausedRuns);
  });
});

describe('chunks', () => {
  it('keeps a heading with no body as a passage that full-text search finds', async () => {
    const { tenant, admin } = await tenantWithAdmin();
    const doc = await createPolicy(admin, { title: 'Headings', text: '# Wombat exchanges\n\n# Shipping\nParcels leave on Monday.' });
    expect((await runIndex(tenant, doc.id, await newestVersionId(admin, doc.id))).outcome).toBe('active');
    expect(await chunkCount(tenant, doc.id)).toBe(2);
    // Without a key only full-text answers, so only passages that match come back.
    await asUser(admin).delete('/ai/settings/provider-key');
    const found = await (await service(PolicySearch)).search(contextOf(tenant), 'wombat');
    expect(found).toEqual([{ documentTitle: 'Headings', heading: 'Wombat exchanges', content: 'Wombat exchanges' }]);
  });

  it('fails a text of more than 500 passages as too_large and leaves the old version serving', async () => {
    const { tenant, admin } = await tenantWithAdmin();
    const doc = await createPolicy(admin, { title: 'Big', text: 'Original stays.' });
    expect((await runIndex(tenant, doc.id, await newestVersionId(admin, doc.id))).outcome).toBe('active');
    const many = Array.from({ length: 501 }, (_, i) => `# Part ${i}\nBody ${i}.`).join('\n');
    const created = await asUser(admin).post(`/ai/policies/${doc.id}/versions`, { text: many });
    const id = (created.body as { id: string }).id;
    expect((await runIndex(tenant, doc.id, id)).outcome).toBe('failed');
    const detail = (await asUser(admin).get(`/ai/policies/${doc.id}`)).body as { versions: { id: string; error: string | null }[] };
    expect(detail.versions[0]).toMatchObject({ id, error: 'too_large' });
    expect(await chunkCount(tenant, doc.id)).toBe(1);
  });
});

describe('the swap', () => {
  it('ends with no passages and a document that is never returned when it is deleted between reading and swapping', async () => {
    const { app } = await getTestApp();
    const provider = app.get<FakeAiProvider>(AI_PROVIDER);
    const { tenant, admin } = await tenantWithAdmin();
    const doc = await createPolicy(admin, { title: 'Doomed', text: 'Narwhal policy applies to everyone.' });
    const versionId = await newestVersionId(admin, doc.id);

    // The job has read and chunked the version when it calls the provider: delete then.
    const original = provider.embed.bind(provider);
    const spy = vi.spyOn(provider, 'embed').mockImplementationOnce(async (credentials, request) => {
      expect((await asUser(admin).delete(`/ai/policies/${doc.id}`)).status).toBe(204);
      return original(credentials, request);
    });
    try {
      expect((await runIndex(tenant, doc.id, versionId)).outcome).toBe('skipped');
    } finally {
      spy.mockRestore();
    }
    expect(await chunkCount(tenant, doc.id)).toBe(0);
    expect(await (await service(PolicySearch)).search(contextOf(tenant), 'narwhal policy')).toEqual([]);
    expect(((await asUser(admin).get('/ai/policies')).body as { items: unknown[] }).items).toEqual([]);
  });

  it('shows search only the old passages or only the new ones, never a mix', async () => {
    const { app } = await getTestApp();
    const provider = app.get<FakeAiProvider>(AI_PROVIDER);
    const { tenant, admin } = await tenantWithAdmin();
    const search = await service(PolicySearch);
    const sections = (word: string) => Array.from({ length: 4 }, (_, i) => `# ${word} ${i}\n${word} passage number ${i} about returns.`).join('\n\n');
    const doc = await createPolicy(admin, { title: 'Swap', text: sections('Alpaca') });
    expect((await runIndex(tenant, doc.id, await newestVersionId(admin, doc.id))).outcome).toBe('active');
    const created = await asUser(admin).post(`/ai/policies/${doc.id}/versions`, { text: sections('Ibex') });
    const newVersion = (created.body as { id: string }).id;
    const kinds = (passages: { content: string }[]) => new Set(passages.map((p) => (p.content.startsWith('Alpaca') ? 'old' : 'new')));

    // At the provider call the swap has not happened: only old passages, deterministically.
    const original = provider.embed.bind(provider);
    let beforeSwap: Set<string> | undefined;
    const spy = vi.spyOn(provider, 'embed').mockImplementation(async (credentials, request) => {
      // Only the indexer's call (4 passages); the racing searches embed a single query.
      if (request.inputs.length === 4 && beforeSwap === undefined) beforeSwap = kinds(await search.search(contextOf(tenant), 'passage returns'));
      return original(credentials, request);
    });
    // Searches racing the swap transaction see one version at a time, whichever side they land on.
    const racing = Promise.all(Array.from({ length: 12 }, () => search.search(contextOf(tenant), 'passage returns')));
    let outcome;
    let seen;
    try {
      [outcome, seen] = await Promise.all([runIndex(tenant, doc.id, newVersion), racing]);
    } finally {
      spy.mockRestore();
    }
    expect(outcome.outcome).toBe('active');
    expect([...(beforeSwap ?? [])]).toEqual(['old']);
    for (const passages of seen) expect(kinds(passages).size).toBeLessThanOrEqual(1);
    expect([...kinds(await search.search(contextOf(tenant), 'passage returns'))]).toEqual(['new']);
    expect(await chunkCount(tenant, doc.id)).toBe(4);
  });
});
