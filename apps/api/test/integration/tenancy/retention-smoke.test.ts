import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditService } from '../../../src/audit/audit.service.js';
import { Clock } from '../../../src/platform-kernel/clock.js';
import { createDatabase, PLATFORM_DB, type Database } from '../../../src/platform-kernel/db/database.js';
import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { QueueRegistry } from '../../../src/platform-kernel/jobs/queues.js';
import { AuditRetentionJob } from '../../../src/tenancy/retention/audit-retention.job.js';
import { RetentionService } from '../../../src/tenancy/retention/retention.service.js';
import { getTestApp, service } from '../../support/app.js';
import { createTenant, createTicket, createUser, type TestTenant } from '../../support/factories.js';
import { asUser } from '../../support/http.js';

import type { Kysely } from 'kysely';

/**
 * Smoke test for T193 (src/tenancy/retention/): the `confirmPurgeCount` flow of `PATCH /settings`
 * and one purge run. The full suite (files, tombstone links, customer after purge) is T196.
 */

const YEAR_MS = 365 * 24 * 3_600_000;

interface Failure {
  error: { code: string; details?: { path: string; issue: string; purgeCount?: number }[] };
}

class Probe extends TenantRepository {
  async ticketIds(tx: TenantTransaction): Promise<string[]> {
    const rows = await this.selectFrom(tx, 'tickets').select('tickets.id').execute();
    return rows.map((row) => row.id);
  }

  async messageCount(tx: TenantTransaction): Promise<number> {
    const rows = await this.selectFrom(tx, 'ticket_messages').select('ticket_messages.id').execute();
    return rows.length;
  }

  async insertAudit(tx: TenantTransaction, occurredAt: Date, action: string): Promise<void> {
    await this.insertInto(tx, 'audit_logs', { occurred_at: occurredAt, actor_kind: 'system', action, resource_type: 'test' }).execute();
  }

  async auditActions(tx: TenantTransaction): Promise<string[]> {
    const rows = await this.selectFrom(tx, 'audit_logs').select('action').where('action', 'like', 'seed.%').execute();
    return rows.map((row) => row.action).sort();
  }

  async auditByAction(tx: TenantTransaction, action: string) {
    return this.selectFrom(tx, 'audit_logs').select('details').where('action', '=', action).execute();
  }

  async purgeAudit(tx: TenantTransaction) {
    return this.selectFrom(tx, 'audit_logs')
      .select(['details', 'actor_kind'])
      .where('action', '=', 'retention.purged')
      .execute();
  }
}

async function probe<T>(tenant: TestTenant, fn: (repo: Probe, tx: TenantTransaction) => Promise<T>): Promise<T> {
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'retention-smoke' });
  return (await service(UnitOfWork)).withTenantReadOnly(ctx, (tx) => fn(new Probe(ctx), tx));
}

async function seed() {
  const tenant = await createTenant();
  const [admin, customer] = await Promise.all([createUser(tenant, { roles: ['admin'] }), createUser(tenant, { roles: ['customer'] })]);
  const { clock } = await getTestApp();
  const longAgo = new Date(clock.now().getTime() - 3 * YEAR_MS);
  const [oldA, oldB, oldOpen, recentClosed] = [
    await createTicket(tenant, { customer, state: 'closed', now: longAgo, messages: [{ body: 'first' }, { body: 'second' }] }),
    await createTicket(tenant, { customer, state: 'closed', now: longAgo, messages: [{ body: 'third' }] }),
    await createTicket(tenant, { customer, state: 'open', now: longAgo, messages: [{ body: 'still open' }] }),
    await createTicket(tenant, { customer, state: 'closed', messages: [{ body: 'recent' }] }),
  ];
  return { tenant, admin, oldA, oldB, oldOpen, recentClosed };
}

beforeAll(async () => {
  await getTestApp();
});

describe('shortening retentionPeriod', () => {
  it('needs the purge count, then saves once it matches', async () => {
    const { admin } = await seed();

    const first = await asUser(admin).patch('/settings', { retentionPeriod: 'P1Y' });
    expect(first.status).toBe(409);
    expect((first.body as Failure).error.code).toBe('RETENTION_CONFIRMATION_REQUIRED');
    expect((first.body as Failure).error.details).toEqual([{ path: 'confirmPurgeCount', issue: 'confirmation_required', purgeCount: 2 }]);
    expect((await asUser(admin).get('/settings')).body).toMatchObject({ retentionPeriod: 'forever' });

    const wrong = await asUser(admin).patch('/settings', { retentionPeriod: 'P1Y', confirmPurgeCount: 1 });
    expect(wrong.status).toBe(409);
    expect((wrong.body as Failure).error.details?.[0]?.purgeCount).toBe(2);

    const confirmed = await asUser(admin).patch('/settings', { retentionPeriod: 'P1Y', confirmPurgeCount: 2 });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ retentionPeriod: 'P1Y', auditRetention: 'forever' });
  });

  it('does not ask again for a longer period, or for a first period with nothing to purge', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const first = await asUser(admin).patch('/settings', { retentionPeriod: 'P3Y' });
    expect(first.status).toBe(200);
    const longer = await asUser(admin).patch('/settings', { retentionPeriod: 'P5Y', auditRetention: 'P2Y' });
    expect(longer.status).toBe(200);
    expect(longer.body).toMatchObject({ retentionPeriod: 'P5Y', auditRetention: 'P2Y' });
  });

  it('rejects values outside the allowed periods', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    for (const body of [{ retentionPeriod: 'P8Y' }, { retentionPeriod: 'P6M' }, { auditRetention: 'P4Y' }, { confirmPurgeCount: -1 }]) {
      const response = await asUser(admin).patch('/settings', body);
      expect(response.status).toBe(400);
      expect((response.body as Failure).error.code).toBe('VALIDATION_FAILED');
    }
  });
});

describe('the daily purge', () => {
  it('deletes only closed tickets past the period, with their messages, and records counts only', async () => {
    const { tenant, admin, oldA, oldB, oldOpen, recentClosed } = await seed();
    expect((await asUser(admin).patch('/settings', { retentionPeriod: 'P1Y', confirmPurgeCount: 2 })).status).toBe(200);

    const counts = await (await service(RetentionService)).purgeTenant(tenant.id);
    expect(counts).toMatchObject({ tickets: 2, messages: 3 });

    const remaining = await probe(tenant, (repo, tx) => repo.ticketIds(tx));
    expect(remaining.sort()).toEqual([oldOpen.id, recentClosed.id].sort());
    expect(remaining).not.toContain(oldA.id);
    expect(remaining).not.toContain(oldB.id);
    expect(await probe(tenant, (repo, tx) => repo.messageCount(tx))).toBe(2);

    const entries = await probe(tenant, (repo, tx) => repo.purgeAudit(tx));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actor_kind).toBe('system');
    expect(JSON.stringify(entries[0]?.details)).not.toMatch(/first|second|third/);
    expect(entries[0]?.details).toMatchObject({ retentionPeriod: 'P1Y', ticketCount: 2, messageCount: 3 });
  });

  it('does nothing while the period is forever', async () => {
    const { tenant } = await seed();
    expect(await (await service(RetentionService)).purgeTenant(tenant.id)).toMatchObject({ tickets: 0 });
    expect(await probe(tenant, (repo, tx) => repo.ticketIds(tx))).toHaveLength(4);
  });
});

describe('the audit retention job (replyx_retention role)', () => {
  const retentionDb = createDatabase(process.env.DATABASE_URL_RETENTION ?? '', 'retention');
  afterAll(() => retentionDb.destroy());

  async function seedAudit(tenant: TestTenant, now: Date): Promise<void> {
    const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'audit-seed' });
    await (await service(UnitOfWork)).withTenant(ctx, async (tx) => {
      const repo = new Probe(ctx);
      await repo.insertAudit(tx, new Date(now.getTime() - 3 * YEAR_MS), 'seed.old_a');
      await repo.insertAudit(tx, new Date(now.getTime() - 2 * YEAR_MS), 'seed.old_b');
      await repo.insertAudit(tx, new Date(now.getTime() - 30 * 24 * 3_600_000), 'seed.recent');
    });
  }

  it('deletes only the old entries of the tenant it runs for, and records counts only', async () => {
    const { clock } = await getTestApp();
    const [a, b, keeper] = [await createTenant(), await createTenant(), await createTenant()];
    const adminA = await createUser(a, { roles: ['admin'] });
    const adminB = await createUser(b, { roles: ['admin'] });
    for (const admin of [adminA, adminB]) {
      expect((await asUser(admin).patch('/settings', { auditRetention: 'P1Y' })).status).toBe(200);
    }
    await Promise.all([a, b, keeper].map((tenant) => seedAudit(tenant, clock.now())));

    const job = new AuditRetentionJob(
      await service(UnitOfWork),
      new UnitOfWork(retentionDb),
      await service(AuditService),
      await service(Clock),
      await service(QueueRegistry),
      (await getTestApp()).app.get<Kysely<Database>>(PLATFORM_DB),
    );
    expect(await job.purgeTenant(new UnitOfWork(retentionDb), a.id)).toBe(2);

    expect(await probe(a, (repo, tx) => repo.auditActions(tx))).toEqual(['seed.recent']);
    // Another tenant with the same retention, and one keeping everything, are untouched.
    expect(await probe(b, (repo, tx) => repo.auditActions(tx))).toEqual(['seed.old_a', 'seed.old_b', 'seed.recent']);
    expect(await probe(keeper, (repo, tx) => repo.auditActions(tx))).toEqual(['seed.old_a', 'seed.old_b', 'seed.recent']);

    const purged = await probe(a, (repo, tx) => repo.auditByAction(tx, 'audit_log.purged'));
    expect(purged).toHaveLength(1);
    expect(purged[0]?.details).toMatchObject({ auditRetention: 'P1Y', entryCount: 2 });

    // Nothing to delete the second time, and no second entry.
    expect(await job.purgeTenant(new UnitOfWork(retentionDb), a.id)).toBe(0);
    expect(await probe(a, (repo, tx) => repo.auditByAction(tx, 'audit_log.purged'))).toHaveLength(1);
    // A tenant whose retention is forever is skipped.
    expect(await job.purgeTenant(new UnitOfWork(retentionDb), keeper.id)).toBe(0);
  });
});
