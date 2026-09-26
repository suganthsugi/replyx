import { beforeAll, describe, expect, it } from 'vitest';

import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository, type TenantInsert } from '../../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../../src/platform-kernel/ids.js';
import { getTestApp, service } from '../../support/app.js';
import { createTenant, createUser, type TestTenant, type TestUser } from '../../support/factories.js';
import { asUser } from '../../support/http.js';

import type { Test } from 'supertest';

/**
 * `/tags*` (T146; contracts/tickets.yaml `/tags`, `/tags/{id}`, tags.service.ts). Every endpoint
 * gets the triad: success, 403 without the permission, cross-tenant 404 equal to the unknown-id
 * body (testing-conventions rule 6).
 */

const UNKNOWN_ID = '01920000-0000-7000-8000-000000000000';

interface TagBody {
  id: string;
  name: string;
}

const body = <T>(response: { body: unknown }) => response.body as T;
const items = <T>(response: { body: unknown }) => (response.body as { items: T[] }).items;
const failure = (response: { body: unknown }) => response.body as { error: { code: string; details?: { path: string; issue: string }[] } };

async function expectCrossTenant404(call: (id: string) => Promise<Test>, foreignId: string): Promise<void> {
  const cross = await call(foreignId);
  const unknown = await call(UNKNOWN_ID);
  expect(cross.status).toBe(404);
  expect(cross.body).toEqual(unknown.body);
}

class TagRepository extends TenantRepository {
  async insert(tx: TenantTransaction, name: string): Promise<string> {
    const values: TenantInsert<'tags'> = { id: uuidv7(), name };
    const row = await this.insertInto(tx, 'tags', values).returning('id').executeTakeFirstOrThrow();
    return row.id;
  }
}

async function insertTag(tenant: TestTenant, name: string): Promise<string> {
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'tags-test' });
  return (await service(UnitOfWork)).withTenant(ctx, (tx) => new TagRepository(ctx).insert(tx, name));
}

let a: TestTenant;
let b: TestTenant;
let viewOnly: TestUser;
let editor: TestUser;
let adminB: TestUser;

beforeAll(async () => {
  await getTestApp();
  [a, b] = await Promise.all([createTenant(), createTenant()]);
  [viewOnly, editor, adminB] = await Promise.all([
    createUser(a, { roles: ['agent'] }), // agent has tag.view but not create/edit/delete
    createUser(a, { roles: ['admin'] }),
    createUser(b, { roles: ['admin'] }),
  ]);
});

describe('GET /tags', () => {
  it('lists the tenant\'s tags, filtered by q, never another tenant\'s (success)', async () => {
    const alpha = await insertTag(a, 'Alpha');
    await insertTag(a, 'Beta');
    await insertTag(b, 'Gamma');

    const all = await asUser(editor).get('/tags');
    expect(all.status).toBe(200);
    const names = items<TagBody>(all).map((t) => t.name);
    expect(names).toEqual(['Alpha', 'Beta']);

    const filtered = await asUser(editor).get('/tags?q=alp');
    expect(items<TagBody>(filtered).map((t) => t.id)).toEqual([alpha]);
  });

  it('needs tag.view (403)', async () => {
    const bystander = await createUser(a, { roles: [] });
    expect((await asUser(bystander).get('/tags')).status).toBe(403);
  });
});

describe('POST /tags', () => {
  it('creates a tag (success)', async () => {
    const response = await asUser(editor).post('/tags', { name: 'Priority customer' });
    expect(response.status).toBe(201);
    expect(body<TagBody>(response)).toMatchObject({ name: 'Priority customer' });
  });

  it('needs tag.create (403)', async () => {
    expect((await asUser(viewOnly).post('/tags', { name: 'Nope' })).status).toBe(403);
  });

  it('refuses a taken name, case-insensitively (409 TAG_NAME_TAKEN)', async () => {
    await insertTag(a, 'Refund');
    const response = await asUser(editor).post('/tags', { name: 'REFUND' });
    expect(response.status).toBe(409);
    expect(failure(response).error.code).toBe('TAG_NAME_TAKEN');
    // Another tenant may reuse the same name.
    expect((await asUser(adminB).post('/tags', { name: 'Refund' })).status).toBe(201);
  });

  it('rejects an empty or too-long name (400)', async () => {
    expect(failure(await asUser(editor).post('/tags', { name: '' })).error.details).toEqual([{ path: 'name', issue: 'too_short' }]);
    expect(failure(await asUser(editor).post('/tags', { name: 'x'.repeat(41) })).error.details).toEqual([{ path: 'name', issue: 'too_long' }]);
  });
});

describe('PATCH /tags/{id}', () => {
  it('renames a tag (success)', async () => {
    const tagId = await insertTag(a, 'Old name');
    const response = await asUser(editor).patch(`/tags/${tagId}`, { name: 'New name' });
    expect(response.status).toBe(200);
    expect(body<TagBody>(response)).toEqual({ id: tagId, name: 'New name' });
  });

  it('needs tag.edit (403)', async () => {
    const tagId = await insertTag(a, 'Untouched');
    expect((await asUser(viewOnly).patch(`/tags/${tagId}`, { name: 'Nope' })).status).toBe(403);
  });

  it('is a 404 for another tenant\'s tag (cross-tenant)', async () => {
    const tagId = await insertTag(a, 'Belongs to A');
    await expectCrossTenant404((id) => asUser(adminB).patch(`/tags/${id}`, { name: 'x' }), tagId);
  });

  it('refuses renaming to a name already taken (409 TAG_NAME_TAKEN)', async () => {
    const taken = await insertTag(a, 'Taken');
    const tagId = await insertTag(a, 'Renamable');
    const response = await asUser(editor).patch(`/tags/${tagId}`, { name: 'TAKEN' });
    expect(response.status).toBe(409);
    expect(failure(response).error.code).toBe('TAG_NAME_TAKEN');
    expect(taken).not.toBe(tagId);
  });
});

describe('DELETE /tags/{id}', () => {
  it('deletes a tag, removing it from tickets and customers (success)', async () => {
    const tagId = await insertTag(a, 'Removable');
    const response = await asUser(editor).delete(`/tags/${tagId}`);
    expect(response.status).toBe(204);
    expect(items<TagBody>(await asUser(editor).get('/tags')).some((t) => t.id === tagId)).toBe(false);
  });

  it('needs tag.delete (403)', async () => {
    const tagId = await insertTag(a, 'Kept');
    expect((await asUser(viewOnly).delete(`/tags/${tagId}`)).status).toBe(403);
  });

  it('is a 404 for another tenant\'s tag (cross-tenant)', async () => {
    const tagId = await insertTag(a, 'Also kept');
    await expectCrossTenant404((id) => asUser(adminB).delete(`/tags/${id}`), tagId);
  });
});
