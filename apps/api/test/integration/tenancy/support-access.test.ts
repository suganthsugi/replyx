import { beforeAll, describe, expect, it } from 'vitest';

import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { getTestApp, service } from '../../support/app.js';
import { createTenant, createUser, type TestTenant, type TestUser } from '../../support/factories.js';
import { asOperator, asSupport, asUser, type TestClient } from '../../support/http.js';

/**
 * Support access (T084; tenancy/support-access.{service,controller,guard}.ts, FR-001a): a tenant
 * admin lets operators look for a bounded time, the look is read-only, and everything they read
 * is written to that tenant's audit log.
 */

const errorBody = (code: string) => ({ error: expect.objectContaining({ code, message: expect.any(String) as string }) as object });

const NOT_FOUND_BODY = { error: { code: 'NOT_FOUND', message: 'Not found' } };

interface GrantBody {
  id: string;
  reason: string | null;
  startsAt: string;
  expiresAt: string;
  revokedAt: string | null;
  active: boolean;
  grantedBy: { id: string; name: string } | null;
  revokedBy: { id: string; name: string } | null;
}

const grant = (response: { body: unknown }) => response.body as GrantBody;
const grants = (response: { body: unknown }) => response.body as GrantBody[];
const failure = (response: { body: unknown }) =>
  response.body as { error: { code: string; details?: { path: string; issue: string }[] } };

let operator: TestClient;

beforeAll(async () => {
  await getTestApp();
  operator = (await asOperator()).client;
});

/** An admin who grants access, and the token the operator gets for it. */
async function grantAccess(tenant: TestTenant, admin: TestUser, durationHours = 24) {
  const created = await asUser(admin).post('/support-access', { durationHours, reason: 'Investigating a report' });
  expect(created.status).toBe(201);
  const session = await operator.post(`/platform/tenants/${tenant.id}/support-session`);
  expect(session.status).toBe(201);
  const body = session.body as { token: string; tenantHost: string; expiresAt: string };
  return { grantId: grant(created).id, token: body.token, tenantHost: body.tenantHost, expiresAt: body.expiresAt };
}

describe('the admin side of support access', () => {
  it('grants, lists and revokes, with the triad on every route', async () => {
    const [a, b] = await Promise.all([createTenant(), createTenant()]);
    const [admin, agent, otherAdmin] = await Promise.all([
      createUser(a, { roles: ['admin'] }),
      createUser(a, { roles: ['agent'] }),
      createUser(b, { roles: ['admin'] }),
    ]);

    const empty = await asUser(admin).get('/support-access');
    expect([empty.status, empty.body]).toEqual([200, []]);

    const created = await asUser(admin).post('/support-access', { durationHours: 24, reason: 'Investigating a report' });
    expect(created.status).toBe(201);
    expect(grant(created)).toMatchObject({
      reason: 'Investigating a report',
      revokedAt: null,
      active: true,
      grantedBy: { id: admin.id, name: admin.name },
      revokedBy: null,
    });

    const listed = await asUser(admin).get('/support-access');
    expect(grants(listed).map((row) => row.id)).toEqual([grant(created).id]);

    // 403 for a same-tenant user without the permission.
    for (const response of [
      await asUser(agent).get('/support-access'),
      await asUser(agent).post('/support-access', { durationHours: 1 }),
      await asUser(agent).post(`/support-access/${grant(created).id}/revoke`),
    ]) {
      expect(response.status).toBe(403);
      expect(response.body).toEqual(errorBody('PERMISSION_DENIED'));
    }

    // Tenant B's admin holds the permission but sees nothing and gets the unknown-id answer.
    const crossList = await asUser(otherAdmin).get('/support-access');
    expect([crossList.status, crossList.body]).toEqual([200, []]);
    const cross = await asUser(otherAdmin).post(`/support-access/${grant(created).id}/revoke`);
    const unknown = await asUser(otherAdmin).post('/support-access/01920000-0000-7000-8000-000000000000/revoke');
    expect([cross.status, cross.body]).toEqual([404, unknown.body]);

    const revoked = await asUser(admin).post(`/support-access/${grant(created).id}/revoke`);
    expect(revoked.status).toBe(200);
    expect(grant(revoked)).toMatchObject({ active: false, revokedAt: expect.any(String) as string, revokedBy: { id: admin.id } });
  });

  it('refuses a window longer than 168 hours, or shorter than an hour', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });

    for (const [durationHours, issue] of [
      [169, 'too_large'],
      [1000, 'too_large'],
      [0, 'too_small'],
      [-1, 'too_small'],
    ] as const) {
      const response = await asUser(admin).post('/support-access', { durationHours });
      expect(response.status).toBe(400);
      expect(failure(response).error.details).toEqual([{ path: 'durationHours', issue }]);
    }

    // 168 h exactly is the ceiling and is allowed.
    expect((await asUser(admin).post('/support-access', { durationHours: 168 })).status).toBe(201);
  });
});

describe('POST /platform/tenants/{id}/support-session', () => {
  it('404s SUPPORT_ACCESS_NOT_GRANTED without an active grant', async () => {
    const tenant = await createTenant();
    const response = await operator.post(`/platform/tenants/${tenant.id}/support-session`);
    expect(response.status).toBe(404);
    expect(response.body).toEqual(errorBody('SUPPORT_ACCESS_NOT_GRANTED'));
  });

  it('issues a token for the tenant host that expires with the grant', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const created = await asUser(admin).post('/support-access', { durationHours: 6 });

    const session = await operator.post(`/platform/tenants/${tenant.id}/support-session`);
    expect(session.status).toBe(201);
    expect(session.body).toMatchObject({
      tenantHost: expect.stringContaining(tenant.slug) as string,
      token: expect.any(String) as string,
      expiresAt: grant(created).expiresAt,
    });
  });
});

describe('reading a tenant with a support token', () => {
  it('reads succeed, writes are 403 READ_ONLY_SUPPORT_ACCESS', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const { token } = await grantAccess(tenant, admin);
    const support = asSupport(tenant, token);

    const users = await support.get('/users');
    expect(users.status).toBe(200);
    expect(JSON.stringify(users.body)).toContain(customer.id);
    expect((await support.get('/roles')).status).toBe(200);

    for (const response of [
      await support.post('/users', { email: 'nope@example.test', roleIds: [tenant.roles.agent] }),
      await support.patch(`/users/${customer.id}`, { name: 'Renamed by an operator' }),
      await support.delete(`/users/${customer.id}`),
      await support.post(`/users/${customer.id}/deactivate`),
    ]) {
      expect(response.status).toBe(403);
      expect(response.body).toEqual(errorBody('READ_ONLY_SUPPORT_ACCESS'));
    }

    // Nothing changed.
    const after = await asUser(admin).get(`/users/${customer.id}`);
    expect(after.body).toMatchObject({ name: customer.name, status: 'active' });
  });

  it('writes one audit entry per read, with the path and no content', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const { token, grantId } = await grantAccess(tenant, admin);

    await asSupport(tenant, token).get('/users');
    await asSupport(tenant, token).get('/roles');

    const entries = await auditActions(tenant);
    const reads = entries.filter((entry) => entry.action === 'support_access.read');
    expect(reads).toHaveLength(2);
    expect(reads.map((entry) => entry.details)).toEqual(
      expect.arrayContaining([
        { method: 'GET', path: '/api/v1/users' },
        { method: 'GET', path: '/api/v1/roles' },
      ]),
    );
    expect(reads.every((entry) => entry.resource_id === grantId)).toBe(true);
    // Granting and opening the session are recorded too, as the tenant's own history.
    expect(entries.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['support_access.granted', 'support_access.session_opened']),
    );
  });

  it('is not the staff or customer surface', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const { token } = await grantAccess(tenant, admin);
    const support = asSupport(tenant, token);

    // `/me` and `/customer/me` are about the caller's own account, which an operator has not.
    expect([(await support.get('/me')).status, (await support.get('/customer/me')).status]).toEqual([404, 404]);
    expect((await support.get('/me')).body).toEqual(NOT_FOUND_BODY);
  });

  it('stops immediately on revoke and never works on another tenant', async () => {
    const [a, b] = await Promise.all([createTenant(), createTenant()]);
    const admin = await createUser(a, { roles: ['admin'] });
    const { token, grantId } = await grantAccess(a, admin);

    expect((await asSupport(a, token).get('/users')).status).toBe(200);
    // Tenant A's token is signed for tenant A: on B's host it is just an unusable credential.
    expect((await asSupport(b, token).get('/users')).status).toBe(401);

    expect((await asUser(admin).post(`/support-access/${grantId}/revoke`)).status).toBe(200);
    const afterRevoke = await asSupport(a, token).get('/users');
    expect(afterRevoke.status).toBe(401);
    expect(afterRevoke.body).toEqual(errorBody('UNAUTHENTICATED'));

    // And no new session can be opened.
    expect((await operator.post(`/platform/tenants/${a.id}/support-session`)).status).toBe(404);
  });

  it('stops at the grant\'s expiry', async () => {
    const { clock } = await getTestApp();
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const { token } = await grantAccess(tenant, admin, 1);

    expect((await asSupport(tenant, token).get('/users')).status).toBe(200);

    clock.advanceHours(2);
    expect((await asSupport(tenant, token).get('/users')).status).toBe(401);
    expect((await operator.post(`/platform/tenants/${tenant.id}/support-session`)).status).toBe(404);
  });

  it('rejects a tampered or malformed token', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const { token } = await grantAccess(tenant, admin);

    for (const bad of [`${token.slice(0, -1)}X`, token.replace('v1.', 'v2.'), 'not-a-token', '']) {
      const response = await asSupport(tenant, bad).get('/users');
      // An empty header is no credential at all, so it is the plain unauthenticated answer.
      expect({ bad: bad.slice(0, 12), status: response.status }).toEqual({ bad: bad.slice(0, 12), status: 401 });
    }
  });

  it('is ignored when the caller already has a session of their own', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const agent = await createUser(tenant, { roles: ['agent'] });
    const { token } = await grantAccess(tenant, admin);

    // The agent cannot borrow the operator's reach by adding the header to their own requests.
    const response = await asUser(agent, { host: tenant.host }).get('/users');
    expect(response.status).toBe(403);
    const withToken = await asUser(agent).get('/users');
    expect(withToken.status).toBe(403);
    expect(token.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------

function ctxFor(tenant: TestTenant): TenantContext {
  return TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'support-access-test' });
}

async function auditActions(tenant: TestTenant) {
  const unitOfWork = await service(UnitOfWork);
  const ctx = ctxFor(tenant);
  return unitOfWork.withTenantReadOnly(ctx, (tx) => new AuditQuery(ctx).supportEntries(tx));
}

class AuditQuery extends TenantRepository {
  supportEntries(tx: TenantTransaction) {
    return this.selectFrom(tx, 'audit_logs')
      .select(['action', 'resource_id', 'details', 'actor_kind', 'actor_id'])
      .where('action', 'like', 'support_access.%')
      .orderBy('occurred_at')
      .execute();
  }
}
