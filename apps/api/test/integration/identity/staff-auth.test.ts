import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';

import { LOCKOUT_DURATION_MS, LOCKOUT_MAX_FAILURES } from '../../../src/identity/lockout.service.js';
import { SessionService } from '../../../src/identity/session.service.js';
import { PASSWORD_MIN_LENGTH } from '../../../src/identity/staff-auth.controller.js';
import { PASSWORD_RESET_TTL_MS } from '../../../src/identity/staff-auth.service.js';
import { createDatabase } from '../../../src/platform-kernel/db/database.js';
import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { QueueRegistry } from '../../../src/platform-kernel/jobs/queues.js';
import { EMAIL_JOB, type EmailJobData } from '../../../src/platform-kernel/mail/mail.service.js';
import { getTestApp, getTestWorker, service } from '../../support/app.js';
import { createTenant, createUser, type TestTenant, type TestUser } from '../../support/factories.js';
import { asGuest, asUser } from '../../support/http.js';
import { connectSocket, waitForEvent } from '../../support/socket.js';

/**
 * Staff sign-in, sign-out and password reset (T064; identity/staff-auth.{controller,service}.ts,
 * openapi.yaml `/auth/*`).
 */

const errorBody = (code: string) => ({ error: expect.objectContaining({ code, message: expect.any(String) as string }) as object });

const PASSWORD = 'Correct-Horse-Battery-1';

function ctxFor(tenant: { id: string }): TenantContext {
  return TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'staff-auth-test' });
}

/** Rows for one action in a tenant's audit log, newest first. */
async function auditRows(
  tenant: TestTenant,
  action: string,
): Promise<{ resource_id: string | null; details: unknown }[]> {
  const unitOfWork = await service(UnitOfWork);
  return unitOfWork.withTenantReadOnly(ctxFor(tenant), (tx) => new AuditQuery(tenant).rows(tx, action));
}

class AuditQuery extends TenantRepository {
  constructor(tenant: { id: string }) {
    super(ctxFor(tenant));
  }

  rows(tx: TenantTransaction, action: string): Promise<{ resource_id: string | null; details: unknown }[]> {
    return this.selectFrom(tx, 'audit_logs')
      .select(['resource_id', 'details'])
      .where('action', '=', action)
      .orderBy('occurred_at', 'desc')
      .execute();
  }
}

function setCookies(response: { headers: Record<string, unknown> }): string[] {
  const raw = response.headers['set-cookie'];
  if (Array.isArray(raw)) return raw as string[];
  return typeof raw === 'string' ? [raw] : [];
}

function cookieValue(cookies: string[], name: string): string | undefined {
  for (const cookie of cookies) {
    const match = new RegExp(`^${name}=([^;]*)`).exec(cookie);
    if (match) return match[1];
  }
  return undefined;
}

async function setSuspended(tenantId: string, suspended: boolean): Promise<void> {
  const platform = createDatabase(process.env.DATABASE_URL_PLATFORM as string, 'platform');
  try {
    await sql`UPDATE tenants SET status = ${suspended ? 'suspended' : 'active'}, suspended_at = ${suspended ? sql`now()` : null} WHERE id = ${tenantId}`.execute(
      platform,
    );
  } finally {
    await platform.destroy();
  }
}

beforeAll(async () => {
  await getTestApp();
});

describe('POST /auth/sign-in', () => {
  it('signs in an active staff user, sets cookies and returns Me', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'], password: PASSWORD, session: false });

    const response = await asGuest(tenant).post('/auth/sign-in', { email: admin.email, password: PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: admin.id, email: admin.email, kind: 'staff' });
    const cookies = setCookies(response);
    expect(cookieValue(cookies, 'rx_session')).toBeTruthy();
    expect(cookieValue(cookies, 'rx_csrf')).toBeTruthy();

    const rows = await auditRows(tenant, 'auth.sign_in');
    expect(rows).toEqual([{ resource_id: admin.id, details: {} }]);
  });

  it('answers the same 401 INVALID_CREDENTIALS for an unknown email and a wrong password', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'], password: PASSWORD, session: false });

    const unknown = await asGuest(tenant).post('/auth/sign-in', { email: 'nobody@example.test', password: PASSWORD });
    const wrongPassword = await asGuest(tenant).post('/auth/sign-in', { email: admin.email, password: 'wrong-password-here' });

    expect(unknown.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    expect(unknown.body).toEqual(errorBody('INVALID_CREDENTIALS'));
    expect(wrongPassword.body).toEqual(unknown.body);

    const rows = await auditRows(tenant, 'auth.sign_in_failed');
    expect(rows).toEqual(
      expect.arrayContaining([
        { resource_id: null, details: { reason: 'invalid_credentials' } },
        { resource_id: admin.id, details: { reason: 'invalid_credentials' } },
      ]) as unknown[],
    );
  });

  it('answers 401 INVALID_CREDENTIALS for an invited or deactivated staff user', async () => {
    const tenant = await createTenant();
    const invited = await createUser(tenant, { roles: ['admin'], password: PASSWORD, status: 'invited', session: false });
    const deactivated = await createUser(tenant, { roles: ['admin'], password: PASSWORD, status: 'deactivated', session: false });

    const [invitedResponse, deactivatedResponse, unknown] = await Promise.all([
      asGuest(tenant).post('/auth/sign-in', { email: invited.email, password: PASSWORD }),
      asGuest(tenant).post('/auth/sign-in', { email: deactivated.email, password: PASSWORD }),
      asGuest(tenant).post('/auth/sign-in', { email: 'nobody@example.test', password: PASSWORD }),
    ]);

    expect([invitedResponse.status, deactivatedResponse.status]).toEqual([401, 401]);
    expect(invitedResponse.body).toEqual(unknown.body);
    expect(deactivatedResponse.body).toEqual(unknown.body);
  });

  it('locks the account on the 5th failure within 15 minutes and unlocks 15 minutes later', async () => {
    const { clock } = await getTestApp();
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'], password: PASSWORD, session: false });

    let last: Awaited<ReturnType<ReturnType<typeof asGuest>['post']>> | undefined;
    for (let attempt = 0; attempt < LOCKOUT_MAX_FAILURES; attempt++) {
      last = await asGuest(tenant).post('/auth/sign-in', { email: admin.email, password: 'still-wrong-password' });
      if (attempt < LOCKOUT_MAX_FAILURES - 1) {
        expect(last.status).toBe(401);
        expect(last.body).toEqual(errorBody('INVALID_CREDENTIALS'));
      }
    }
    // The 5th failure is the one that sets the lock: 423, not 401.
    expect(last?.status).toBe(423);
    expect(last?.body).toEqual(errorBody('ACCOUNT_LOCKED'));

    // Locked out even with the correct password.
    const stillLocked = await asGuest(tenant).post('/auth/sign-in', { email: admin.email, password: PASSWORD });
    expect(stillLocked.status).toBe(423);
    expect(stillLocked.body).toEqual(errorBody('ACCOUNT_LOCKED'));

    // Just under 15 minutes later, still locked.
    clock.advance(LOCKOUT_DURATION_MS - 60_000);
    const almostUnlocked = await asGuest(tenant).post('/auth/sign-in', { email: admin.email, password: PASSWORD });
    expect(almostUnlocked.status).toBe(423);

    // Past 15 minutes since the lock, sign-in succeeds again.
    clock.advance(120_000);
    const unlocked = await asGuest(tenant).post('/auth/sign-in', { email: admin.email, password: PASSWORD });
    expect(unlocked.status).toBe(200);
  });

  it('answers 503 TENANT_SUSPENDED for a suspended tenant', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'], password: PASSWORD, session: false });
    await setSuspended(tenant.id, true);
    try {
      const response = await asGuest(tenant).post('/auth/sign-in', { email: admin.email, password: PASSWORD });
      expect(response.status).toBe(503);
      expect(response.body).toEqual(errorBody('TENANT_SUSPENDED'));
    } finally {
      await setSuspended(tenant.id, false);
    }
  });
});

describe('POST /auth/sign-out and /auth/sign-out-all', () => {
  it('ends the current session with 204 and the session stops working', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });

    const response = await asUser(admin).post('/auth/sign-out');
    expect(response.status).toBe(204);

    const retry = await asUser(admin).post('/auth/sign-out');
    expect(retry.status).toBe(401);
    expect(retry.body).toEqual(errorBody('UNAUTHENTICATED'));
  });

  it('403s a caller without a matching CSRF token', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });

    // No cookies at all: the CSRF guard runs ahead of authentication on non-GET routes.
    const guest = await asGuest(tenant).post('/auth/sign-out');
    expect(guest.status).toBe(403);
    expect(guest.body).toEqual(errorBody('CSRF_FAILED'));

    // A session cookie without a matching CSRF token is rejected the same way.
    const noCsrf = await asUser(admin, { csrf: false }).post('/auth/sign-out');
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body).toEqual(errorBody('CSRF_FAILED'));
  });

  it('ends every session of the user and disconnects their sockets', async () => {
    await getTestWorker();
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    // A second session for the same user (a second "device").
    const unitOfWork = await service(UnitOfWork);
    const sessions = await service(SessionService);
    const { token: otherToken } = await unitOfWork.withTenant(ctxFor(tenant), (tx) =>
      sessions.create(tx, { userId: admin.id, kind: 'staff' }),
    );
    const otherSession: TestUser = { ...admin, sessionToken: otherToken };

    const socket = await connectSocket(admin);
    const closing = waitForEvent<{ code: string }>(socket, 'closing', () => true, 10_000);

    const response = await asUser(admin).post('/auth/sign-out-all');
    expect(response.status).toBe(204);

    await expect(closing).resolves.toEqual({ code: 'SESSION_REVOKED' });
    socket.close();

    const originalSessionRetry = await asUser(admin).post('/auth/sign-out-all');
    expect(originalSessionRetry.status).toBe(401);
    const otherSessionRetry = await asUser(otherSession).post('/auth/sign-out-all');
    expect(otherSessionRetry.status).toBe(401);
  });
});

describe('POST /auth/password-reset', () => {
  it('always answers 202 and only enqueues an email for an active staff user', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'], password: PASSWORD, session: false });
    const inactive = await createUser(tenant, { roles: ['admin'], password: PASSWORD, status: 'deactivated', session: false });

    const [activeResponse, unknownResponse, inactiveResponse] = await Promise.all([
      asGuest(tenant).post('/auth/password-reset', { email: admin.email }),
      asGuest(tenant).post('/auth/password-reset', { email: 'nobody@example.test' }),
      asGuest(tenant).post('/auth/password-reset', { email: inactive.email }),
    ]);
    expect([activeResponse.status, unknownResponse.status, inactiveResponse.status]).toEqual([202, 202, 202]);

    const queues = await service(QueueRegistry);
    const jobs = (await queues.get('email').getJobs(['waiting', 'delayed', 'active', 'completed'])).filter(
      (job) => job.name === EMAIL_JOB && (job.data as EmailJobData).to === admin.email,
    );
    expect(jobs).toHaveLength(1);
    const data = jobs[0]!.data as EmailJobData;
    expect(data.template).toBe('password-reset');
    expect(data.vars.url).toContain(`${tenant.slug}.`);
    expect(data.vars.url).toContain('/desk/reset-password?token=');

    const inactiveJobs = (await queues.get('email').getJobs(['waiting', 'delayed', 'active', 'completed'])).filter(
      (job) => job.name === EMAIL_JOB && (job.data as EmailJobData).to === inactive.email,
    );
    expect(inactiveJobs).toHaveLength(0);

    const rows = await auditRows(tenant, 'auth.password_reset');
    expect(rows).toEqual([]);
  });
});

describe('POST /auth/password-reset/confirm', () => {
  async function requestReset(tenant: TestTenant, user: TestUser): Promise<string> {
    const response = await asGuest(tenant).post('/auth/password-reset', { email: user.email });
    expect(response.status).toBe(202);
    const queues = await service(QueueRegistry);
    const jobs = await queues.get('email').getJobs(['waiting', 'delayed', 'active', 'completed']);
    const job = jobs.find((candidate) => candidate.name === EMAIL_JOB && (candidate.data as EmailJobData).to === user.email);
    if (job === undefined) throw new Error(`no password-reset email job queued for ${user.email}`);
    const url = (job.data as EmailJobData).vars.url;
    if (url === undefined) throw new Error('reset email carried no url');
    const token = new URL(url).searchParams.get('token');
    if (token === null) throw new Error('reset email carried no token');
    return token;
  }

  it('sets the new password, is single-use, and ends every session', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'], password: PASSWORD });
    const token = await requestReset(tenant, admin);
    const newPassword = 'Freshly-Baked-Password-2';

    const confirmed = await asGuest(tenant).post('/auth/password-reset/confirm', { token, password: newPassword });
    expect(confirmed.status).toBe(204);

    // The old session (created at sign-up) no longer works.
    const revoked = await asUser(admin).post('/auth/sign-out');
    expect(revoked.status).toBe(401);

    // Old password no longer works; the new one does.
    const oldPasswordAttempt = await asGuest(tenant).post('/auth/sign-in', { email: admin.email, password: PASSWORD });
    expect(oldPasswordAttempt.status).toBe(401);
    const newPasswordAttempt = await asGuest(tenant).post('/auth/sign-in', { email: admin.email, password: newPassword });
    expect(newPasswordAttempt.status).toBe(200);

    // Re-using the same token fails with 400 VALIDATION_FAILED.
    const reused = await asGuest(tenant).post('/auth/password-reset/confirm', { token, password: 'another-new-password-3' });
    expect(reused.status).toBe(400);
    expect(reused.body).toEqual({
      error: {
        code: 'VALIDATION_FAILED',
        message: expect.any(String) as string,
        details: [{ path: 'token', issue: 'invalid_or_expired' }],
      },
    });

    const rows = await auditRows(tenant, 'auth.password_reset');
    expect(rows).toEqual([{ resource_id: admin.id, details: {} }]);
  });

  it('answers 400 VALIDATION_FAILED for an unknown or expired token', async () => {
    const tenant = await createTenant();

    const unknown = await asGuest(tenant).post('/auth/password-reset/confirm', {
      token: 'not-a-real-token-at-all-not-a-real-token',
      password: 'some-new-password-here',
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toEqual({
      error: { code: 'VALIDATION_FAILED', message: expect.any(String) as string, details: [{ path: 'token', issue: 'invalid_or_expired' }] },
    });

    const admin = await createUser(tenant, { roles: ['admin'], password: PASSWORD });
    const { clock } = await getTestApp();
    const token = await requestReset(tenant, admin);
    clock.advance(PASSWORD_RESET_TTL_MS + 60_000);
    const expired = await asGuest(tenant).post('/auth/password-reset/confirm', { token, password: 'some-new-password-here' });
    expect(expired.status).toBe(400);
    expect(expired.body).toEqual(unknown.body);
  });

  it('rejects a password shorter than the minimum with 400 VALIDATION_FAILED', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'], password: PASSWORD });
    const token = await requestReset(tenant, admin);

    const short = await asGuest(tenant).post('/auth/password-reset/confirm', { token, password: 'a'.repeat(PASSWORD_MIN_LENGTH - 1) });
    expect(short.status).toBe(400);
    expect(short.body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });
});
