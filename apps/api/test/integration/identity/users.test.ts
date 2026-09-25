import { Global, Module } from '@nestjs/common';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ERASED_NAME } from '../../../src/identity/erasure.job.js';
import { USER_HISTORY_CHECKS, type UserHistoryCheck } from '../../../src/identity/users.service.js';
import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { getTestApp, getTestWorker, service } from '../../support/app.js';
import { createRole, createTenant, createUser, type TestTenant, type TestUser } from '../../support/factories.js';
import { asGuest, asUser } from '../../support/http.js';

/**
 * User administration (T066; identity/users.{controller,service}.ts and identity/erasure.job.ts,
 * openapi.yaml `/users*`). Every endpoint gets the mandatory triad (success, 403 without the
 * permission, cross-tenant 404 equal to the unknown-id body, testing-conventions rule 6).
 */

const errorBody = (code: string) => ({ error: expect.objectContaining({ code, message: expect.any(String) as string }) as object });

const UNKNOWN_ID = '01920000-0000-7000-8000-000000000000';

/** `response.body` is `any`; these give the three shapes the endpoints return. */
interface UserBody {
  id: string;
  email: string;
  name: string;
  kind: string;
  status: string;
  locked: boolean;
  roles: { id: string; name: string }[];
  accessVersion?: string;
}

const userBody = (response: { body: unknown }) => response.body as UserBody;
const page = (response: { body: unknown }) => response.body as { items: UserBody[]; nextCursor: string | null };
const ids = (response: { body: unknown }) => page(response).items.map((item) => item.id);
const failure = (response: { body: unknown }) =>
  response.body as { error: { code: string; details?: { path: string; issue: string }[] } };

/**
 * A `UserHistoryCheck` like the one the Tickets module will provide (US6), switched on per test.
 * It has to be in the app from the start, so it is registered in this file's single `getTestApp`.
 */
let userHasHistory = false;

const historyCheck: UserHistoryCheck = { hasHistory: () => Promise.resolve(userHasHistory) };

@Global()
@Module({
  providers: [{ provide: USER_HISTORY_CHECKS, useValue: [historyCheck] }],
  exports: [USER_HISTORY_CHECKS],
})
class HistoryChecksModule {}

function ctxFor(tenant: { id: string }): TenantContext {
  return TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'users-test' });
}

/** A user row straight from the database, to check what the API does not return. */
class UsersQuery extends TenantRepository {
  row(tx: TenantTransaction, userId: string) {
    return this.selectFrom(tx, 'users')
      .select(['id', 'email', 'name', 'status', 'kind', 'password_hash', 'erased_at'])
      .where('id', '=', userId)
      .executeTakeFirst();
  }

  profiles(tx: TenantTransaction, userId: string) {
    return this.selectFrom(tx, 'customer_profiles').select('user_id').where('user_id', '=', userId).execute();
  }

  auditActions(tx: TenantTransaction, userId: string) {
    return this.selectFrom(tx, 'audit_logs')
      .select(['action', 'details'])
      .where('resource_id', '=', userId)
      .orderBy('occurred_at')
      .execute();
  }

  events(tx: TenantTransaction, type: string) {
    return this.selectFrom(tx, 'outbox_events').select(['type', 'payload', 'streams']).where('type', '=', type).execute();
  }
}

async function read<T>(tenant: TestTenant, fn: (query: UsersQuery, tx: TenantTransaction) => Promise<T>): Promise<T> {
  const unitOfWork = await service(UnitOfWork);
  const ctx = ctxFor(tenant);
  return unitOfWork.withTenantReadOnly(ctx, (tx) => fn(new UsersQuery(ctx), tx));
}

/** An admin in `tenant` plus a same-tenant agent, who holds no `user.*` permission. */
async function actors(tenant: TestTenant): Promise<{ admin: TestUser; agent: TestUser }> {
  const [admin, agent] = await Promise.all([
    createUser(tenant, { roles: ['admin'] }),
    createUser(tenant, { roles: ['agent'] }),
  ]);
  return { admin, agent };
}

function roleIdsOf(tenant: TestTenant): string[] {
  return [tenant.roles.agent];
}

beforeAll(async () => {
  await getTestApp({ imports: [HistoryChecksModule] });
});

afterEach(() => {
  userHasHistory = false;
});

describe('GET /users', () => {
  it('lists the tenant\'s users and filters by kind, status, role and query', async () => {
    const tenant = await createTenant();
    const { admin } = await actors(tenant);
    const customer = await createUser(tenant, { roles: ['customer'], name: 'Cora Customer' });
    const deactivated = await createUser(tenant, { roles: ['agent'], status: 'deactivated' });

    const all = await asUser(admin).get('/users');
    expect(all.status).toBe(200);
    expect(ids(all)).toEqual(expect.arrayContaining([admin.id, customer.id, deactivated.id]));
    expect(page(all).nextCursor).toBeNull();

    const customers = await asUser(admin).get('/users?kind=customer');
    expect(ids(customers)).toEqual([customer.id]);

    const deactivatedOnly = await asUser(admin).get('/users?status=deactivated');
    expect(ids(deactivatedOnly)).toEqual([deactivated.id]);

    const byRole = await asUser(admin).get(`/users?roleId=${tenant.roles.customer}`);
    expect(ids(byRole)).toEqual([customer.id]);

    const byQuery = await asUser(admin).get('/users?q=Cora');
    expect(ids(byQuery)).toEqual([customer.id]);
  });

  it('pages with an opaque cursor', async () => {
    const tenant = await createTenant();
    const { admin } = await actors(tenant);
    await Promise.all([createUser(tenant, { roles: ['agent'] }), createUser(tenant, { roles: ['agent'] })]);

    const first = await asUser(admin).get('/users?limit=2');
    expect(first.status).toBe(200);
    expect(page(first).items).toHaveLength(2);
    const cursor = page(first).nextCursor;
    expect(cursor).toEqual(expect.any(String));

    const second = await asUser(admin).get(`/users?limit=2&cursor=${encodeURIComponent(cursor as string)}`);
    expect(second.status).toBe(200);
    const firstIds = ids(first);
    const secondIds = ids(second);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
  });

  it('rejects an unknown query parameter with 400 VALIDATION_FAILED', async () => {
    const tenant = await createTenant();
    const { admin } = await actors(tenant);

    const response = await asUser(admin).get('/users?bogus=1');
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: 'VALIDATION_FAILED',
        message: expect.any(String) as string,
        details: [{ path: 'bogus', issue: 'unrecognized_key' }],
      },
    });
  });

  it('403s a user without user.view and never shows another tenant\'s users', async () => {
    const [a, b] = await Promise.all([createTenant(), createTenant()]);
    const { agent } = await actors(a);
    const aCustomer = await createUser(a, { roles: ['customer'] });
    const bAdmin = await createUser(b, { roles: ['admin'] });

    const denied = await asUser(agent).get('/users');
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual(errorBody('PERMISSION_DENIED'));

    const cross = await asUser(bAdmin).get('/users');
    expect(cross.status).toBe(200);
    expect(JSON.stringify(cross.body)).not.toContain(aCustomer.id);
  });

  it('401s without a session and 404s a customer session', async () => {
    const tenant = await createTenant();
    const customer = await createUser(tenant, { roles: ['customer'] });

    const anonymous = await asGuest(tenant).get('/users');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toEqual(errorBody('UNAUTHENTICATED'));

    const asCustomer = await asUser(customer).get('/users');
    expect(asCustomer.status).toBe(404);
    expect(asCustomer.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  });
});

describe('POST /users', () => {
  it('invites a staff user with the given roles, emails them and keeps them invited until they accept', async () => {
    const tenant = await createTenant();
    const { admin } = await actors(tenant);
    const email = `invitee-${Date.now()}@example.test`;

    const response = await asUser(admin).post('/users', { email, name: 'Ivy Invitee', roleIds: roleIdsOf(tenant) });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      email,
      name: 'Ivy Invitee',
      kind: 'staff',
      status: 'invited',
      locked: false,
      roles: [{ id: tenant.roles.agent, name: expect.any(String) as string }],
    });

    const invited = await read(tenant, (query, tx) => query.row(tx, userBody(response).id));
    expect(invited).toMatchObject({ status: 'invited', password_hash: null });

    const audit = await read(tenant, (query, tx) => query.auditActions(tx, userBody(response).id));
    expect(audit.map((entry) => entry.action)).toContain('user.invited');
  });

  it('creates an active customer when every role is the Customer role', async () => {
    const tenant = await createTenant();
    const { admin } = await actors(tenant);

    const response = await asUser(admin).post('/users', {
      email: `customer-${Date.now()}@example.test`,
      roleIds: [tenant.roles.customer],
    });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ kind: 'customer', status: 'active' });

    const profiles = await read(tenant, (query, tx) => query.profiles(tx, userBody(response).id));
    expect(profiles).toHaveLength(1);
  });

  it('409s EMAIL_IN_USE for an existing active user and validates the body', async () => {
    const tenant = await createTenant();
    const { admin } = await actors(tenant);
    const existing = await createUser(tenant, { roles: ['agent'] });

    const duplicate = await asUser(admin).post('/users', { email: existing.email, roleIds: roleIdsOf(tenant) });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toEqual(errorBody('EMAIL_IN_USE'));

    const noRoles = await asUser(admin).post('/users', { email: `x-${Date.now()}@example.test`, roleIds: [] });
    expect(noRoles.status).toBe(400);
    expect(failure(noRoles).error.code).toBe('VALIDATION_FAILED');

    const mixed = await asUser(admin).post('/users', {
      email: `y-${Date.now()}@example.test`,
      roleIds: [tenant.roles.agent, tenant.roles.customer],
    });
    expect(mixed.status).toBe(400);
    expect(failure(mixed).error.details).toEqual([{ path: 'roleIds', issue: 'invalid_value' }]);
  });

  it('403s without user.create and 400s a tenant B role id', async () => {
    const [a, b] = await Promise.all([createTenant(), createTenant()]);
    const { admin, agent } = await actors(a);
    const bAdmin = await createUser(b, { roles: ['admin'] });

    const denied = await asUser(agent).post('/users', { email: `z-${Date.now()}@example.test`, roleIds: roleIdsOf(a) });
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual(errorBody('PERMISSION_DENIED'));

    // Tenant A's role is invisible to tenant B, so the invite fails on the role, not on the tenant.
    const cross = await asUser(bAdmin).post('/users', { email: `w-${Date.now()}@example.test`, roleIds: roleIdsOf(a) });
    expect(cross.status).toBe(400);
    expect(failure(cross).error.details).toEqual([{ path: 'roleIds', issue: 'invalid_value' }]);
    expect(admin.id).toBeTruthy();
  });

  it('keeps the same email independent in two tenants (US2 scenario 3)', async () => {
    const [a, b] = await Promise.all([createTenant(), createTenant()]);
    const aAdmin = await createUser(a, { roles: ['admin'] });
    const bAdmin = await createUser(b, { roles: ['admin'] });
    const shared = `shared-${Date.now()}@example.test`;

    const inA = await asUser(aAdmin).post('/users', { email: shared, roleIds: [a.roles.agent] });
    const inB = await asUser(bAdmin).post('/users', { email: shared, roleIds: [b.roles.agent] });
    expect([inA.status, inB.status]).toEqual([201, 201]);
    expect(userBody(inA).id).not.toBe(userBody(inB).id);

    // Each tenant sees only its own account for that email.
    const listedInA = await asUser(aAdmin).get(`/users?q=${encodeURIComponent(shared)}`);
    expect(ids(listedInA)).toEqual([userBody(inA).id]);
    const listedInB = await asUser(bAdmin).get(`/users?q=${encodeURIComponent(shared)}`);
    expect(ids(listedInB)).toEqual([userBody(inB).id]);
  });
});

describe('GET /users/{id}', () => {
  it('returns the user, 403s without the permission and 404s across tenants like an unknown id', async () => {
    const [a, b] = await Promise.all([createTenant(), createTenant()]);
    const { admin, agent } = await actors(a);
    const target = await createUser(a, { roles: ['agent'] });
    const bAdmin = await createUser(b, { roles: ['admin'] });

    const success = await asUser(admin).get(`/users/${target.id}`);
    expect(success.status).toBe(200);
    expect(success.body).toMatchObject({ id: target.id, email: target.email, kind: 'staff', status: 'active' });

    const denied = await asUser(agent).get(`/users/${target.id}`);
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual(errorBody('PERMISSION_DENIED'));

    const cross = await asUser(bAdmin).get(`/users/${target.id}`);
    const unknown = await asUser(bAdmin).get(`/users/${UNKNOWN_ID}`);
    expect([cross.status, cross.body]).toEqual([404, unknown.body]);
  });
});

describe('PATCH /users/{id}', () => {
  it('renames, replaces roles and bumps the access version', async () => {
    const tenant = await createTenant();
    const { admin } = await actors(tenant);
    const target = await createUser(tenant, { roles: ['agent'] });
    const extra = await createRole(tenant, { permissions: ['ticket.view'] });

    const renamed = await asUser(admin).patch(`/users/${target.id}`, { name: 'Renamed Agent' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'Renamed Agent' });

    const before = await asUser(admin).get('/me');
    const reroled = await asUser(admin).patch(`/users/${target.id}`, { roleIds: [extra.id] });
    expect(reroled.status).toBe(200);
    expect(userBody(reroled).roles.map((role) => role.id)).toEqual([extra.id]);

    const after = await asUser(admin).get('/me');
    expect(Number(userBody(after).accessVersion)).toBeGreaterThan(Number(userBody(before).accessVersion));
  });

  it('refuses a role set that would change the user\'s kind', async () => {
    const tenant = await createTenant();
    const { admin } = await actors(tenant);
    const staff = await createUser(tenant, { roles: ['agent'] });

    const response = await asUser(admin).patch(`/users/${staff.id}`, { roleIds: [tenant.roles.customer] });
    expect(response.status).toBe(400);
    expect(failure(response).error.details).toEqual([{ path: 'roleIds', issue: 'invalid_value' }]);
  });

  it('403s without user.edit and 404s across tenants like an unknown id', async () => {
    const [a, b] = await Promise.all([createTenant(), createTenant()]);
    const { agent } = await actors(a);
    const target = await createUser(a, { roles: ['agent'] });
    const bAdmin = await createUser(b, { roles: ['admin'] });

    const denied = await asUser(agent).patch(`/users/${target.id}`, { name: 'Nope' });
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual(errorBody('PERMISSION_DENIED'));

    const cross = await asUser(bAdmin).patch(`/users/${target.id}`, { name: 'Nope' });
    const unknown = await asUser(bAdmin).patch(`/users/${UNKNOWN_ID}`, { name: 'Nope' });
    expect([cross.status, cross.body]).toEqual([404, unknown.body]);
  });
});

describe('POST /users/{id}/deactivate and /reactivate', () => {
  it('blocks sign-in, ends sessions, keeps the account, then restores it', async () => {
    const tenant = await createTenant();
    const { admin } = await actors(tenant);
    const target = await createUser(tenant, { roles: ['agent'], password: 'Target-Password-1' });

    const deactivated = await asUser(admin).post(`/users/${target.id}/deactivate`);
    expect(deactivated.status).toBe(200);
    expect(deactivated.body).toMatchObject({ id: target.id, status: 'deactivated' });

    // The account and its history stay; only access goes.
    expect(await read(tenant, (query, tx) => query.row(tx, target.id))).toMatchObject({ status: 'deactivated' });
    expect((await asUser(target).get('/me')).status).toBe(401);
    const signIn = await asGuest(tenant).post('/auth/sign-in', { email: target.email, password: 'Target-Password-1' });
    expect(signIn.status).toBe(401);
    expect(signIn.body).toEqual(errorBody('INVALID_CREDENTIALS'));

    const events = await read(tenant, (query, tx) => query.events(tx, 'user.deactivated'));
    expect(events).toEqual([
      expect.objectContaining({ payload: { userId: target.id }, streams: [`user:${target.id}`] }) as object,
    ]);

    const reactivated = await asUser(admin).post(`/users/${target.id}/reactivate`);
    expect(reactivated.status).toBe(200);
    expect(reactivated.body).toMatchObject({ status: 'active' });
    expect((await asGuest(tenant).post('/auth/sign-in', { email: target.email, password: 'Target-Password-1' })).status).toBe(200);
  });

  it('409s on deactivating yourself', async () => {
    const tenant = await createTenant();
    const { admin } = await actors(tenant);

    const response = await asUser(admin).post(`/users/${admin.id}/deactivate`);
    expect(response.status).toBe(409);
    expect(response.body).toEqual(errorBody('CANNOT_DEACTIVATE_SELF'));
  });

  it('403s without user.edit and 404s across tenants like an unknown id', async () => {
    const [a, b] = await Promise.all([createTenant(), createTenant()]);
    const { agent } = await actors(a);
    const target = await createUser(a, { roles: ['agent'] });
    const bAdmin = await createUser(b, { roles: ['admin'] });

    for (const action of ['deactivate', 'reactivate']) {
      const denied = await asUser(agent).post(`/users/${target.id}/${action}`);
      expect(denied.status).toBe(403);
      expect(denied.body).toEqual(errorBody('PERMISSION_DENIED'));

      const cross = await asUser(bAdmin).post(`/users/${target.id}/${action}`);
      const unknown = await asUser(bAdmin).post(`/users/${UNKNOWN_ID}/${action}`);
      expect([cross.status, cross.body]).toEqual([404, unknown.body]);
    }
  });
});

describe('DELETE /users/{id}', () => {
  it('deletes a user without history', async () => {
    const tenant = await createTenant();
    const { admin } = await actors(tenant);
    const target = await createUser(tenant, { roles: ['agent'] });

    const response = await asUser(admin).delete(`/users/${target.id}`);
    expect(response.status).toBe(204);
    expect(await read(tenant, (query, tx) => query.row(tx, target.id))).toBeUndefined();
    expect((await asUser(admin).get(`/users/${target.id}`)).status).toBe(404);
  });

  it('409s USER_HAS_HISTORY when a module reports authored records', async () => {
    userHasHistory = true;
    const tenant = await createTenant();
    const { admin } = await actors(tenant);
    const target = await createUser(tenant, { roles: ['agent'] });

    const response = await asUser(admin).delete(`/users/${target.id}`);
    expect(response.status).toBe(409);
    expect(response.body).toEqual(errorBody('USER_HAS_HISTORY'));
    expect(await read(tenant, (query, tx) => query.row(tx, target.id))).toMatchObject({ id: target.id });
  });

  it('409s on deleting yourself, 403s without user.delete and 404s across tenants', async () => {
    const [a, b] = await Promise.all([createTenant(), createTenant()]);
    const { admin, agent } = await actors(a);
    const target = await createUser(a, { roles: ['agent'] });
    const bAdmin = await createUser(b, { roles: ['admin'] });

    const self = await asUser(admin).delete(`/users/${admin.id}`);
    expect(self.status).toBe(409);
    expect(self.body).toEqual(errorBody('CANNOT_DELETE_SELF'));

    const denied = await asUser(agent).delete(`/users/${target.id}`);
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual(errorBody('PERMISSION_DENIED'));

    const cross = await asUser(bAdmin).delete(`/users/${target.id}`);
    const unknown = await asUser(bAdmin).delete(`/users/${UNKNOWN_ID}`);
    expect([cross.status, cross.body]).toEqual([404, unknown.body]);
  });
});

describe('POST /users/{id}/erase', () => {
  it('requires confirm: ERASE, answers 202 and erases the personal data', async () => {
    await getTestWorker();
    const tenant = await createTenant();
    const { admin } = await actors(tenant);
    const target = await createUser(tenant, { roles: ['customer'], name: 'Erasable Customer' });

    const missing = await asUser(admin).post(`/users/${target.id}/erase`, {});
    expect(missing.status).toBe(400);
    expect(failure(missing).error.details).toEqual([{ path: 'confirm', issue: 'invalid_value' }]);

    const wrong = await asUser(admin).post(`/users/${target.id}/erase`, { confirm: 'erase' });
    expect(wrong.status).toBe(400);

    const accepted = await asUser(admin).post(`/users/${target.id}/erase`, { confirm: 'ERASE' });
    expect(accepted.status).toBe(202);

    await vi.waitFor(
      async () =>
        expect(await read(tenant, (query, tx) => query.row(tx, target.id))).toMatchObject({
          name: ERASED_NAME,
          status: 'deactivated',
          erased_at: expect.any(Date) as Date,
        }),
      { timeout: 20_000, interval: 250 },
    );

    const erased = await read(tenant, (query, tx) => query.row(tx, target.id));
    expect(erased?.email).not.toContain(target.email);
    expect(await read(tenant, (query, tx) => query.profiles(tx, target.id))).toHaveLength(0);

    // The audit entry records the erasure without personal data.
    const audit = await read(tenant, (query, tx) => query.auditActions(tx, target.id));
    const entry = audit.find((row) => row.action === 'user.erased');
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry?.details)).not.toContain('Erasable');

    // An erased account cannot come back.
    const reactivated = await asUser(admin).post(`/users/${target.id}/reactivate`);
    expect(reactivated.status).toBe(409);
    expect(reactivated.body).toEqual(errorBody('USER_ERASED'));
  });

  it('409s on erasing yourself, 403s without user.erase and 404s across tenants', async () => {
    const [a, b] = await Promise.all([createTenant(), createTenant()]);
    const { admin, agent } = await actors(a);
    const target = await createUser(a, { roles: ['agent'] });
    const bAdmin = await createUser(b, { roles: ['admin'] });

    const self = await asUser(admin).post(`/users/${admin.id}/erase`, { confirm: 'ERASE' });
    expect(self.status).toBe(409);
    expect(self.body).toEqual(errorBody('CANNOT_ERASE_SELF'));

    const denied = await asUser(agent).post(`/users/${target.id}/erase`, { confirm: 'ERASE' });
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual(errorBody('PERMISSION_DENIED'));

    const cross = await asUser(bAdmin).post(`/users/${target.id}/erase`, { confirm: 'ERASE' });
    const unknown = await asUser(bAdmin).post(`/users/${UNKNOWN_ID}/erase`, { confirm: 'ERASE' });
    expect([cross.status, cross.body]).toEqual([404, unknown.body]);
  });
});

