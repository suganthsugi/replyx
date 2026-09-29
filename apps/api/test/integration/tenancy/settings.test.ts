import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../../src/platform-kernel/db/database.js';
import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { meetsAAContrast } from '../../../src/tenancy/contrast.js';
import { getTestApp, service } from '../../support/app.js';
import { createTenant, createUser, type TestTenant } from '../../support/factories.js';
import { asUser } from '../../support/http.js';

import type { Database } from '../../../src/platform-kernel/db/database.js';
import type { Kysely } from 'kysely';

/**
 * `GET`/`PATCH /settings` (T183, src/tenancy/settings.{service,controller}.ts,
 * `tenant_settings.view`/`tenant_settings.edit`, contracts/operations.yaml `/settings`).
 */

const errorBody = (code: string) => ({ error: expect.objectContaining({ code, message: expect.any(String) as string }) as object });

interface SettingsBody {
  name: string;
  logoAttachmentId: string | null;
  brandColors: { primary?: string; accent?: string };
  welcomeMessage: string | null;
  timezone: string;
  selfRegistration: boolean;
  gracePeriodHours: number;
  afterCloseBehavior: string;
  offlineCustomerNotification: string;
  outOfHoursMessage: string | null;
}

const settings = (response: { body: unknown }) => response.body as SettingsBody;
const failure = (response: { body: unknown }) =>
  response.body as { error: { code: string; details?: { path: string; issue: string; suggestion?: string }[] } };

function ctxFor(tenant: TestTenant): TenantContext {
  return TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'settings-test' });
}

async function auditEntries(tenant: TestTenant) {
  const unitOfWork = await service(UnitOfWork);
  const ctx = ctxFor(tenant);
  return unitOfWork.withTenantReadOnly(ctx, (tx) => new AuditQuery(ctx).changed(tx));
}

class AuditQuery extends TenantRepository {
  changed(tx: TenantTransaction) {
    return this.selectFrom(tx, 'audit_logs')
      .select(['details', 'resource_id'])
      .where('action', '=', 'tenant_settings.changed')
      .orderBy('occurred_at')
      .execute();
  }
}

beforeAll(async () => {
  await getTestApp();
});

describe('GET /settings', () => {
  it('returns the settings shape to an admin, and 403 to an agent', async () => {
    const tenant = await createTenant({ name: 'Acme Support' });
    const [admin, agent] = await Promise.all([
      createUser(tenant, { roles: ['admin'] }),
      createUser(tenant, { roles: ['agent'] }),
    ]);

    const response = await asUser(admin).get('/settings');
    expect(response.status).toBe(200);
    expect(settings(response)).toMatchObject({
      name: 'Acme Support',
      logoAttachmentId: null,
      brandColors: expect.any(Object) as object,
      timezone: expect.any(String) as string,
      selfRegistration: expect.any(Boolean) as boolean,
      gracePeriodHours: expect.any(Number) as number,
      afterCloseBehavior: expect.stringMatching(/^(new_follow_up|reopen_previous)$/) as string,
      offlineCustomerNotification: expect.stringMatching(/^(email|off)$/) as string,
    });

    const denied = await asUser(agent).get('/settings');
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual(errorBody('PERMISSION_DENIED'));
  });

  it('is 403 for a manager, who also lacks tenant_settings.view by default', async () => {
    const tenant = await createTenant();
    const manager = await createUser(tenant, { roles: ['manager'] });
    const response = await asUser(manager).get('/settings');
    expect(response.status).toBe(403);
    expect(response.body).toEqual(errorBody('PERMISSION_DENIED'));
  });
});

describe('PATCH /settings', () => {
  it('is 403 for an agent', async () => {
    const tenant = await createTenant();
    const agent = await createUser(tenant, { roles: ['agent'] });
    const response = await asUser(agent).patch('/settings', { welcomeMessage: 'Hi' });
    expect(response.status).toBe(403);
    expect(response.body).toEqual(errorBody('PERMISSION_DENIED'));
  });

  it('changes only the fields sent, and merges brandColors keeping the other key', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });

    const seeded = await asUser(admin).patch('/settings', {
      brandColors: { primary: '#123456', accent: '#654321' },
      welcomeMessage: 'Welcome!',
      timezone: 'Europe/Berlin',
    });
    expect(seeded.status).toBe(200);
    expect(settings(seeded)).toMatchObject({
      brandColors: { primary: '#123456', accent: '#654321' },
      welcomeMessage: 'Welcome!',
      timezone: 'Europe/Berlin',
    });

    // Sending only brandColors.primary must keep the existing accent (merge, not replace).
    const updated = await asUser(admin).patch('/settings', { brandColors: { primary: '#000000' } });
    expect(updated.status).toBe(200);
    expect(settings(updated)).toMatchObject({
      brandColors: { primary: '#000000', accent: '#654321' },
      welcomeMessage: 'Welcome!', // unsent field is untouched
      timezone: 'Europe/Berlin', // unsent field is untouched
    });

    const reread = await asUser(admin).get('/settings');
    expect(settings(reread)).toMatchObject(settings(updated));
  });

  it('reflects a rename in GET /customer/branding', async () => {
    const tenant = await createTenant({ name: 'Old Name' });
    const admin = await createUser(tenant, { roles: ['admin'] });

    const renamed = await asUser(admin).patch('/settings', { name: 'New Name' });
    expect(renamed.status).toBe(200);
    expect(settings(renamed).name).toBe('New Name');

    const branding = await asUser(admin, { host: tenant.host }).get('/customer/branding');
    expect(branding.status).toBe(200);
    expect((branding.body as { tenantName: string }).tenantName).toBe('New Name');
  });

  it('validates gracePeriodHours, welcomeMessage length, timezone and unknown keys', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });

    for (const [body, expected] of [
      [{ gracePeriodHours: 0 }, [{ path: 'gracePeriodHours', issue: 'too_small' }]],
      [{ gracePeriodHours: 721 }, [{ path: 'gracePeriodHours', issue: 'too_large' }]],
      [{ welcomeMessage: 'x'.repeat(501) }, [{ path: 'welcomeMessage', issue: 'too_long' }]],
      [{ timezone: 'Mars/Base' }, [{ path: 'timezone', issue: 'invalid' }]],
      [{ businessHoursId: 'x' }, [{ path: 'businessHoursId', issue: 'unrecognized_key' }]],
    ] as const) {
      const response = await asUser(admin).patch('/settings', body);
      expect(response.status).toBe(400);
      expect(failure(response).error.details).toEqual(expected);
    }
  });

  it('rejects a low-contrast primary with an AA-compliant suggestion that itself passes', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });

    const response = await asUser(admin).patch('/settings', { brandColors: { primary: '#eeeeee' } });
    expect(response.status).toBe(400);
    const details = failure(response).error.details;
    expect(details).toHaveLength(1);
    const detail = (details as { path: string; issue: string; suggestion?: string }[])[0];
    if (detail === undefined) throw new Error('Expected one validation detail');
    expect(detail).toMatchObject({ path: 'brandColors.primary', issue: 'insufficient_contrast' });
    expect(detail.suggestion).toBeDefined();
    expect(meetsAAContrast(detail.suggestion as string)).toBe(true);

    // Patching the suggestion back succeeds.
    const applied = await asUser(admin).patch('/settings', { brandColors: { primary: detail.suggestion } });
    expect(applied.status).toBe(200);
    expect(settings(applied).brandColors.primary).toBe(detail.suggestion);
  });

  it('writes one audit entry per effective PATCH with old/new of only the changed fields, none for a no-op', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });

    const first = await asUser(admin).patch('/settings', { welcomeMessage: 'Hello there', gracePeriodHours: 12 });
    expect(first.status).toBe(200);

    const entries = await auditEntries(tenant);
    expect(entries).toHaveLength(1);
    const details = entries[0]?.details as Record<string, { old: unknown; new: unknown }>;
    expect(Object.keys(details).sort()).toEqual(['gracePeriodHours', 'welcomeMessage']);
    expect(details.welcomeMessage).toMatchObject({ new: 'Hello there' });
    expect(details.gracePeriodHours).toMatchObject({ new: 12 });

    // A PATCH that resends the same values changes nothing, so no new audit entry.
    const noop = await asUser(admin).patch('/settings', { welcomeMessage: 'Hello there', gracePeriodHours: 12 });
    expect(noop.status).toBe(200);
    expect(await auditEntries(tenant)).toHaveLength(1);
  });
});

describe('cross-tenant', () => {
  it("tenant B admin's PATCH never changes tenant A, including a rename, and only ever shows B", async () => {
    const [a, b] = await Promise.all([createTenant({ name: 'Tenant A' }), createTenant({ name: 'Tenant B' })]);
    const [adminA, adminB] = await Promise.all([
      createUser(a, { roles: ['admin'] }),
      createUser(b, { roles: ['admin'] }),
    ]);

    const patched = await asUser(adminB).patch('/settings', {
      name: 'Renamed by tenant B',
      welcomeMessage: 'From tenant B',
    });
    expect(patched.status).toBe(200);
    expect(settings(patched)).toMatchObject({ name: 'Renamed by tenant B', welcomeMessage: 'From tenant B' });
    expect(JSON.stringify(patched.body)).not.toContain('Tenant A');

    const afterA = await asUser(adminA).get('/settings');
    expect(settings(afterA)).toMatchObject({ name: 'Tenant A', welcomeMessage: null });
  });

  it('a direct UPDATE tenants SET name inside tenant A context cannot rename tenant B', async () => {
    const [a, b] = await Promise.all([createTenant(), createTenant({ name: 'Tenant B original' })]);
    const db: Kysely<Database> = createDatabase(process.env.DATABASE_URL_APP as string, 'app');
    try {
      await expect(
        db.transaction().execute(async (tx) => {
          await sql`SELECT set_config('app.tenant_id', ${a.id}, true)`.execute(tx);
          await tx.updateTable('tenants').set({ name: 'Hijacked by A' }).where('id', '=', b.id).execute();
        }),
      ).rejects.toThrow(/cannot rename another tenant/);
    } finally {
      await db.destroy();
    }

    const stillB = await asUser(await createUser(b, { roles: ['admin'] })).get('/settings');
    expect(settings(stillB).name).toBe('Tenant B original');
  });
});
