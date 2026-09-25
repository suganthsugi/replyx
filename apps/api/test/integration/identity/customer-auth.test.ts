import { randomUUID } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { SIGN_IN_LINK_TTL_MS } from '../../../src/identity/customer-auth.service.js';
import { CUSTOMER_TRUSTED_IDLE_MS, SessionService } from '../../../src/identity/session.service.js';
import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { QueueRegistry } from '../../../src/platform-kernel/jobs/queues.js';
import { EMAIL_JOB, type EmailJobData } from '../../../src/platform-kernel/mail/mail.service.js';
import { getTestApp, service } from '../../support/app.js';
import { createTenant, createUser, type TestTenant, type TestUser } from '../../support/factories.js';
import { asGuest, asUser } from '../../support/http.js';

import type { TestClient } from '../../support/http.js';

/**
 * Customer sign-in and profile (T065; identity/customer-auth.{controller,service}.ts,
 * openapi.yaml `/customer/auth/*`, `/customer/me`).
 */

const errorBody = (code: string) => ({ error: expect.objectContaining({ code, message: expect.any(String) as string }) as object });

const NOT_FOUND_BODY = { error: { code: 'NOT_FOUND', message: 'Not found' } };

function ctxFor(tenant: { id: string }): TenantContext {
  return TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'customer-auth-test' });
}

function setCookies(response: { headers: Record<string, unknown> }): string[] {
  const raw = response.headers['set-cookie'];
  if (Array.isArray(raw)) return raw as string[];
  return typeof raw === 'string' ? [raw] : [];
}

function findCookie(cookies: string[], name: string): string | undefined {
  return cookies.find((cookie) => cookie.startsWith(`${name}=`));
}

class LinksRepository extends TenantRepository {
  newestFor(tx: TenantTransaction, email: string) {
    return this.selectFrom(tx, 'sign_in_links')
      .innerJoin('users', (join) =>
        join.onRef('users.tenant_id', '=', 'sign_in_links.tenant_id').onRef('users.id', '=', 'sign_in_links.user_id'),
      )
      .select('sign_in_links.id')
      .where('users.email', '=', email)
      .orderBy('sign_in_links.created_at', 'desc')
      .orderBy('sign_in_links.id', 'desc')
      .executeTakeFirst();
  }
}

/** The id of the newest sign-in link of `email`, which is also its email job's dedupe key. */
async function newestLinkId(tenant: TestTenant, email: string): Promise<string> {
  const unitOfWork = await service(UnitOfWork);
  const row = await unitOfWork.withTenantReadOnly(ctxFor(tenant), (tx) =>
    new LinksRepository(ctxFor(tenant)).newestFor(tx, email),
  );
  if (row === undefined) throw new Error(`no sign_in_links row for ${email}`);
  return row.id;
}

class SettingsRepository extends TenantRepository {
  setSelfRegistration(tx: TenantTransaction, enabled: boolean) {
    return this.updateTable(tx, 'tenant_settings').set({ self_registration: enabled }).execute();
  }
}

async function setSelfRegistration(tenant: TestTenant, enabled: boolean): Promise<void> {
  const unitOfWork = await service(UnitOfWork);
  await unitOfWork.withTenant(ctxFor(tenant), (tx) => new SettingsRepository(ctxFor(tenant)).setSelfRegistration(tx, enabled));
}

function requestLink(tenant: TestTenant, email: string, name?: string): ReturnType<TestClient['post']> {
  return asGuest(tenant).post('/customer/auth/sign-in-link', name === undefined ? { email } : { email, name });
}

async function emailJobsFor(email: string) {
  const queues = await service(QueueRegistry);
  const jobs = await queues.get('email').getJobs(['waiting', 'delayed', 'active', 'completed']);
  return jobs.filter((job) => job.name === EMAIL_JOB && (job.data as EmailJobData).to === email);
}

/**
 * Requests a sign-in link and returns its token. The email job is looked up by the link's own
 * dedupe key, because `getJobs` over several states has no guaranteed order.
 */
async function linkTokenFor(tenant: TestTenant, email: string, name?: string): Promise<string> {
  const response = await requestLink(tenant, email, name);
  expect(response.status).toBe(202);
  const linkId = await newestLinkId(tenant, email);
  const queues = await service(QueueRegistry);
  const job = await queues.get('email').getJob(`email.sign-in-link.${linkId}`);
  if (job === undefined) throw new Error(`no sign-in-link email queued for ${email}`);
  const url = (job.data as EmailJobData).vars.url;
  if (url === undefined) throw new Error('sign-in link email carried no url');
  const token = new URL(url).searchParams.get('token');
  if (token === null) throw new Error('sign-in link email carried no token');
  return token;
}

beforeAll(async () => {
  await getTestApp();
});

describe('POST /customer/auth/sign-in-link', () => {
  it('answers 202 identically for an existing account and an unknown email, and self-registers when allowed', async () => {
    const tenant = await createTenant();
    const existing = await createUser(tenant, { roles: ['customer'] });
    const newEmail = `new-${randomUUID()}@example.test`;

    const existingResponse = await requestLink(tenant, existing.email);
    const newResponse = await requestLink(tenant, newEmail, 'Newcomer');

    expect(existingResponse.status).toBe(202);
    expect(newResponse.status).toBe(202);
    expect(newResponse.body).toEqual(existingResponse.body);

    const existingJobs = await emailJobsFor(existing.email);
    expect(existingJobs).toHaveLength(1);
    expect((existingJobs[0]!.data as EmailJobData).vars.url).toContain(`${tenant.slug}.`);
    expect((existingJobs[0]!.data as EmailJobData).vars.url).toContain('/sign-in/redeem?token=');

    const newJobs = await emailJobsFor(newEmail);
    expect(newJobs).toHaveLength(1);
    const url = (newJobs[0]!.data as EmailJobData).vars.url as string;
    const token = new URL(url).searchParams.get('token');

    // The new email created a customer (role Customer, customer_profiles row): redeeming signs them in.
    const redeemed = await asGuest(tenant).post('/customer/auth/sign-in-link/redeem', { token });
    expect(redeemed.status).toBe(200);
    expect(redeemed.body).toMatchObject({ email: newEmail, name: 'Newcomer', hasPassword: false });
  });

  it('sends no link for an unknown email when self-registration is off, but still sends one for an existing customer', async () => {
    const tenant = await createTenant();
    const existing = await createUser(tenant, { roles: ['customer'] });
    await setSelfRegistration(tenant, false);
    const unknownEmail = `unknown-${randomUUID()}@example.test`;

    const [unknownResponse, existingResponse] = await Promise.all([requestLink(tenant, unknownEmail), requestLink(tenant, existing.email)]);
    expect(unknownResponse.status).toBe(202);
    expect(existingResponse.status).toBe(202);

    expect(await emailJobsFor(unknownEmail)).toHaveLength(0);
    expect(await emailJobsFor(existing.email)).toHaveLength(1);
  });

  it('never sends a link for a staff email', async () => {
    const tenant = await createTenant();
    const staff = await createUser(tenant, { roles: ['agent'] });

    const response = await requestLink(tenant, staff.email);
    expect(response.status).toBe(202);
    expect(await emailJobsFor(staff.email)).toHaveLength(0);
  });

  it('supersedes an older unused link when a new one is requested', async () => {
    const tenant = await createTenant();
    const customer = await createUser(tenant, { roles: ['customer'] });

    const oldToken = await linkTokenFor(tenant, customer.email);
    const newToken = await linkTokenFor(tenant, customer.email);
    expect(newToken).not.toBe(oldToken);

    const oldRedeem = await asGuest(tenant).post('/customer/auth/sign-in-link/redeem', { token: oldToken });
    expect(oldRedeem.status).toBe(400);
    expect(oldRedeem.body).toEqual(errorBody('LINK_INVALID_OR_EXPIRED'));

    const newRedeem = await asGuest(tenant).post('/customer/auth/sign-in-link/redeem', { token: newToken });
    expect(newRedeem.status).toBe(200);
  });

  it('answers 429 RATE_LIMITED with Retry-After on the 6th request for the same email within an hour', async () => {
    const tenant = await createTenant();
    const customer = await createUser(tenant, { roles: ['customer'] });

    const statuses: number[] = [];
    let last: Awaited<ReturnType<typeof requestLink>> | undefined;
    for (let i = 0; i < 6; i++) {
      last = await requestLink(tenant, customer.email);
      statuses.push(last.status);
    }
    expect(statuses.slice(0, 5).every((status) => status === 202)).toBe(true);
    expect(last?.status).toBe(429);
    expect(last?.body).toEqual({
      error: { code: 'RATE_LIMITED', message: expect.any(String) as string, retryAfter: expect.any(Number) as number },
    });
    expect(Number(last?.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });
});

describe('POST /customer/auth/sign-in-link/redeem', () => {
  it('is single use', async () => {
    const tenant = await createTenant();
    const customer = await createUser(tenant, { roles: ['customer'] });
    const token = await linkTokenFor(tenant, customer.email);

    const first = await asGuest(tenant).post('/customer/auth/sign-in-link/redeem', { token });
    expect(first.status).toBe(200);

    const second = await asGuest(tenant).post('/customer/auth/sign-in-link/redeem', { token });
    expect(second.status).toBe(400);
    expect(second.body).toEqual(errorBody('LINK_INVALID_OR_EXPIRED'));
  });

  it('expires 15 minutes after it was sent', async () => {
    const { clock } = await getTestApp();
    const tenant = await createTenant();
    const customer = await createUser(tenant, { roles: ['customer'] });
    const token = await linkTokenFor(tenant, customer.email);

    clock.advance(SIGN_IN_LINK_TTL_MS + 1000);
    const expired = await asGuest(tenant).post('/customer/auth/sign-in-link/redeem', { token });
    expect(expired.status).toBe(400);
    expect(expired.body).toEqual(errorBody('LINK_INVALID_OR_EXPIRED'));
  });

  it('sets rx_session (30-day Max-Age when trusted) and rx_csrf, and returns CustomerMe', async () => {
    const tenant = await createTenant();
    const customer = await createUser(tenant, { roles: ['customer'] });
    const token = await linkTokenFor(tenant, customer.email);

    const response = await asGuest(tenant).post('/customer/auth/sign-in-link/redeem', { token, trustDevice: true });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: customer.id, email: customer.email, hasPassword: false });

    const cookies = setCookies(response);
    const sessionCookie = findCookie(cookies, 'rx_session');
    const csrfCookie = findCookie(cookies, 'rx_csrf');
    expect(sessionCookie).toBeTruthy();
    expect(csrfCookie).toBeTruthy();
    expect(sessionCookie).toContain(`Max-Age=${CUSTOMER_TRUSTED_IDLE_MS / 1000}`);
  });
});

describe('POST /customer/auth/sign-in', () => {
  it('signs in with a password set through the profile', async () => {
    const tenant = await createTenant();
    const customer = await createUser(tenant, { roles: ['customer'] });
    const newPassword = 'Customer-Password-1';

    const updateResponse = await asUser(customer).patch('/customer/me', { newPassword });
    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body).toMatchObject({ hasPassword: true });

    const signInResponse = await asGuest(tenant).post('/customer/auth/sign-in', { email: customer.email, password: newPassword });
    expect(signInResponse.status).toBe(200);
    expect(signInResponse.body).toMatchObject({ id: customer.id, email: customer.email });
  });

  it('answers 401 INVALID_CREDENTIALS when no password is set or the password is wrong', async () => {
    const tenant = await createTenant();
    const withoutPassword = await createUser(tenant, { roles: ['customer'] });

    const noPassword = await asGuest(tenant).post('/customer/auth/sign-in', { email: withoutPassword.email, password: 'whatever-1' });
    expect(noPassword.status).toBe(401);
    expect(noPassword.body).toEqual(errorBody('INVALID_CREDENTIALS'));

    const withPassword = await createUser(tenant, { roles: ['customer'], password: 'Correct-Password-1' });
    const wrong = await asGuest(tenant).post('/customer/auth/sign-in', { email: withPassword.email, password: 'wrong-password-1' });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual(noPassword.body);
  });
});

describe('POST /customer/auth/sign-out and /customer/auth/sign-out-all', () => {
  it('ends the current session with 204 and the session stops working', async () => {
    const tenant = await createTenant();
    const customer = await createUser(tenant, { roles: ['customer'] });

    const response = await asUser(customer).post('/customer/auth/sign-out');
    expect(response.status).toBe(204);

    const retry = await asUser(customer).post('/customer/auth/sign-out');
    expect(retry.status).toBe(401);
    expect(retry.body).toEqual(errorBody('UNAUTHENTICATED'));
  });

  it('403s a caller without CSRF', async () => {
    const tenant = await createTenant();
    const customer = await createUser(tenant, { roles: ['customer'] });

    const noCsrf = await asUser(customer, { csrf: false }).post('/customer/auth/sign-out');
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body).toEqual(errorBody('CSRF_FAILED'));
  });

  it('ends every session of the customer', async () => {
    const tenant = await createTenant();
    const customer = await createUser(tenant, { roles: ['customer'] });
    const unitOfWork = await service(UnitOfWork);
    const sessions = await service(SessionService);
    const { token: otherToken } = await unitOfWork.withTenant(ctxFor(tenant), (tx) =>
      sessions.create(tx, { userId: customer.id, kind: 'customer' }),
    );
    const otherSession: TestUser = { ...customer, sessionToken: otherToken };

    const response = await asUser(customer).post('/customer/auth/sign-out-all');
    expect(response.status).toBe(204);

    expect((await asUser(customer).post('/customer/auth/sign-out-all')).status).toBe(401);
    expect((await asUser(otherSession).post('/customer/auth/sign-out-all')).status).toBe(401);
  });
});

describe('GET /customer/me', () => {
  it('returns the current customer', async () => {
    const tenant = await createTenant();
    const customer = await createUser(tenant, { roles: ['customer'] });

    const response = await asUser(customer).get('/customer/me');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: customer.id,
      name: customer.name,
      email: customer.email,
      avatarUrl: null,
      hasPassword: false,
      emailOnReply: true,
    });
  });

  it('answers 404 NOT_FOUND for a staff session (customer routes hidden from staff)', async () => {
    const tenant = await createTenant();
    const staff = await createUser(tenant, { roles: ['admin'] });

    const response = await asUser(staff).get('/customer/me');
    expect(response.status).toBe(404);
    expect(response.body).toEqual(NOT_FOUND_BODY);
  });
});

describe('PATCH /customer/me', () => {
  it('updates name and the email-on-reply preference', async () => {
    const tenant = await createTenant();
    const customer = await createUser(tenant, { roles: ['customer'] });

    const response = await asUser(customer).patch('/customer/me', { name: 'Updated Name', emailOnReply: false });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ name: 'Updated Name', emailOnReply: false });

    const me = await asUser(customer).get('/customer/me');
    expect(me.body).toMatchObject({ name: 'Updated Name', emailOnReply: false });
  });

  it('requires currentPassword to change the password once one is set, with 400 details on currentPassword', async () => {
    const tenant = await createTenant();
    const customer = await createUser(tenant, { roles: ['customer'], password: 'Original-Password-1' });

    const missing = await asUser(customer).patch('/customer/me', { newPassword: 'Brand-New-Password-2' });
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({
      error: {
        code: 'VALIDATION_FAILED',
        message: expect.any(String) as string,
        details: [{ path: 'currentPassword', issue: 'incorrect' }],
      },
    });

    const wrong = await asUser(customer).patch('/customer/me', {
      newPassword: 'Brand-New-Password-2',
      currentPassword: 'not-the-right-one',
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toEqual(missing.body);

    const correct = await asUser(customer).patch('/customer/me', {
      newPassword: 'Brand-New-Password-2',
      currentPassword: 'Original-Password-1',
    });
    expect(correct.status).toBe(200);
    expect(correct.body).toMatchObject({ hasPassword: true });
  });

  it('ends the customer\'s other sessions when the password changes', async () => {
    const tenant = await createTenant();
    const customer = await createUser(tenant, { roles: ['customer'], password: 'Original-Password-1' });
    const unitOfWork = await service(UnitOfWork);
    const sessions = await service(SessionService);
    const { token: otherToken } = await unitOfWork.withTenant(ctxFor(tenant), (tx) =>
      sessions.create(tx, { userId: customer.id, kind: 'customer' }),
    );
    const otherSession: TestUser = { ...customer, sessionToken: otherToken };

    const response = await asUser(customer).patch('/customer/me', {
      newPassword: 'Brand-New-Password-2',
      currentPassword: 'Original-Password-1',
    });
    expect(response.status).toBe(200);

    expect((await asUser(otherSession).get('/customer/me')).status).toBe(401);
    expect((await asUser(customer).get('/customer/me')).status).toBe(200);
  });
});

describe('cross-audience: customer session on a staff route', () => {
  it('answers 404 NOT_FOUND for a customer on GET /roles', async () => {
    const tenant = await createTenant();
    const customer = await createUser(tenant, { roles: ['customer'] });

    const response = await asUser(customer).get('/roles');
    expect(response.status).toBe(404);
    expect(response.body).toEqual(NOT_FOUND_BODY);
  });
});
