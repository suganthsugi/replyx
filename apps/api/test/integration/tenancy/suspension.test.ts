import { beforeAll, describe, expect, it } from 'vitest';

import { getTestApp, getTestWorker } from '../../support/app.js';
import { createTenant, createUser, type TestUser } from '../../support/factories.js';
import { asGuest, asOperator, asUser, setCookieValues, type TestClient } from '../../support/http.js';
import { connectSocket, waitForEvent } from '../../support/socket.js';

/**
 * Suspension and reactivation (T083; tenancy/suspension.service.ts, FR-004). Suspension is a
 * switch: everything stops and nothing is deleted, so reactivation puts the workspace back
 * exactly as it was.
 */

const errorBody = (code: string) => ({ error: expect.objectContaining({ code, message: expect.any(String) as string }) as object });

const PASSWORD = 'Correct-Horse-Battery-1';

let operator: TestClient;

beforeAll(async () => {
  await getTestApp();
  operator = (await asOperator()).client;
});

describe('POST /platform/tenants/{id}/suspend', () => {
  it('ends sessions, blocks sign-in and answers 503 on every tenant route', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'], password: PASSWORD });

    expect((await asUser(admin).get('/me')).status).toBe(200);

    const suspended = await operator.post(`/platform/tenants/${tenant.id}/suspend`, { reason: 'Non-payment' });
    expect(suspended.status).toBe(200);
    expect(suspended.body).toMatchObject({ status: 'suspended', suspendedAt: expect.any(String) as string });

    // The status guard runs before authentication, so every tenant route says the same thing.
    const withSession = await asUser(admin).get('/me');
    expect(withSession.status).toBe(503);
    expect(withSession.body).toEqual(errorBody('TENANT_SUSPENDED'));

    const signIn = await asGuest(tenant).post('/auth/sign-in', { email: admin.email, password: PASSWORD });
    expect(signIn.status).toBe(503);
    expect(signIn.body).toEqual(errorBody('TENANT_SUSPENDED'));
  });

  it('keeps branding answering, with available: false', async () => {
    const tenant = await createTenant();
    const active = await asGuest(tenant).get('/customer/branding');
    expect(active.status).toBe(200);
    expect(active.body).toMatchObject({ available: true, selfRegistration: true });

    await operator.post(`/platform/tenants/${tenant.id}/suspend`, {});

    const suspended = await asGuest(tenant).get('/customer/branding');
    expect(suspended.status).toBe(200);
    expect(suspended.body).toMatchObject({ tenantName: tenant.name, available: false, selfRegistration: false });
  });

  it('disconnects connected sockets with TENANT_SUSPENDED', async () => {
    await getTestWorker();
    const tenant = await createTenant();
    const agent = await createUser(tenant, { roles: ['agent'] });

    const socket = await connectSocket(agent);
    const closing = waitForEvent<{ code: string }>(socket, 'closing', () => true, 20_000);

    const response = await operator.post(`/platform/tenants/${tenant.id}/suspend`, {});
    expect(response.status).toBe(200);

    await expect(closing).resolves.toEqual({ code: 'TENANT_SUSPENDED' });
    socket.close();
  });

  it('refuses a socket handshake while suspended', async () => {
    const tenant = await createTenant();
    const agent = await createUser(tenant, { roles: ['agent'] });
    await operator.post(`/platform/tenants/${tenant.id}/suspend`, {});

    await expect(connectSocket(agent)).rejects.toMatchObject({ code: 'TENANT_SUSPENDED' });
  });

  it('is idempotent and 404s an unknown tenant', async () => {
    const tenant = await createTenant();
    const first = await operator.post(`/platform/tenants/${tenant.id}/suspend`, {});
    const second = await operator.post(`/platform/tenants/${tenant.id}/suspend`, {});
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(second.body).toMatchObject({ status: 'suspended', suspendedAt: (first.body as { suspendedAt: string }).suspendedAt });

    const unknown = await operator.post('/platform/tenants/01920000-0000-7000-8000-000000000000/suspend', {});
    expect(unknown.status).toBe(404);
  });
});

describe('POST /platform/tenants/{id}/reactivate', () => {
  it('restores access with the data intact', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'], password: PASSWORD });
    const customer = await createUser(tenant, { roles: ['customer'], name: 'Cora Customer' });

    await operator.post(`/platform/tenants/${tenant.id}/suspend`, {});
    const reactivated = await operator.post(`/platform/tenants/${tenant.id}/reactivate`);
    expect(reactivated.status).toBe(200);
    expect(reactivated.body).toMatchObject({ status: 'active', suspendedAt: null });

    // The old session was ended by the suspension, but the account and its data are untouched:
    // signing in again works and finds everything.
    const signIn = await asGuest(tenant).post('/auth/sign-in', { email: admin.email, password: PASSWORD });
    expect(signIn.status).toBe(200);
    const cookies = setCookieValues(signIn.headers['set-cookie']);
    const signedIn: TestUser = {
      ...admin,
      sessionToken: cookies.get('rx_session'),
      csrfToken: cookies.get('rx_csrf') as string,
    };

    const listed = await asUser(signedIn).get('/users');
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).toContain(customer.id);
    expect((await asGuest(tenant).get('/customer/branding')).body).toMatchObject({ available: true });
  });

  it('is idempotent on an already active tenant', async () => {
    const tenant = await createTenant();
    const response = await operator.post(`/platform/tenants/${tenant.id}/reactivate`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'active' });
  });
});

describe('suspension does not reach other tenants', () => {
  it('leaves tenant B signed in and working', async () => {
    const [a, b] = await Promise.all([createTenant(), createTenant()]);
    const [aAdmin, bAdmin] = await Promise.all([
      createUser(a, { roles: ['admin'] }),
      createUser(b, { roles: ['admin'] }),
    ]);

    await operator.post(`/platform/tenants/${a.id}/suspend`, {});

    expect((await asUser(aAdmin).get('/me')).status).toBe(503);
    expect((await asUser(bAdmin).get('/me')).status).toBe(200);
  });
});
