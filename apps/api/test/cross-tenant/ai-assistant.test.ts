import { beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '../../src/platform-kernel/ids.js';
import { customerSays, draftsOf, runTurn, setUpAiTenant, type AiTenant } from '../support/assistant.js';
import { createGroup, createRole, createTenant, createUser, type TestUser } from '../support/factories.js';
import { asUser } from '../support/http.js';

/**
 * The assistant's routes across tenants and permissions (specs/002-ai-assist T026): success, 403
 * for a same-tenant user without the permission (or without edit/reply on the ticket's group), the
 * unknown-id 404 for a same-tenant user who cannot see the ticket, and
 * for tenant B's admin, who holds every permission, the same 404 as an unknown id. The generated
 * suite (cross-tenant.test.ts, fixtures `ai_settings`, `ai_usage` and `ticket`) walks these routes
 * too; this file pins the full triad and the turn job's tenant boundary.
 */

let a: AiTenant;
let b: AiTenant;
let viewer: TestUser;
let ticketId: string;

beforeAll(async () => {
  a = await setUpAiTenant(await createTenant(), { mode: 'drafts' });
  b = await setUpAiTenant(await createTenant(), { mode: 'drafts' });
  ticketId = await customerSays(a.customer, 'Hello');
  const group = await createGroup(a.tenant, { access: [{ role: 'agent', flags: { view: true } }] });
  expect((await asUser(a.admin).patch(`/tickets/${ticketId}`, { groupId: group.id })).status).toBe(200);
  // Sees the ticket, may not edit or reply: every assistant route on it is 403.
  viewer = await createUser(a.tenant, { roles: ['agent'] });
  expect(await runTurn(a.tenant, ticketId)).toBe('drafted');
});

const codeOf = (response: { body: unknown }) => (response.body as { error?: { code?: string } }).error?.code;

type Method = 'get' | 'post' | 'put' | 'delete';

async function expectCrossTenant404(method: Method, path: (id: string) => string, body?: object) {
  const cross = await asUser(b.admin)[method](path(ticketId), body);
  const unknown = await asUser(b.admin)[method](path(uuidv7()), body);
  expect([cross.status, cross.body]).toEqual([404, unknown.body]);
}

describe('ticket routes: AI draft, take over, hand back', () => {
  const ROUTES: [string, Method, (id: string) => string][] = [
    ['GET ai-draft', 'get', (id) => `/tickets/${id}/ai-draft`],
    ['POST ai-draft/discard', 'post', (id) => `/tickets/${id}/ai-draft/discard`],
    ['POST ai/takeover', 'post', (id) => `/tickets/${id}/ai/takeover`],
    ['POST ai/handback', 'post', (id) => `/tickets/${id}/ai/handback`],
  ];

  it.each(ROUTES)('%s: 403 without edit or reply on the group', async (_name, method, path) => {
    const response = await asUser(viewer)[method](path(ticketId));
    expect([response.status, codeOf(response)]).toEqual([403, 'PERMISSION_DENIED']);
  });

  it.each(ROUTES)('%s: the unknown-id 404 for a same-tenant user who cannot see the ticket', async (_name, method, path) => {
    const role = await createRole(a.tenant, { permissions: ['ticket.view', 'ticket.edit'] });
    const outsider = await createUser(a.tenant, { roles: [{ id: role.id }] });
    const hidden = await asUser(outsider)[method](path(ticketId));
    const unknown = await asUser(outsider)[method](path(uuidv7()));
    expect([hidden.status, hidden.body]).toEqual([404, unknown.body]);
  });

  it.each(ROUTES)("%s: tenant B's admin gets the unknown-id 404", async (_name, method, path) => {
    await expectCrossTenant404(method, path);
  });

  it("succeeds for tenant A's admin and leaves tenant B untouched", async () => {
    expect((await asUser(a.admin).get(`/tickets/${ticketId}/ai-draft`)).status).toBe(200);
    expect((await asUser(a.admin).post(`/tickets/${ticketId}/ai-draft/discard`)).status).toBe(204);
    expect((await draftsOf(a.tenant, ticketId)).map((draft) => draft.status)).toEqual(['discarded']);
    expect((await asUser(a.admin).post(`/tickets/${ticketId}/ai/takeover`)).status).toBe(200);
    await asUser(a.admin).patch('/ai/settings', { replyMode: 'auto' });
    expect((await asUser(a.admin).post(`/tickets/${ticketId}/ai/handback`)).status).toBe(200);
    await asUser(a.admin).patch('/ai/settings', { replyMode: 'drafts' });
  });
});

describe('the turn job', () => {
  it("never reads another tenant's ticket", async () => {
    expect(await runTurn(b.tenant, ticketId)).toBe('skipped');
    expect(await draftsOf(b.tenant, ticketId)).toEqual([]);
  });
});

describe('store connection and usage', () => {
  it('403 for staff without ai_settings.manage or ai_usage.view', async () => {
    for (const [method, path, body] of [
      ['get', '/ai/store-connection', undefined],
      ['put', '/ai/store-connection', { kind: 'spree', baseUrl: 'https://shop.example.com', apiKey: 'spree-read-only-key' }],
      ['delete', '/ai/store-connection', undefined],
      ['post', '/ai/store-connection/test', undefined],
      ['get', '/ai/runs', undefined],
    ] as [Method, string, object | undefined][]) {
      const response = await asUser(viewer)[method](path, body);
      expect([path, response.status, codeOf(response)]).toEqual([path, 403, 'PERMISSION_DENIED']);
    }
  });

  it("shows, tests and deletes only the caller's own store connection", async () => {
    const seenByB = await asUser(b.admin).get('/ai/store-connection');
    expect(seenByB.status).toBe(200);
    expect(JSON.stringify(seenByB.body)).not.toContain('spree-read-only-key');
    expect((await asUser(b.admin).delete('/ai/store-connection')).status).toBe(204);
    expect((await asUser(b.admin).get('/ai/store-connection')).status).toBe(404);
    expect((await asUser(a.admin).get('/ai/store-connection')).status).toBe(200);
    expect((await asUser(a.admin).post('/ai/store-connection/test')).body).toMatchObject({ ok: true });
  });

  it("lists only the caller's own runs", async () => {
    const runsA = (await asUser(a.admin).get('/ai/runs')).body as { items: { id: string }[] };
    const runsB = (await asUser(b.admin).get('/ai/runs')).body as { items: { id: string }[] };
    expect(runsA.items.length).toBeGreaterThan(0);
    const idsB = new Set(runsB.items.map((run) => run.id));
    expect(runsA.items.filter((run) => idsB.has(run.id))).toEqual([]);
  });
});
