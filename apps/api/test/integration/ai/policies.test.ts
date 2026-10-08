import { beforeAll, describe, expect, it, vi } from 'vitest';

import { PolicySearch } from '../../../src/ai/knowledge/policy-search.js';
import { AI_PROVIDER } from '../../../src/ai/providers/ports.js';
import { UnitOfWork } from '../../../src/platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../../src/platform-kernel/ids.js';
import { getTestApp, service } from '../../support/app.js';
import { createTenant, createUser, type TestTenant, type TestUser } from '../../support/factories.js';
import { asUser } from '../../support/http.js';
import { drainOutbox } from '../../support/jobs.js';
import { chunkCount, contextOf, createPolicy, newestVersionId, runIndex, scanFile, uploadFile, versionRow } from '../../support/policies.js';

import type { FakeAiProvider } from '../../../src/ai/providers/fake/fake.provider.js';

/**
 * Policy documents (specs/002-ai-assist T016, FR-006 to FR-009, contracts/ai.yaml `/ai/policies*`):
 * the triad for every route, input rules, the title index, attachment checks, and the `ai-index`
 * job's paths. The job runs directly with a stand-in BullMQ job (support/policies.ts), so the 15 s
 * scan wait costs nothing; the last test runs the real worker. The fake provider treats the keys
 * `fake-invalid` as rejected (401), `fake-no-credit` as out of credit (402) and `fake-down` as 503.
 */

const VALID_KEY = 'sk-or-v1-valid-key-Q7ZX';
const TEXT = 'Items can be returned within thirty days of delivery for a full refund.';

interface Setup {
  tenant: TestTenant;
  admin: TestUser;
  agent: TestUser;
}

async function setup(options: { key?: string | null } = {}): Promise<Setup> {
  const tenant = await createTenant();
  const admin = await createUser(tenant, { roles: ['admin'] });
  const agent = await createUser(tenant, { roles: ['agent'] });
  if (options.key !== null) await asUser(admin).put('/ai/settings/provider-key', { apiKey: options.key ?? VALID_KEY });
  return { tenant, admin, agent };
}

/** A policy typed in and indexed to `active`. */
async function activePolicy({ tenant, admin }: Setup, title: string, text: string) {
  const policy = await createPolicy(admin, { title, text });
  const versionId = await newestVersionId(admin, policy.id);
  expect((await runIndex(tenant, policy.id, versionId)).outcome).toBe('active');
  return { id: policy.id, versionId };
}

const error = (response: { body: unknown }) => (response.body as { error: { code: string; details?: { path: string; issue: string }[] } }).error;

/** A one-page PDF, with `text` drawn on it when given. */
function pdf(text?: string): Buffer {
  const stream = text === undefined ? '' : `BT /F1 12 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

let provider: FakeAiProvider;
const embedCalls = () => provider.calls.filter((call) => call.kind === 'embed').length;

beforeAll(async () => {
  const { app } = await getTestApp();
  provider = app.get<FakeAiProvider>(AI_PROVIDER);
});

describe('access: success, 403 and cross-tenant 404 for every route', () => {
  let tenantA: Setup;
  let adminB: TestUser;
  let docId: string;

  beforeAll(async () => {
    tenantA = await setup();
    adminB = await createUser(await createTenant(), { roles: ['admin'] });
    docId = (await createPolicy(tenantA.admin, { title: 'Access policy', text: TEXT })).id;
  });

  it('GET /ai/policies: documented shape; 403 for an agent; B never sees A rows', async () => {
    const ok = await asUser(tenantA.admin).get('/ai/policies');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({
      items: [expect.objectContaining({ id: docId, title: 'Access policy', status: 'processing', error: null, source: 'text', fileName: null, activeSince: null })],
    });
    const denied = await asUser(tenantA.agent).get('/ai/policies');
    expect(denied.status).toBe(403);
    expect(error(denied).code).toBe('PERMISSION_DENIED');
    const cross = await asUser(adminB).get('/ai/policies');
    expect(cross.status).toBe(200);
    expect(JSON.stringify(cross.body)).not.toContain(docId);
  });

  it('POST /ai/policies: 201 with the document; 403 for an agent', async () => {
    const ok = await asUser(tenantA.admin).post('/ai/policies', { title: 'Created', text: TEXT });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ title: 'Created', status: 'processing', source: 'text' });
    const denied = await asUser(tenantA.agent).post('/ai/policies', { title: 'Nope', text: TEXT });
    expect(denied.status).toBe(403);
    expect(error(denied).code).toBe('PERMISSION_DENIED');
    // Creating as B creates in B's own tenant, even with A's title.
    expect((await asUser(adminB).post('/ai/policies', { title: 'Created', text: TEXT })).status).toBe(201);
  });

  it('GET /ai/policies/{id}: detail with versions; 403; cross-tenant equals unknown id', async () => {
    const ok = await asUser(tenantA.admin).get(`/ai/policies/${docId}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ id: docId, text: null, versions: [{ status: 'processing', source: 'text', error: null, createdBy: { id: tenantA.admin.id, avatarUrl: null } }] });
    const denied = await asUser(tenantA.agent).get(`/ai/policies/${docId}`);
    expect(denied.status).toBe(403);
    expect(error(denied).code).toBe('PERMISSION_DENIED');
    const cross = await asUser(adminB).get(`/ai/policies/${docId}`);
    const unknown = await asUser(adminB).get(`/ai/policies/${uuidv7()}`);
    expect([cross.status, cross.body]).toEqual([404, unknown.body]);
  });

  it('PATCH /ai/policies/{id}: renames; 403; cross-tenant equals unknown id', async () => {
    const ok = await asUser(tenantA.admin).patch(`/ai/policies/${docId}`, { title: 'Access policy renamed' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ id: docId, title: 'Access policy renamed' });
    const denied = await asUser(tenantA.agent).patch(`/ai/policies/${docId}`, { title: 'X' });
    expect(denied.status).toBe(403);
    expect(error(denied).code).toBe('PERMISSION_DENIED');
    const cross = await asUser(adminB).patch(`/ai/policies/${docId}`, { title: 'X' });
    const unknown = await asUser(adminB).patch(`/ai/policies/${uuidv7()}`, { title: 'X' });
    expect([cross.status, cross.body]).toEqual([404, unknown.body]);
  });

  it('POST /ai/policies/{id}/versions: 201 with the version; 403; cross-tenant equals unknown id', async () => {
    const ok = await asUser(tenantA.admin).post(`/ai/policies/${docId}/versions`, { text: `${TEXT} Updated.` });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ status: 'processing', source: 'text', error: null, createdBy: { id: tenantA.admin.id } });
    const denied = await asUser(tenantA.agent).post(`/ai/policies/${docId}/versions`, { text: 'x' });
    expect(denied.status).toBe(403);
    expect(error(denied).code).toBe('PERMISSION_DENIED');
    const cross = await asUser(adminB).post(`/ai/policies/${docId}/versions`, { text: 'x' });
    const unknown = await asUser(adminB).post(`/ai/policies/${uuidv7()}/versions`, { text: 'x' });
    expect([cross.status, cross.body]).toEqual([404, unknown.body]);
  });

  it('DELETE /ai/policies/{id}: 204; 403; cross-tenant equals unknown id; gone afterwards', async () => {
    const denied = await asUser(tenantA.agent).delete(`/ai/policies/${docId}`);
    expect(denied.status).toBe(403);
    expect(error(denied).code).toBe('PERMISSION_DENIED');
    const cross = await asUser(adminB).delete(`/ai/policies/${docId}`);
    const unknown = await asUser(adminB).delete(`/ai/policies/${uuidv7()}`);
    expect([cross.status, cross.body]).toEqual([404, unknown.body]);
    expect((await asUser(tenantA.admin).delete(`/ai/policies/${docId}`)).status).toBe(204);
    expect((await asUser(tenantA.admin).get(`/ai/policies/${docId}`)).status).toBe(404);
    expect((await asUser(tenantA.admin).delete(`/ai/policies/${docId}`)).status).toBe(404);
    expect(JSON.stringify((await asUser(tenantA.admin).get('/ai/policies')).body)).not.toContain(docId);
  });
});

describe('input rules', () => {
  let ctx: Setup;
  beforeAll(async () => {
    ctx = await setup({ key: null });
  });

  it('accepts titles of 1 to 200 characters (trimmed) and rejects the rest with 400', async () => {
    const { admin } = ctx;
    expect((await asUser(admin).post('/ai/policies', { title: 'a', text: TEXT })).status).toBe(201);
    expect((await asUser(admin).post('/ai/policies', { title: 'b'.repeat(200), text: TEXT })).status).toBe(201);
    for (const title of ['', '   ', 'c'.repeat(201), 42]) {
      const response = await asUser(admin).post('/ai/policies', { title, text: TEXT });
      expect(response.status, JSON.stringify(title)).toBe(400);
      expect(error(response).code).toBe('VALIDATION_FAILED');
      expect(error(response).details?.[0]?.path).toBe('title');
    }
    const doc = await createPolicy(admin, { title: 'Rename me', text: TEXT });
    for (const title of ['', 'd'.repeat(201)]) expect((await asUser(admin).patch(`/ai/policies/${doc.id}`, { title })).status).toBe(400);
    expect((await asUser(admin).patch(`/ai/policies/${doc.id}`, {})).status).toBe(400);
  });

  it('requires exactly one of text and attachmentId, and rejects unknown fields', async () => {
    const { admin } = ctx;
    const both = await asUser(admin).post('/ai/policies', { title: 'Both', text: TEXT, attachmentId: uuidv7() });
    const neither = await asUser(admin).post('/ai/policies', { title: 'Neither' });
    const empty = await asUser(admin).post('/ai/policies', { title: 'Empty', text: '' });
    const extra = await asUser(admin).post('/ai/policies', { title: 'Extra', text: TEXT, tenantId: uuidv7() });
    for (const response of [both, neither, empty, extra]) {
      expect(response.status).toBe(400);
      expect(error(response).code).toBe('VALIDATION_FAILED');
    }
    const doc = await createPolicy(admin, { title: 'Versioned', text: TEXT });
    const versionBoth = await asUser(admin).post(`/ai/policies/${doc.id}/versions`, { text: TEXT, attachmentId: uuidv7() });
    const versionNeither = await asUser(admin).post(`/ai/policies/${doc.id}/versions`, {});
    expect([versionBoth.status, versionNeither.status]).toEqual([400, 400]);
    // Over the body limit (413) or over the text limit (400): either way it is refused.
    expect([400, 413]).toContain((await asUser(admin).post(`/ai/policies/${doc.id}/versions`, { text: 'x'.repeat(200_001) })).status);
    expect((await asUser(admin).get('/ai/policies/not-a-uuid')).status).toBe(400);
  });

  it('writes nothing for a rejected request', async () => {
    const { admin } = ctx;
    const count = async () => ((await asUser(admin).get('/ai/policies')).body as { items: unknown[] }).items.length;
    const before = await count();
    await asUser(admin).post('/ai/policies', { title: 'Rejected', text: TEXT, attachmentId: uuidv7() });
    expect(await count()).toBe(before);
  });
});

describe('titles', () => {
  it('are unique per tenant, ignoring case, on create and on rename; reusable after delete', async () => {
    const { admin } = await setup({ key: null });
    const first = await createPolicy(admin, { title: 'Returns Policy', text: TEXT });
    expect(first.status).toBe(201);

    const duplicate = await asUser(admin).post('/ai/policies', { title: 'returns policy', text: TEXT });
    expect(duplicate.status).toBe(409);
    expect(error(duplicate).code).toBe('POLICY_TITLE_TAKEN');
    // The failed create leaves nothing behind.
    expect(((await asUser(admin).get('/ai/policies')).body as { items: unknown[] }).items).toHaveLength(1);

    const second = await createPolicy(admin, { title: 'Shipping', text: TEXT });
    const rename = await asUser(admin).patch(`/ai/policies/${second.id}`, { title: 'RETURNS POLICY' });
    expect(rename.status).toBe(409);
    expect(error(rename).code).toBe('POLICY_TITLE_TAKEN');

    // Renaming to the same title, or only changing its case, is the document's own.
    expect((await asUser(admin).patch(`/ai/policies/${first.id}`, { title: 'Returns Policy' })).status).toBe(200);
    expect((await asUser(admin).patch(`/ai/policies/${first.id}`, { title: 'RETURNS policy' })).body).toMatchObject({ title: 'RETURNS policy' });

    expect((await asUser(admin).delete(`/ai/policies/${first.id}`)).status).toBe(204);
    expect((await asUser(admin).post('/ai/policies', { title: 'returns POLICY', text: TEXT })).status).toBe(201);
    expect((await asUser(admin).patch(`/ai/policies/${second.id}`, { title: 'Shipping v2' })).status).toBe(200);
  });
});

describe('attachment sources', () => {
  let ctx: Setup;
  beforeAll(async () => {
    ctx = await setup({ key: null });
  });

  it('accepts a txt, md or pdf upload still being scanned, as a file version', async () => {
    const { admin } = ctx;
    for (const [name, bytes] of [
      ['policy.txt', Buffer.from(TEXT)],
      ['policy.md', Buffer.from(`# Returns\n${TEXT}`)],
      ['policy.pdf', pdf(TEXT)],
    ] as const) {
      const attachmentId = await uploadFile(admin, bytes, name);
      const response = await asUser(admin).post('/ai/policies', { title: name, attachmentId });
      expect(response.status, name).toBe(201);
      expect(response.body).toMatchObject({ source: 'file', fileName: name, status: 'processing' });
    }
  });

  it('rejects an unknown id, a wrong file type and a file over 10 MB with 400 on attachmentId', async () => {
    const { admin } = ctx;
    const unknown = await asUser(admin).post('/ai/policies', { title: 'Unknown file', attachmentId: uuidv7() });
    expect(unknown.status).toBe(400);
    expect(error(unknown).details).toEqual([{ path: 'attachmentId', issue: 'invalid_value' }]);

    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const wrongType = await asUser(admin).post('/ai/policies', { title: 'Image', attachmentId: await uploadFile(admin, png, 'logo.png') });
    expect(wrongType.status).toBe(400);
    expect(error(wrongType).details).toEqual([{ path: 'attachmentId', issue: 'invalid_format' }]);

    const big = await uploadFile(admin, Buffer.alloc(10 * 1024 * 1024 + 1, 'a'), 'big.txt');
    const tooLarge = await asUser(admin).post('/ai/policies', { title: 'Big', attachmentId: big });
    expect(tooLarge.status).toBe(400);
    expect(error(tooLarge).details).toEqual([{ path: 'attachmentId', issue: 'too_large' }]);

    // Same checks on a new version.
    const doc = await createPolicy(admin, { title: 'Versioned file', text: TEXT });
    const version = await asUser(admin).post(`/ai/policies/${doc.id}/versions`, { attachmentId: big });
    expect(version.status).toBe(400);
    expect(error(version).details).toEqual([{ path: 'attachmentId', issue: 'too_large' }]);
  });

  it('rejects a file uploaded by someone without ai_knowledge.manage with 400', async () => {
    const { admin, agent } = ctx;
    const attachmentId = await uploadFile(agent, Buffer.from(TEXT), 'agent.txt');
    const response = await asUser(admin).post('/ai/policies', { title: 'Agent file', attachmentId });
    expect(response.status).toBe(400);
    expect(error(response).details).toEqual([{ path: 'attachmentId', issue: 'invalid_value' }]);
  });

  it('refuses a file the malware scan blocked with 409 ATTACHMENT_BLOCKED', async () => {
    const { tenant, admin } = ctx;
    const attachmentId = await uploadFile(admin, Buffer.from(TEXT), 'infected.txt');
    await scanFile(tenant, attachmentId, { verdict: 'infected', signature: 'Test.Signature' });
    const response = await asUser(admin).post('/ai/policies', { title: 'Infected', attachmentId });
    expect(response.status).toBe(409);
    expect(error(response).code).toBe('ATTACHMENT_BLOCKED');
    const doc = await createPolicy(admin, { title: 'Has versions', text: TEXT });
    expect((await asUser(admin).post(`/ai/policies/${doc.id}/versions`, { attachmentId })).status).toBe(409);
  });
});

describe('indexing', () => {
  it('turns a typed text into passages and an active version, and tells the admins', async () => {
    const { tenant, admin, agent } = await setup();
    const policy = await createPolicy(admin, { title: 'Returns', text: `# Returns\n${TEXT}\n\n# Refunds\nRefunds arrive within five days.` });
    const versionId = await newestVersionId(admin, policy.id);
    expect(await chunkCount(tenant, policy.id)).toBe(0);

    const embedsBefore = embedCalls();
    const result = await runIndex(tenant, policy.id, versionId);
    expect(result.outcome).toBe('active');
    expect(await chunkCount(tenant, policy.id)).toBe(2);
    expect(await versionRow(tenant, versionId)).toEqual({ status: 'active', error: null });

    const listed = ((await asUser(admin).get('/ai/policies')).body as { items: Record<string, unknown>[] }).items[0];
    expect(listed).toMatchObject({ status: 'ready', error: null, source: 'text' });
    expect(listed?.activeSince).toEqual(expect.any(String));
    expect((await asUser(admin).get(`/ai/policies/${policy.id}`)).body).toMatchObject({ text: `# Returns
${TEXT}

# Refunds
Refunds arrive within five days.` });

    // One embedding call for 2 passages, and exactly one ai_runs row for it.
    expect(embedCalls() - embedsBefore).toBe(1);
    const unitOfWork = await service(UnitOfWork);
    const runs = await unitOfWork.withTenantReadOnly(contextOf(tenant), (tx) =>
      tx.selectFrom('ai_runs').select(['purpose', 'outcome', 'model']).where('tenant_id', '=', tenant.id).execute(),
    );
    expect(runs.map(({ purpose, outcome }) => ({ purpose, outcome }))).toEqual([{ purpose: 'embedding', outcome: 'ok' }]);

    // Both events go to the ai_knowledge.manage holders only.
    const events = await unitOfWork.withTenantReadOnly(contextOf(tenant), (tx) =>
      tx.selectFrom('outbox_events').select(['type', 'payload', 'streams']).where('tenant_id', '=', tenant.id).where('type', 'like', 'ai.policy_version_%').orderBy('id').execute(),
    );
    expect(events.map((event) => event.type)).toEqual(['ai.policy_version_created', 'ai.policy_version_updated']);
    expect(events[0]?.payload).toEqual({ documentId: policy.id, versionId });
    expect(events[1]?.payload).toEqual({ documentId: policy.id, versionId, status: 'active' });
    for (const event of events) {
      expect(event.streams).toContain(`user:${admin.id}`);
      expect(event.streams).not.toContain(`user:${agent.id}`);
    }
  });

  it('records one ai_runs row per embedding call (64 passages per call)', async () => {
    const { tenant, admin } = await setup();
    const sections = Array.from({ length: 70 }, (_, i) => `# Section ${i}\nBody of section number ${i}.`).join('\n\n');
    const policy = await createPolicy(admin, { title: 'Many sections', text: sections });
    const embedsBefore = embedCalls();
    expect((await runIndex(tenant, policy.id, await newestVersionId(admin, policy.id))).outcome).toBe('active');
    expect(await chunkCount(tenant, policy.id)).toBe(70);
    expect(embedCalls() - embedsBefore).toBe(2);
    const runs = await (await service(UnitOfWork)).withTenantReadOnly(contextOf(tenant), (tx) =>
      tx.selectFrom('ai_runs').select('purpose').where('tenant_id', '=', tenant.id).execute(),
    );
    expect(runs).toEqual([{ purpose: 'embedding' }, { purpose: 'embedding' }]);
  });

  it('is safe to run twice: a finished version is left alone', async () => {
    const ctx = await setup();
    const { id, versionId } = await activePolicy(ctx, 'Twice', TEXT);
    const embedsBefore = embedCalls();
    expect((await runIndex(ctx.tenant, id, versionId)).outcome).toBe('skipped');
    expect(embedCalls()).toBe(embedsBefore);
  });

  it('serves only the old text while a new version processes, and only the new text after it activates', async () => {
    const ctx = await setup();
    const { tenant, admin } = ctx;
    const search = await service(PolicySearch);
    const passages = async (query: string) => (await search.search(contextOf(tenant), query)).map((passage) => passage.content);
    const oldText = 'Zebrafish returns are accepted within thirty days.';
    const newText = 'Giraffe returns are accepted within sixty days.';
    const doc = await activePolicy(ctx, 'Seasonal', oldText);
    expect(await passages('zebrafish')).toEqual([oldText]);

    const created = await asUser(admin).post(`/ai/policies/${doc.id}/versions`, { text: newText });
    expect(created.status).toBe(201);
    const newVersion = (created.body as { id: string }).id;
    // Processing: the document reads processing, search still answers from version 1 only.
    expect(((await asUser(admin).get('/ai/policies')).body as { items: { status: string }[] }).items[0]?.status).toBe('processing');
    expect(await passages('zebrafish')).toEqual([oldText]);
    expect(await passages('giraffe')).not.toContain(newText);

    expect((await runIndex(tenant, doc.id, newVersion)).outcome).toBe('active');
    expect(await passages('giraffe')).toEqual([newText]);
    expect(await passages('zebrafish')).toEqual([newText]);
    expect(await versionRow(tenant, doc.versionId)).toMatchObject({ status: 'superseded' });
    expect(await chunkCount(tenant, doc.id)).toBe(1);
    expect((await asUser(admin).get(`/ai/policies/${doc.id}`)).body).toMatchObject({ text: newText });
  });

  it('keeps serving the old text when the new version fails, and reports the error', async () => {
    const ctx = await setup();
    const { tenant, admin } = ctx;
    const doc = await activePolicy(ctx, 'Failing edit', 'Walrus policy stays in force.');
    const created = await asUser(admin).post(`/ai/policies/${doc.id}/versions`, { text: '# Only a heading' });
    const failing = (created.body as { id: string }).id;
    expect((await runIndex(tenant, doc.id, failing)).outcome).toBe('failed');
    expect(await versionRow(tenant, failing)).toEqual({ status: 'failed', error: 'no_extractable_text' });
    const listed = ((await asUser(admin).get('/ai/policies')).body as { items: Record<string, unknown>[] }).items[0];
    expect(listed).toMatchObject({ status: 'ready', error: 'no_extractable_text' });
    const search = await service(PolicySearch);
    expect((await search.search(contextOf(tenant), 'walrus')).map((p) => p.content)).toEqual(['Walrus policy stays in force.']);
  });

  it('marks an older version superseded, without activating it, when a newer one is already active', async () => {
    const { tenant, admin } = await setup();
    const doc = await createPolicy(admin, { title: 'Race', text: 'Older text about otters.' });
    const older = await newestVersionId(admin, doc.id);
    const newer = (await asUser(admin).post(`/ai/policies/${doc.id}/versions`, { text: 'Newer text about badgers.' })).body as { id: string };

    expect((await runIndex(tenant, doc.id, newer.id)).outcome).toBe('active');
    expect((await runIndex(tenant, doc.id, older)).outcome).toBe('superseded');
    expect(await versionRow(tenant, older)).toEqual({ status: 'superseded', error: null });
    expect(await versionRow(tenant, newer.id)).toMatchObject({ status: 'active' });
    const search = await service(PolicySearch);
    expect((await search.search(contextOf(tenant), 'otters badgers')).map((p) => p.content)).toEqual(['Newer text about badgers.']);

    const updates = await (await service(UnitOfWork)).withTenantReadOnly(contextOf(tenant), (tx) =>
      tx.selectFrom('outbox_events').select('payload').where('tenant_id', '=', tenant.id).where('type', '=', 'ai.policy_version_updated').orderBy('id').execute(),
    );
    expect(updates.map((event) => (event.payload as { status: string }).status)).toEqual(['active', 'superseded']);
  });

  it('never searches a deleted document, and removes its passages', async () => {
    const ctx = await setup();
    const { tenant, admin } = ctx;
    const doc = await activePolicy(ctx, 'To delete', 'Pangolin policy applies to everyone.');
    const pending = (await asUser(admin).post(`/ai/policies/${doc.id}/versions`, { text: 'Pending pangolin edit.' })).body as { id: string };
    const search = await service(PolicySearch);
    expect(await search.search(contextOf(tenant), 'pangolin')).toHaveLength(1);
    expect(await chunkCount(tenant, doc.id)).toBe(1);

    expect((await asUser(admin).delete(`/ai/policies/${doc.id}`)).status).toBe(204);
    expect(await search.search(contextOf(tenant), 'pangolin policy')).toEqual([]);
    expect(await chunkCount(tenant, doc.id)).toBe(0);
    // The version queued before the delete is dropped by the indexer rather than resurrecting passages.
    expect((await runIndex(tenant, doc.id, pending.id)).outcome).toBe('skipped');
    expect(await chunkCount(tenant, doc.id)).toBe(0);
    expect(await search.search(contextOf(tenant), 'pangolin')).toEqual([]);
  });

  it('waits for a pending scan every 15 s, then indexes once the file is clean', async () => {
    const { tenant, admin } = await setup();
    const attachmentId = await uploadFile(admin, Buffer.from('# Lynx\nLynx deliveries leave on Monday.'), 'lynx.md');
    const doc = await createPolicy(admin, { title: 'Pending scan', attachmentId });
    const versionId = await newestVersionId(admin, doc.id);
    const embedsBefore = embedCalls();

    const before = Date.now();
    const waiting = await runIndex(tenant, doc.id, versionId);
    expect(waiting.outcome).toBe('delayed');
    expect(waiting.data.waits).toBe(1);
    expect(waiting.delayedUntil).toBeGreaterThanOrEqual(before + 15_000);
    expect(waiting.delayedUntil).toBeLessThanOrEqual(Date.now() + 15_000);
    expect(await versionRow(tenant, versionId)).toMatchObject({ status: 'processing' });
    expect(embedCalls()).toBe(embedsBefore);

    await scanFile(tenant, attachmentId, { verdict: 'clean' });
    const done = await runIndex(tenant, doc.id, versionId, { waits: waiting.data.waits });
    expect(done.outcome).toBe('active');
    expect(await chunkCount(tenant, doc.id)).toBe(1);
    expect(((await asUser(admin).get('/ai/policies')).body as { items: Record<string, unknown>[] }).items[0]).toMatchObject({ status: 'ready', source: 'file', fileName: 'lynx.md' });
  });

  it('fails with blocked_by_scan when the scan blocks the file, or never finishes', async () => {
    const { tenant, admin } = await setup();
    const blockedFile = await uploadFile(admin, Buffer.from(TEXT), 'blocked-later.txt');
    const doc = await createPolicy(admin, { title: 'Blocked later', attachmentId: blockedFile });
    const versionId = await newestVersionId(admin, doc.id);
    await scanFile(tenant, blockedFile, { verdict: 'infected', signature: 'Test.Signature' });
    expect((await runIndex(tenant, doc.id, versionId)).outcome).toBe('failed');
    expect(await versionRow(tenant, versionId)).toEqual({ status: 'failed', error: 'blocked_by_scan' });
    expect(((await asUser(admin).get('/ai/policies')).body as { items: Record<string, unknown>[] }).items[0]).toMatchObject({ status: 'failed', error: 'blocked_by_scan' });

    // After 240 polls (an hour) the file counts as not cleared.
    const stuckFile = await uploadFile(admin, Buffer.from(TEXT), 'stuck.txt');
    const stuck = await createPolicy(admin, { title: 'Stuck scan', attachmentId: stuckFile });
    const stuckVersion = await newestVersionId(admin, stuck.id);
    expect((await runIndex(tenant, stuck.id, stuckVersion, { waits: 239 })).outcome).toBe('delayed');
    expect((await runIndex(tenant, stuck.id, stuckVersion, { waits: 240 })).outcome).toBe('failed');
    expect(await versionRow(tenant, stuckVersion)).toEqual({ status: 'failed', error: 'blocked_by_scan' });
  });

  it('reads a PDF with text, and fails a PDF with none as no_extractable_text', async () => {
    const { tenant, admin } = await setup();
    const withText = await uploadFile(admin, pdf('Capybara exchanges close after ninety days'), 'capybara.pdf');
    const textual = await createPolicy(admin, { title: 'PDF with text', attachmentId: withText });
    await scanFile(tenant, withText, { verdict: 'clean' });
    expect((await runIndex(tenant, textual.id, await newestVersionId(admin, textual.id))).outcome).toBe('active');
    const search = await service(PolicySearch);
    expect((await search.search(contextOf(tenant), 'capybara exchanges')).map((p) => p.documentTitle)).toEqual(['PDF with text']);

    const blank = await uploadFile(admin, pdf(), 'blank.pdf');
    const empty = await createPolicy(admin, { title: 'PDF without text', attachmentId: blank });
    const emptyVersion = await newestVersionId(admin, empty.id);
    await scanFile(tenant, blank, { verdict: 'clean' });
    expect((await runIndex(tenant, empty.id, emptyVersion)).outcome).toBe('failed');
    expect(await versionRow(tenant, emptyVersion)).toEqual({ status: 'failed', error: 'no_extractable_text' });
    expect(await chunkCount(tenant, empty.id)).toBe(0);
  });

  it('pauses the tenant and fails the version as embedding_failed when the key is rejected', async () => {
    const { tenant, admin } = await setup({ key: 'fake-invalid' });
    const doc = await createPolicy(admin, { title: 'Rejected key', text: TEXT });
    const versionId = await newestVersionId(admin, doc.id);
    expect((await runIndex(tenant, doc.id, versionId)).outcome).toBe('failed');
    expect(await versionRow(tenant, versionId)).toEqual({ status: 'failed', error: 'embedding_failed' });
    expect((await asUser(admin).get('/ai/settings')).body).toMatchObject({ paused: { reason: 'invalid_key' } });
    const runs = await (await service(UnitOfWork)).withTenantReadOnly(contextOf(tenant), (tx) =>
      tx.selectFrom('ai_runs').select(['purpose', 'outcome']).where('tenant_id', '=', tenant.id).execute(),
    );
    expect(runs).toEqual([{ purpose: 'embedding', outcome: 'auth' }]);

    // While paused no provider call is made for the next version.
    const next = (await asUser(admin).post(`/ai/policies/${doc.id}/versions`, { text: 'Another try.' })).body as { id: string };
    const embedsBefore = embedCalls();
    expect((await runIndex(tenant, doc.id, next.id)).outcome).toBe('failed');
    expect(embedCalls()).toBe(embedsBefore);
    expect(await versionRow(tenant, next.id)).toEqual({ status: 'failed', error: 'embedding_failed' });
  });

  it('pauses with no_credit when the account is out of credit', async () => {
    const { tenant, admin } = await setup({ key: 'fake-no-credit' });
    const doc = await createPolicy(admin, { title: 'No credit', text: TEXT });
    const versionId = await newestVersionId(admin, doc.id);
    expect((await runIndex(tenant, doc.id, versionId)).outcome).toBe('failed');
    expect(await versionRow(tenant, versionId)).toEqual({ status: 'failed', error: 'embedding_failed' });
    expect((await asUser(admin).get('/ai/settings')).body).toMatchObject({ paused: { reason: 'no_credit' } });
  });

  it('fails as embedding_failed, without a call, when the tenant has no key', async () => {
    const { tenant, admin } = await setup({ key: null });
    const doc = await createPolicy(admin, { title: 'No key', text: TEXT });
    const versionId = await newestVersionId(admin, doc.id);
    const embedsBefore = embedCalls();
    expect((await runIndex(tenant, doc.id, versionId)).outcome).toBe('failed');
    expect(embedCalls()).toBe(embedsBefore);
    expect(await versionRow(tenant, versionId)).toEqual({ status: 'failed', error: 'embedding_failed' });
  });

  it('retries a transient provider error and marks the version failed on the last attempt', async () => {
    const { tenant, admin } = await setup({ key: 'fake-down' });
    const doc = await createPolicy(admin, { title: 'Provider down', text: TEXT });
    const versionId = await newestVersionId(admin, doc.id);
    const first = await runIndex(tenant, doc.id, versionId, { attemptsMade: 0 });
    expect(typeof first.outcome === 'object' && 'threw' in first.outcome).toBe(true);
    expect(await versionRow(tenant, versionId)).toMatchObject({ status: 'processing' });
    const last = await runIndex(tenant, doc.id, versionId, { attemptsMade: 2 });
    expect(typeof last.outcome === 'object' && 'threw' in last.outcome).toBe(true);
    expect(await versionRow(tenant, versionId)).toEqual({ status: 'failed', error: 'embedding_failed' });
  });
});

describe('the worker', () => {
  it('indexes a new policy end to end: created event, ai-index job, active version', async () => {
    const { admin } = await setup();
    const created = await createPolicy(admin, { title: 'Worker policy', text: 'Meerkat returns are handled at the front desk.' });
    expect(created.status).toBe(201);
    await drainOutbox();
    await vi.waitFor(
      async () => {
        const listed = ((await asUser(admin).get('/ai/policies')).body as { items: { status: string }[] }).items[0];
        expect(listed?.status).toBe('ready');
      },
      { timeout: 60_000, interval: 250 },
    );
  });
});
