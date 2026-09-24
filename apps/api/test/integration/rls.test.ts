import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditService } from '../../src/audit/audit.service.js';
import { createDatabase, type Database } from '../../src/platform-kernel/db/database.js';
import { TenantContext } from '../../src/platform-kernel/db/tenant-context.js';
import { UnitOfWork } from '../../src/platform-kernel/db/unit-of-work.js';
import { OutboxService } from '../../src/platform-kernel/outbox/outbox.service.js';
import { service } from '../support/app.js';
import { createGroup, createTenant, createUser, type TestTenant } from '../support/factories.js';

/**
 * Forced RLS on every tenant table (constitution I, research D3, testing-conventions rule 8),
 * driven by the catalogue: a new table with a `tenant_id` column is covered without editing this
 * file. Runs as `replyx_app`, the role the API and worker use.
 */

let db: Kysely<Database>;
let tenantTables: string[];
let a: TestTenant;
let b: TestTenant;

async function asTenant<T>(tenantId: string | undefined, fn: (tx: Kysely<Database>) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (tx) => {
    if (tenantId !== undefined) await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(tx);
    return fn(tx);
  });
}

beforeAll(async () => {
  db = createDatabase(process.env.DATABASE_URL_APP as string, 'app');
  const rows = await sql<{ table_name: string }>`
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name`.execute(db);
  tenantTables = rows.rows.map((row) => row.table_name);

  // Rows in as many tenant tables as exist today, for both tenants.
  [a, b] = await Promise.all([createTenant(), createTenant()]);
  for (const tenant of [a, b]) {
    await createGroup(tenant, { access: [{ role: 'agent', flags: { view: true } }] });
    await createUser(tenant, { roles: ['admin'] });
    const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'rls-test' });
    const [unitOfWork, audit] = await Promise.all([service(UnitOfWork), service(AuditService)]);
    await unitOfWork.withTenant(ctx, async (tx) => {
      await audit.record(tx, { action: 'test.seeded', resourceType: 'tenant', resourceId: tenant.id });
      await new OutboxService().append(tx, { type: 'access.changed', payload: { accessVersion: '0', reason: 'rls-test' }, streams: ['tenant'] });
    });
  }
});

afterAll(async () => {
  await db.destroy();
});

describe('row-level security', () => {
  it('finds the tenant tables', () => {
    expect(tenantTables).toEqual(expect.arrayContaining(['users', 'sessions', 'roles', 'groups', 'audit_logs', 'outbox_events']) as string[]);
    expect(tenantTables).not.toContain('tenants');
  });

  it('forces the tenant_isolation policy on every tenant table', async () => {
    const rows = await sql<{ table: string; enabled: boolean; forced: boolean; using: string | null; check: string | null }>`
      SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
             pg_get_expr(p.polqual, p.polrelid) AS using, pg_get_expr(p.polwithcheck, p.polrelid) AS check
      FROM pg_class c
      LEFT JOIN pg_policy p ON p.polrelid = c.oid AND p.polname = 'tenant_isolation'
      WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY(${tenantTables})`.execute(db);
    expect(rows.rows).toHaveLength(tenantTables.length);
    for (const row of rows.rows) {
      expect({ table: row.table, enabled: row.enabled, forced: row.forced }).toEqual({ table: row.table, enabled: true, forced: true });
      for (const expression of [row.using, row.check]) {
        expect(expression, `${row.table} policy`).toMatch(/tenant_id = \(NULLIF\(current_setting\('app\.tenant_id'::text, true\), ''::text\)\)::uuid/);
      }
    }
  });

  it('returns no rows without app.tenant_id and only the own tenant rows with it', async () => {
    for (const table of tenantTables) {
      const none = await asTenant(undefined, (tx) => sql<{ n: string }>`SELECT count(*)::text AS n FROM ${sql.table(table)}`.execute(tx));
      expect({ table, rows: none.rows[0]?.n }).toEqual({ table, rows: '0' });

      const seen = await asTenant(a.id, (tx) =>
        sql<{ tenant_id: string }>`SELECT DISTINCT tenant_id FROM ${sql.table(table)}`.execute(tx),
      );
      for (const row of seen.rows) expect({ table, tenant: row.tenant_id }).toEqual({ table, tenant: a.id });
    }
  });

  it("rejects inserting another tenant's tenant_id", async () => {
    let checked = 0;
    for (const table of tenantTables) {
      const hasRow = await asTenant(a.id, (tx) => sql<{ n: string }>`SELECT count(*)::text AS n FROM ${sql.table(table)}`.execute(tx));
      if (hasRow.rows[0]?.n === '0') continue;
      // Copy one of tenant A's rows, switch tenant_id to B (and give it a fresh id if it has one).
      const attempt = asTenant(a.id, (tx) =>
        sql`
          INSERT INTO ${sql.table(table)}
          SELECT (jsonb_populate_record(NULL::${sql.table(table)},
                   to_jsonb(r) || jsonb_build_object('tenant_id', ${b.id}::uuid)
                   || CASE WHEN to_jsonb(r) ? 'id' THEN jsonb_build_object('id', gen_random_uuid()) ELSE '{}'::jsonb END)).*
          FROM (SELECT * FROM ${sql.table(table)} LIMIT 1) r`.execute(tx),
      );
      await expect(attempt, table).rejects.toThrow(/row-level security/);
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(8);
  });
});
