import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { QueueRegistry } from '../../../src/platform-kernel/jobs/queues.js';
import { EMAIL_JOB, type EmailJobData } from '../../../src/platform-kernel/mail/mail.service.js';
import { getTestApp, service } from '../../support/app.js';
import { createTenant, createUser } from '../../support/factories.js';
import { asGuest, asOperator, asUser, CONSOLE_HOST, type TestClient } from '../../support/http.js';

/**
 * The platform console's tenant API (T082; tenancy/platform/tenants.{controller,service}.ts,
 * openapi.yaml `/platform/tenants*`). The two hosts are two separate APIs: neither can be reached
 * from the other, which is what keeps operators out of tenant data and tenants out of the console.
 */

const errorBody = (code: string) => ({ error: expect.objectContaining({ code, message: expect.any(String) as string }) as object });

const UNKNOWN_ID = '01920000-0000-7000-8000-000000000000';

interface TenantBody {
  id: string;
  name: string;
  slug: string;
  status: string;
  suspendedAt: string | null;
  activeSupportGrantUntil: string | null;
  stats: { staffUsers: number; customers: number; ticketsLast30Days: number };
}

const tenantBody = (response: { body: unknown }) => response.body as TenantBody;
const page = (response: { body: unknown }) => response.body as { items: TenantBody[]; nextCursor: string | null };
const failure = (response: { body: unknown }) =>
  response.body as { error: { code: string; details?: { path: string; issue: string }[] } };

const uniqueSlug = () => `probe-${randomBytes(4).toString('hex')}`;

let operator: TestClient;

beforeAll(async () => {
  await getTestApp();
  operator = (await asOperator()).client;
});

describe('POST /platform/tenants', () => {
  it('creates a tenant with system roles, Ungrouped access and an invited admin', async () => {
    const slug = uniqueSlug();
    const adminEmail = `admin-${slug}@example.test`;

    const response = await operator.post('/platform/tenants', { name: 'Probe Co', slug, adminEmail });
    expect(response.status).toBe(201);
    expect(tenantBody(response)).toMatchObject({
      name: 'Probe Co',
      slug,
      status: 'active',
      suspendedAt: null,
      activeSupportGrantUntil: null,
      stats: { staffUsers: 1, customers: 0, ticketsLast30Days: 0 },
    });

    const seed = await readSeed(tenantBody(response).id);
    expect(seed.roles.map((role) => role.system_key).sort()).toEqual(['admin', 'agent', 'customer', 'manager']);
    // The Ungrouped entry (group_id null) exists for Admin and Manager, as provisioning seeds it.
    expect(seed.ungroupedAccess.length).toBeGreaterThan(0);
    expect(seed.users).toEqual([{ email: adminEmail, status: 'invited', kind: 'staff' }]);
    expect(seed.invitations).toHaveLength(1);

    const emails = await emailJobsFor(adminEmail);
    expect(emails).toHaveLength(1);
    expect((emails[0]!.data as EmailJobData).template).toBe('invitation');
  });

  it('refuses a taken slug, a reserved slug and a malformed one', async () => {
    const slug = uniqueSlug();
    expect((await operator.post('/platform/tenants', { name: 'First', slug, adminEmail: 'a@example.test' })).status).toBe(201);

    const taken = await operator.post('/platform/tenants', { name: 'Second', slug, adminEmail: 'b@example.test' });
    expect(taken.status).toBe(409);
    expect(taken.body).toEqual(errorBody('SLUG_TAKEN'));

    const reserved = await operator.post('/platform/tenants', { name: 'Console', slug: 'console', adminEmail: 'b@example.test' });
    expect(reserved.status).toBe(409);
    expect(reserved.body).toEqual(errorBody('SLUG_RESERVED'));

    for (const bad of ['ab', '-lead', 'trail-', 'Upper', 'double--hyphen', 'x'.repeat(41)]) {
      const response = await operator.post('/platform/tenants', { name: 'Bad', slug: bad, adminEmail: 'b@example.test' });
      expect({ slug: bad, status: response.status }).toEqual({ slug: bad, status: 400 });
      expect(failure(response).error.details?.[0]?.path).toBe('slug');
    }
  });
});

describe('GET /platform/tenants', () => {
  it('lists tenants with aggregate stats and filters by status and query', async () => {
    const tenant = await createTenant();
    await Promise.all([
      createUser(tenant, { roles: ['agent'] }),
      createUser(tenant, { roles: ['customer'] }),
      createUser(tenant, { roles: ['customer'] }),
    ]);

    const listed = await operator.get(`/platform/tenants?q=${tenant.slug}`);
    expect(listed.status).toBe(200);
    expect(page(listed).items).toHaveLength(1);
    expect(page(listed).items[0]).toMatchObject({
      id: tenant.id,
      slug: tenant.slug,
      stats: { staffUsers: 1, customers: 2 },
    });

    const active = await operator.get(`/platform/tenants?status=active&q=${tenant.slug}`);
    expect(page(active).items.map((item) => item.id)).toEqual([tenant.id]);

    const suspended = await operator.get(`/platform/tenants?status=suspended&q=${tenant.slug}`);
    expect(page(suspended).items).toEqual([]);
  });

  it('pages with an opaque cursor', async () => {
    await Promise.all([createTenant(), createTenant()]);
    const first = await operator.get('/platform/tenants?limit=2');
    expect(first.status).toBe(200);
    expect(page(first).items).toHaveLength(2);

    const cursor = page(first).nextCursor;
    expect(cursor).toEqual(expect.any(String));
    const second = await operator.get(`/platform/tenants?limit=2&cursor=${encodeURIComponent(cursor as string)}`);
    const firstIds = page(first).items.map((item) => item.id);
    expect(page(second).items.some((item) => firstIds.includes(item.id))).toBe(false);
  });
});

describe('GET/PATCH /platform/tenants/{id}', () => {
  it('returns a tenant and renames it, and 404s an unknown id', async () => {
    const tenant = await createTenant();

    const found = await operator.get(`/platform/tenants/${tenant.id}`);
    expect(found.status).toBe(200);
    expect(tenantBody(found).slug).toBe(tenant.slug);

    const renamed = await operator.patch(`/platform/tenants/${tenant.id}`, { name: 'Renamed Workspace' });
    expect(renamed.status).toBe(200);
    expect(tenantBody(renamed).name).toBe('Renamed Workspace');

    const unknown = await operator.get(`/platform/tenants/${UNKNOWN_ID}`);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(errorBody('TENANT_NOT_FOUND'));
  });

  it('carries no business content: only aggregate counts', async () => {
    const tenant = await createTenant();
    const customer = await createUser(tenant, { roles: ['customer'], name: 'Cora Customer' });

    const response = await operator.get(`/platform/tenants/${tenant.id}`);
    const text = JSON.stringify(response.body);
    expect(text).not.toContain(customer.id);
    expect(text).not.toContain(customer.email);
    expect(text).not.toContain('Cora');
  });
});

describe('the console and tenant APIs are separate', () => {
  it('404s operator routes on a tenant host, whoever is calling', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });

    const anonymous = await asGuest(tenant).get('/platform/tenants');
    expect([anonymous.status, anonymous.body]).toEqual([404, { error: { code: 'NOT_FOUND', message: 'Not found' } }]);

    const asAdmin = await asUser(admin).get('/platform/tenants');
    expect([asAdmin.status, asAdmin.body]).toEqual([404, { error: { code: 'NOT_FOUND', message: 'Not found' } }]);
  });

  it('401s operator routes on the console host without an operator session', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });

    const anonymous = await asGuest(CONSOLE_HOST).get('/platform/tenants');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toEqual(errorBody('UNAUTHENTICATED'));

    // A tenant session cookie is meaningless on the console: it resolves no tenant.
    const withStaffCookie = await asUser(admin, { host: CONSOLE_HOST }).get('/platform/tenants');
    expect(withStaffCookie.status).toBe(401);
  });

  it('401s tenant routes on the console host: the console serves no tenant', async () => {
    const response = await asGuest(CONSOLE_HOST).get('/users');
    expect(response.status).toBe(401);
    expect(response.body).toEqual(errorBody('UNAUTHENTICATED'));
  });

  it('answers the same 401 for a wrong operator password and an unknown operator', async () => {
    const wrong = await asGuest(CONSOLE_HOST).post('/platform/auth/sign-in', {
      email: 'operator@example.test',
      password: 'not-the-password',
    });
    const unknown = await asGuest(CONSOLE_HOST).post('/platform/auth/sign-in', {
      email: `nobody-${randomBytes(4).toString('hex')}@example.test`,
      password: 'not-the-password',
    });
    expect(wrong.status).toBe(401);
    expect([unknown.status, unknown.body]).toEqual([401, wrong.body]);
  });

  it('404s operator sign-in on a tenant host', async () => {
    const tenant = await createTenant();
    const response = await asGuest(tenant).post('/platform/auth/sign-in', {
      email: 'operator@example.test',
      password: 'operator-password',
    });
    expect(response.status).toBe(404);
  });

  it('ends the operator session on sign-out', async () => {
    const session = await asOperator();
    expect((await session.client.get('/platform/tenants')).status).toBe(200);

    expect((await session.client.post('/platform/auth/sign-out')).status).toBe(204);
    expect((await session.client.get('/platform/tenants')).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------

async function emailJobsFor(email: string) {
  const queues = await service(QueueRegistry);
  const jobs = await queues.get('email').getJobs(['waiting', 'delayed', 'active', 'completed']);
  return jobs.filter((job) => job.name === EMAIL_JOB && (job.data as EmailJobData).to === email);
}

function ctxFor(tenantId: string): TenantContext {
  return TenantContext.create({ tenantId, actor: { kind: 'system' }, requestId: 'platform-tenants-test' });
}

/** What provisioning left behind, read inside the new tenant. */
async function readSeed(tenantId: string) {
  const unitOfWork = await service(UnitOfWork);
  const ctx = ctxFor(tenantId);
  return unitOfWork.withTenantReadOnly(ctx, async (tx) => {
    const repo = new SeedQuery(ctx);
    return {
      roles: await repo.roles(tx),
      ungroupedAccess: await repo.ungroupedAccess(tx),
      users: await repo.users(tx),
      invitations: await repo.invitations(tx),
    };
  });
}

class SeedQuery extends TenantRepository {
  roles(tx: TenantTransaction) {
    return this.selectFrom(tx, 'roles').select('system_key').execute();
  }

  ungroupedAccess(tx: TenantTransaction) {
    return this.selectFrom(tx, 'role_group_access').select('role_id').where('group_id', 'is', null).execute();
  }

  users(tx: TenantTransaction) {
    return this.selectFrom(tx, 'users').select(['email', 'status', 'kind']).execute();
  }

  invitations(tx: TenantTransaction) {
    return this.selectFrom(tx, 'user_invitations').select('id').execute();
  }
}
