---
name: tenant-scoping
description: TenantContext, withTenant/withTenantReadOnly, TenantRepository, RLS migrations via enable_tenant_rls, DB roles. Use when writing API data access, migrations, jobs or reviewing tenancy.
---

# tenant-scoping

How tenant isolation (constitution I) is enforced in `apps/api`: scoped repositories first, forced
RLS second. Loaded by backend-agent, test-automator and reviewer.
Kernel code does not exist yet (T016/T017); examples are target shapes from
`specs/001-multi-tenant-helpdesk/` (research D2/D3, data-model.md "Conventions", tasks T016–T021).

## Rules

1. **Tenant comes from the host, never the client.** `req.tenant` is set by
   `platform-kernel/http/tenant-resolver.middleware.ts` (T024) from `Host`. Never read a tenant id
   from body, query, params, headers or a socket payload. Build `TenantContext` from `req.tenant.id`
   (HTTP) or the job payload's `tenantId` (jobs, which were enqueued from a context).
   Wrong: `withTenant({ tenantId: body.tenantId, ... }, fn)`

2. **`TenantContext` always has a `tenantId`.** Shape `{ tenantId, actor, requestId }`; the
   constructor/factory throws without `tenantId` (T016, `platform-kernel/db/tenant-context.ts`).
   Wrong: `const ctx = {} as TenantContext`

3. **Every query runs inside `withTenant` / `withTenantReadOnly`.** They open a transaction, run
   `SET LOCAL app.tenant_id` and `SET LOCAL app.request_id`, and hand `fn` a scoped `Transaction`.
   Use `withTenantReadOnly` (adds `SET TRANSACTION READ ONLY`) for pure reads and for operator
   support-access reads. Never use the raw Kysely instance from `database.ts` in a module.
   ```ts
   // target shape (tasks.md T016, platform-kernel/db/unit-of-work.ts)
   export async function withTenant<T>(ctx: TenantContext, fn: (tx: Transaction<DB>) => Promise<T>) {
     return appDb.transaction().execute(async (tx) => {
       await sql`SELECT set_config('app.tenant_id', ${ctx.tenantId}, true),
                        set_config('app.request_id', ${ctx.requestId}, true)`.execute(tx);
       return fn(tx);
     });
   }
   ```
   `set_config(..., true)` is `SET LOCAL` with bind parameters; never string-interpolate the id.
   Wrong: `await appDb.selectFrom('tickets').selectAll().execute()` (no context: RLS returns 0 rows)
   Wrong: `sql.raw(\`SET LOCAL app.tenant_id = '${id}'\`)`

4. **Repositories extend `TenantRepository`.** Its constructor requires a `TenantContext`; every
   query helper adds `tenant_id = :tenantId`, and every insert sets `tenant_id` from the context.
   RLS is the backstop, not the filter.
   ```ts
   // target shape (tasks.md T016, platform-kernel/db/tenant-repository.ts)
   export class GroupRepository extends TenantRepository {
     findById(tx: Transaction<DB>, id: string) {
       return this.scoped(tx, 'groups').where('id', '=', id).selectAll().executeTakeFirst();
     } // scoped() = tx.selectFrom(table).where('tenant_id', '=', this.ctx.tenantId)
   }
   ```
   Wrong: `tx.selectFrom('groups').where('id', '=', id)` (relies on RLS alone)
   Wrong: `insertInto('groups').values({ ...dto })` where `dto` may carry `tenant_id`

5. **Cross-tenant = missing.** Another tenant's id returns the same 404 `*_NOT_FOUND` as an
   unknown id (same code, message, timing path). Never 403, never "belongs to another tenant".
   Wrong: `if (row.tenantId !== ctx.tenantId) throw permissionDenied()`

6. **Every tenant-owned table**: `tenant_id uuid NOT NULL REFERENCES tenants(id)`, indexes lead
   with `tenant_id`, per-tenant uniqueness is `UNIQUE (tenant_id, ...)`, and FKs to other tenant
   tables are composite `(tenant_id, x_id) REFERENCES x (tenant_id, id)` (the parent needs
   `UNIQUE (tenant_id, id)`). Then call `enable_tenant_rls` and the GRANT helper.
   ```ts
   // target shape (tasks.md T017/T020, apps/api/migrations/0004_authorization.ts)
   await sql`CREATE TABLE groups (
     id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
     name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
     UNIQUE (tenant_id, id))`.execute(db);
   await sql`CREATE UNIQUE INDEX groups_tenant_name ON groups (tenant_id, lower(name))`.execute(db);
   await sql`CREATE TABLE role_group_access (
     tenant_id uuid NOT NULL REFERENCES tenants(id), role_id uuid NOT NULL, group_id uuid,
     FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id),
     FOREIGN KEY (tenant_id, group_id) REFERENCES groups (tenant_id, id))`.execute(db);
   await sql`SELECT enable_tenant_rls('groups'), enable_tenant_rls('role_group_access')`.execute(db);
   ```
   Wrong: `role_id uuid REFERENCES roles(id)` (can point at another tenant's role)
   Wrong: a new tenant table without `enable_tenant_rls`

7. **RLS policy text** (inside `enable_tenant_rls`, migration `0001_helpers.ts`): `ENABLE` +
   `FORCE ROW LEVEL SECURITY`, one policy `tenant_isolation` with the same expression in `USING`
   and `WITH CHECK`:
   ```sql
   -- target shape (tasks.md T017)
   CREATE POLICY tenant_isolation ON <table>
     USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
     WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
   ```
   `NULLIF(..., '')` matters: after a `SET LOCAL` ends, the setting reads as `''` on a pooled
   connection and `''::uuid` throws; with `NULLIF` a missing context matches no rows.
   Wrong: `current_setting('app.tenant_id')::uuid` (no `true`, no `NULLIF`)
   Wrong: a per-table hand-written policy, or `DISABLE ROW LEVEL SECURITY` anywhere

8. **Database roles** (real: `infra/postgres/init.sql`):
   - `replyx_owner` owns the schema and runs migrations only (`DATABASE_URL_OWNER`). No BYPASSRLS;
     `FORCE` makes the policies apply to it too, so data backfills in migrations must set
     `app.tenant_id` per tenant.
   - `replyx_app` is the API/worker role (`DATABASE_URL_APP`): NOBYPASSRLS, no CREATE, DML only
     via per-table GRANT helpers in migrations. No default privileges exist, so every new table
     needs an explicit grant. Revoke what the table must not allow (e.g.
     `REVOKE UPDATE, DELETE ON audit_logs FROM replyx_app`, T021).
   - `replyx_platform` (`DATABASE_URL_PLATFORM`) gets DML on global tables only: `tenants`,
     `platform_operators`, `permission_definitions`. Never grant it a tenant-owned table.
   Wrong: `GRANT ALL ON ALL TABLES IN SCHEMA public TO replyx_app`
   Wrong: `ALTER ROLE replyx_app BYPASSRLS` or connecting the API as `replyx_owner`

9. **Global tables** have no `tenant_id` RLS and are read through the platform pool or dedicated
   kernel services (tenant resolver, registry), never through a `TenantRepository`.

10. **Every access path carries a context**: HTTP, sockets, jobs (payload has `tenantId`, the
    handler opens `withTenant`), search, attachments, exports, webhooks. Cache keys include the
    tenant (`access:{tenantId}:{accessVersion}:{userId}`, T030).
    Wrong: Redis key `user:${userId}:access`

## Checklist (before reporting done)
- [ ] No `tenantId` read from request body/query/params/headers/socket payload
- [ ] All DB access goes through `withTenant`/`withTenantReadOnly` and a `TenantRepository` subclass
- [ ] New tenant table: `tenant_id NOT NULL`, `UNIQUE (tenant_id, id)`, indexes lead with `tenant_id`,
      composite FKs, `enable_tenant_rls(...)`, explicit `replyx_app` GRANT
- [ ] Policy uses `NULLIF(current_setting('app.tenant_id', true), '')::uuid`
- [ ] No grant of tenant tables to `replyx_platform`; no BYPASSRLS; API never uses the owner URL
- [ ] Other tenant's id returns the same 404 as a missing id; cross-tenant test exists
      (constitution: every new tenant-scoped resource ships cross-tenant isolation tests)
- [ ] Job payloads and cache keys include `tenantId`
