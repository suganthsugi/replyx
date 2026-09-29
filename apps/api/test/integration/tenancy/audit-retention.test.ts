import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditService } from '../../../src/audit/audit.service.js';
import { Clock } from '../../../src/platform-kernel/clock.js';
import { createDatabase, PLATFORM_DB, type Database } from '../../../src/platform-kernel/db/database.js';
import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { QueueRegistry } from '../../../src/platform-kernel/jobs/queues.js';
import { AuditRetentionJob } from '../../../src/tenancy/retention/audit-retention.job.js';
import { getTestApp, service } from '../../support/app.js';
import { createTenant, createTicket, createUser, type TestTenant, type TestUser } from '../../support/factories.js';
import { asUser } from '../../support/http.js';

/**
 * Audit retention (FR-005a, research D18): the confirmation flow of `PATCH /settings` for a
 * shortened `auditRetention`, the partial-failure record of the audit purge job, and the
 * privileges of the `replyx_retention` role.
 */

const YEAR_MS = 365 * 24 * 3_600_000;
const DELETE_BATCH_SIZE = 1_000; // audit-retention.job.ts

interface Failure {
  error: { code: string; details?: { path: string; issue: string; purgeCount?: number }[] };
}

class Probe extends TenantRepository {
  async insertAudit(tx: TenantTransaction, occurredAt: Date, count: number): Promise<void> {
    const rows = Array.from({ length: count }, () => ({
      occurred_at: occurredAt,
      actor_kind: 'system' as const,
      action: 'seed.entry',
      resource_type: 'test',
    }));
    await this.insertInto(tx, 'audit_logs', rows).execute();
  }

  async seedCount(tx: TenantTransaction): Promise<number> {
    const rows = await this.selectFrom(tx, 'audit_logs').select('audit_logs.id').where('audit_logs.action', '=', 'seed.entry').execute();
    return rows.length;
  }

  async byAction(tx: TenantTransaction, action: string) {
    return this.selectFrom(tx, 'audit_logs').select(['details', 'actor_kind']).where('audit_logs.action', '=', action).execute();
  }
}

async function probe<T>(tenant: TestTenant, fn: (repo: Probe, tx: TenantTransaction) => Promise<T>): Promise<T> {
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'audit-retention-test' });
  return (await service(UnitOfWork)).withTenant(ctx, (tx) => fn(new Probe(ctx), tx));
}

async function seedAudit(tenant: TestTenant, ageMs: number, count = 1): Promise<void> {
  const { clock } = await getTestApp();
  await probe(tenant, (repo, tx) => repo.insertAudit(tx, new Date(clock.now().getTime() - ageMs), count));
}

async function setup(): Promise<{ tenant: TestTenant; admin: TestUser }> {
  const tenant = await createTenant();
  return { tenant, admin: await createUser(tenant, { roles: ['admin'] }) };
}

beforeAll(async () => {
  await getTestApp();
});

describe('shortening auditRetention', () => {
  it('needs the entry count, rejects a stale one with the fresh count, then saves once it matches', async () => {
    const { tenant, admin } = await setup();
    await seedAudit(tenant, 3 * YEAR_MS, 2);

    const first = await asUser(admin).patch('/settings', { auditRetention: 'P1Y' });
    expect(first.status).toBe(409);
    expect((first.body as Failure).error.code).toBe('AUDIT_RETENTION_CONFIRMATION_REQUIRED');
    expect((first.body as Failure).error.details).toEqual([{ path: 'confirmAuditPurgeCount', issue: 'confirmation_required', purgeCount: 2 }]);
    expect((await asUser(admin).get('/settings')).body).toMatchObject({ auditRetention: 'forever' });

    // Another entry is older than the cutoff by the time the admin confirms.
    await seedAudit(tenant, 2 * YEAR_MS);
    const stale = await asUser(admin).patch('/settings', { auditRetention: 'P1Y', confirmAuditPurgeCount: 2 });
    expect(stale.status).toBe(409);
    expect((stale.body as Failure).error.code).toBe('AUDIT_RETENTION_CONFIRMATION_REQUIRED');
    expect((stale.body as Failure).error.details).toEqual([{ path: 'confirmAuditPurgeCount', issue: 'confirmation_required', purgeCount: 3 }]);
    expect((await asUser(admin).get('/settings')).body).toMatchObject({ auditRetention: 'forever' });

    const confirmed = await asUser(admin).patch('/settings', { auditRetention: 'P1Y', confirmAuditPurgeCount: 3 });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ auditRetention: 'P1Y' });
    expect(confirmed.body).not.toHaveProperty('confirmAuditPurgeCount');
  });

  it('needs no confirmation when no entry is older than the new cutoff (N = 0)', async () => {
    const { tenant, admin } = await setup();
    await seedAudit(tenant, 30 * 24 * 3_600_000);

    const shortened = await asUser(admin).patch('/settings', { auditRetention: 'P1Y' });
    expect(shortened.status).toBe(200);
    expect(shortened.body).toMatchObject({ auditRetention: 'P1Y' });
  });

  it('needs no confirmation when lengthening, even with entries older than the old period', async () => {
    const { tenant, admin } = await setup();
    expect((await asUser(admin).patch('/settings', { auditRetention: 'P2Y' })).status).toBe(200);
    await seedAudit(tenant, 3 * YEAR_MS);

    const longer = await asUser(admin).patch('/settings', { auditRetention: 'P7Y' });
    expect(longer.status).toBe(200);
    expect(longer.body).toMatchObject({ auditRetention: 'P7Y' });
    const forever = await asUser(admin).patch('/settings', { auditRetention: 'forever' });
    expect(forever.status).toBe(200);
    expect(await probe(tenant, (repo, tx) => repo.seedCount(tx))).toBe(1);
  });

  it('counts only its own tenant entries', async () => {
    const a = await setup();
    const b = await setup();
    await seedAudit(b.tenant, 3 * YEAR_MS, 5);

    expect((await asUser(a.admin).patch('/settings', { auditRetention: 'P1Y' })).status).toBe(200);
    const other = await asUser(b.admin).patch('/settings', { auditRetention: 'P1Y' });
    expect(other.status).toBe(409);
    expect((other.body as Failure).error.details?.[0]?.purgeCount).toBe(5);
  });

  it('checks the ticket confirmation first when both periods shorten, then the audit one', async () => {
    const { tenant, admin } = await setup();
    const customer = await createUser(tenant, { roles: ['customer'] });
    const { clock } = await getTestApp();
    await createTicket(tenant, { customer, state: 'closed', now: new Date(clock.now().getTime() - 3 * YEAR_MS) });
    await seedAudit(tenant, 3 * YEAR_MS, 4);
    const both = { retentionPeriod: 'P1Y', auditRetention: 'P1Y' };

    const first = await asUser(admin).patch('/settings', both);
    expect(first.status).toBe(409);
    expect((first.body as Failure).error.code).toBe('RETENTION_CONFIRMATION_REQUIRED');
    expect((first.body as Failure).error.details).toEqual([{ path: 'confirmPurgeCount', issue: 'confirmation_required', purgeCount: 1 }]);

    const second = await asUser(admin).patch('/settings', { ...both, confirmPurgeCount: 1 });
    expect(second.status).toBe(409);
    expect((second.body as Failure).error.code).toBe('AUDIT_RETENTION_CONFIRMATION_REQUIRED');
    expect((second.body as Failure).error.details).toEqual([{ path: 'confirmAuditPurgeCount', issue: 'confirmation_required', purgeCount: 4 }]);
    // The 409 changed nothing, including the part that was already confirmed.
    expect((await asUser(admin).get('/settings')).body).toMatchObject({ retentionPeriod: 'forever', auditRetention: 'forever' });

    const done = await asUser(admin).patch('/settings', { ...both, confirmPurgeCount: 1, confirmAuditPurgeCount: 4 });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject(both);
  });

  it('rejects a negative, fractional or non-numeric confirmation with a validation error', async () => {
    const { admin } = await setup();
    for (const confirmAuditPurgeCount of [-1, 1.5, '2']) {
      const response = await asUser(admin).patch('/settings', { auditRetention: 'P1Y', confirmAuditPurgeCount });
      expect(response.status).toBe(400);
      expect((response.body as Failure).error.code).toBe('VALIDATION_FAILED');
    }
  });
});

describe('the audit retention job and the replyx_retention role', () => {
  const retentionDb = createDatabase(process.env.DATABASE_URL_RETENTION ?? '', 'retention');
  afterAll(() => retentionDb.destroy());

  async function jobWith(retention: UnitOfWork): Promise<AuditRetentionJob> {
    return new AuditRetentionJob(
      await service(UnitOfWork),
      retention,
      await service(AuditService),
      await service(Clock),
      await service(QueueRegistry),
      (await getTestApp()).app.get<Kysely<Database>>(PLATFORM_DB),
    );
  }

  it('records the entries deleted before a failure, with the partial count', async () => {
    const { tenant, admin } = await setup();
    expect((await asUser(admin).patch('/settings', { auditRetention: 'P1Y' })).status).toBe(200);
    // One more than a batch: the first batch is full, so the job goes on to a second one.
    await seedAudit(tenant, 3 * YEAR_MS, DELETE_BATCH_SIZE + 1);

    const real = new UnitOfWork(retentionDb);
    let calls = 0;
    const failingSecondBatch = {
      withTenant: (ctx: TenantContext, fn: (tx: TenantTransaction) => Promise<unknown>) => {
        calls += 1;
        return calls > 1 ? Promise.reject(new Error('connection lost')) : real.withTenant(ctx, fn);
      },
    } as unknown as UnitOfWork;
    const job = await jobWith(failingSecondBatch);

    await expect(job.purgeTenant(failingSecondBatch, tenant.id)).rejects.toThrow('connection lost');
    expect(calls).toBe(2);
    expect(await probe(tenant, (repo, tx) => repo.seedCount(tx))).toBe(1);

    const purged = await probe(tenant, (repo, tx) => repo.byAction(tx, 'audit_log.purged'));
    expect(purged).toHaveLength(1);
    expect(purged[0]?.actor_kind).toBe('system');
    expect(purged[0]?.details).toMatchObject({ auditRetention: 'P1Y', entryCount: DELETE_BATCH_SIZE });
  }, 60_000);

  it('writes no purge entry when the first batch already fails', async () => {
    const { tenant, admin } = await setup();
    expect((await asUser(admin).patch('/settings', { auditRetention: 'P1Y' })).status).toBe(200);
    await seedAudit(tenant, 3 * YEAR_MS, 2);
    const broken = { withTenant: () => Promise.reject(new Error('connection lost')) } as unknown as UnitOfWork;
    const job = await jobWith(broken);

    await expect(job.purgeTenant(broken, tenant.id)).rejects.toThrow('connection lost');
    expect(await probe(tenant, (repo, tx) => repo.byAction(tx, 'audit_log.purged'))).toHaveLength(0);
    expect(await probe(tenant, (repo, tx) => repo.seedCount(tx))).toBe(2);
  });

  it('cannot SELECT, UPDATE or DELETE on tickets or other tables, nor UPDATE audit_logs', async () => {
    const denied = /permission denied for table/;
    await expect(sql`SELECT id FROM tickets LIMIT 1`.execute(retentionDb)).rejects.toThrow(denied);
    await expect(sql`UPDATE tickets SET title = 'x'`.execute(retentionDb)).rejects.toThrow(denied);
    await expect(sql`DELETE FROM tickets`.execute(retentionDb)).rejects.toThrow(denied);
    await expect(sql`SELECT tenant_id FROM tenant_settings LIMIT 1`.execute(retentionDb)).rejects.toThrow(denied);
    await expect(sql`UPDATE audit_logs SET action = 'x.y'`.execute(retentionDb)).rejects.toThrow(denied);
  });
});
