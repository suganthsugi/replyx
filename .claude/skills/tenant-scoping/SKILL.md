---
name: tenant-scoping
description: TenantContext, UnitOfWork withTenant/withTenantReadOnly, TenantRepository, RLS migrations (enable_tenant_rls, grant_app_dml), DB roles. Use when writing API data access, migrations, jobs or reviewing tenancy.
---

# tenant-scoping

How tenant isolation (constitution I) is enforced in `apps/api`: scoped repositories first, forced
RLS second. Loaded by backend-agent, test-automator and reviewer. Kernel code lives in
`apps/api/src/platform-kernel/db/`; migrations in `apps/api/migrations/`.

## Rules

1. **Tenant comes from the host, never the client.** `tenant-resolver.middleware.ts` sets
   `req.tenant` (`{ id, slug, status }`) from `Host`; the console host sets no tenant. HTTP code builds
   its context with `tenantContextOf(req)` (`platform-kernel/http/request-context.ts`), which uses
   `req.tenant.id`, the session's user, pino's request id and `req.ip`. Jobs and sockets use the
   `tenantId` of the envelope/job they were given.
   Wrong: `TenantContext.create({ tenantId: body.tenantId, ... })`

2. **`TenantContext` is nominal and validated.** Build it only with `TenantContext.create({ tenantId,
   actor, requestId, ip? })`; it throws on a non-uuid tenant, empty `requestId`, or bad actor.
   `Actor` = `user|operator|automation` (with uuid `id`) or `{ kind: 'system' }`. An object literal
   is not a context (`TenantContext.isTenantContext` checks a private brand).
   ```ts
   // from apps/api/src/identity/session.service.ts
   function systemContext(tenantId: string, requestId: string): TenantContext {
     return TenantContext.create({ tenantId, actor: { kind: 'system' }, requestId });
   }
   ```
   Wrong: `const ctx = { tenantId, actor } as TenantContext`

3. **Every tenant query runs in `UnitOfWork.withTenant` / `withTenantReadOnly`.** Inject
   `UnitOfWork` (exported by the global `DatabaseModule`); it opens a `replyx_app` transaction, runs
   `set_config('app.tenant_id', …, true)` + `app.request_id` with bind parameters, and passes a
   `TenantTransaction`. Use `withTenantReadOnly` (`SET TRANSACTION READ ONLY`) for pure reads and
   operator support-access reads. `APP_DB` is kernel-internal; never inject it in a module.
   ```ts
   // from apps/api/src/identity/session.service.ts
   const ctx = systemContext(tenantId, 'session-lookup');
   const row = await this.unitOfWork.withTenantReadOnly(ctx, (tx) =>
     new SessionRepository(ctx).findByTokenHash(tx, tokenHash),
   );
   ```
   Wrong: `@Inject(APP_DB) db` then `db.selectFrom('tickets')` (no context: RLS returns 0 rows)
   Wrong: `sql.raw(\`SET LOCAL app.tenant_id = '${id}'\`)`

4. **Services that receive a `tx` take the context from it**, not from a parameter:
   `tenantScopeOf(tx)` (unit-of-work.ts) returns the context the transaction was opened with; wrap it
   in a local `requireScope(tx)` that throws when undefined (see `session.service.ts`,
   `lockout.service.ts`). Methods that write take `tx: TenantTransaction` so they join the caller's
   transaction (outbox and audit rows commit with the change).
   Wrong: `revoke(tenantId: string, sessionId: string)` that opens its own transaction mid-command

5. **Repositories extend `TenantRepository`** (`platform-kernel/db/tenant-repository.ts`), are built
   per context (`new XRepository(ctx)`, not Nest providers), and use only the protected helpers
   `selectFrom`/`updateTable`/`deleteFrom` (add `<table>.tenant_id = ctx.tenantId`) and `insertInto`
   (takes `TenantInsert<T>`, overwrites `tenant_id`). Each helper throws if `tx` was not opened by
   `withTenant*` or belongs to another tenant. Joins to other tenant tables match `tenant_id` too.
   ```ts
   // from apps/api/src/identity/session.repository.ts
   export class SessionRepository extends TenantRepository {
     findByTokenHash(tx: TenantTransaction, tokenHash: Buffer) {
       return this.selectFrom(tx, 'sessions')
         .innerJoin('users', (join) =>
           join.onRef('users.tenant_id', '=', 'sessions.tenant_id').onRef('users.id', '=', 'sessions.user_id'),
         )
         .select(['sessions.id', 'sessions.user_id', 'users.status as user_status'])
         .where('sessions.token_hash', '=', tokenHash)
         .executeTakeFirst();
     }
   }
   ```
   Wrong: `tx.selectFrom('groups').where('id', '=', id)` (bypasses the helper; relies on RLS alone)
   Wrong: `.innerJoin('users', 'users.id', 'sessions.user_id')` (join without `tenant_id`)

6. **Cross-tenant = missing.** Another tenant's id returns the same 404 `*_NOT_FOUND` as an unknown
   id (same code, message, code path). Never 403, never "belongs to another tenant".
   Wrong: `if (row.tenant_id !== ctx.tenantId) throw permissionDenied()`

7. **Every tenant-owned table** (migration file `apps/api/migrations/NNNN_<area>.ts`):
   `tenant_id uuid NOT NULL REFERENCES tenants (id)`, `id uuid PRIMARY KEY DEFAULT gen_uuid_v7()`,
   `UNIQUE (tenant_id, id)`, indexes and per-tenant uniqueness lead with `tenant_id`, FKs to tenant
   tables are composite, then `enable_tenant_rls` and `grant_app_dml` (default: all four DML verbs;
   pass an array to narrow it).
   ```ts
   // from apps/api/migrations/0004_authorization.ts (trimmed)
   CREATE TABLE groups (
     id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
     tenant_id uuid NOT NULL REFERENCES tenants (id),
     name text NOT NULL,
     CONSTRAINT groups_tenant_id_id_key UNIQUE (tenant_id, id))
   await sql`CREATE UNIQUE INDEX groups_tenant_name ON groups (tenant_id, lower(name))`.execute(db);
   await sql`SELECT enable_tenant_rls('groups')`.execute(db);
   await sql`SELECT grant_app_dml('groups')`.execute(db);
   // role_group_access: FOREIGN KEY (tenant_id, group_id) REFERENCES groups (tenant_id, id)
   ```
   Wrong: `role_id uuid REFERENCES roles (id)` (can point at another tenant's role)
   Wrong: a raw `GRANT ... TO replyx_app` on a tenant table (use `grant_app_dml`)

8. **The policy is created only by `enable_tenant_rls`** (migration `0001_helpers.ts`): `ENABLE` +
   `FORCE ROW LEVEL SECURITY` and one policy `tenant_isolation`, same expression in `USING` and
   `WITH CHECK`:
   ```sql
   tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
   ```
   `NULLIF` matters: on a pooled connection the setting reads `''` after an earlier `SET LOCAL`
   ended and `''::uuid` raises; with it a missing context matches no rows.
   `test/integration/rls.test.ts` finds tenant tables from `information_schema` (any `tenant_id`
   column) and asserts this exact expression, so a table without it fails CI.
   Wrong: `current_setting('app.tenant_id')::uuid`; a hand-written policy; `DISABLE ROW LEVEL SECURITY`

9. **Row types**: add each table's interface to `src/platform-kernel/db/tables/<area>.ts` and
   intersect the `<Area>Tables` map into `Database` (`database.ts`). Tenant tables declare
   `tenant_id: string` (that is what makes them a `TenantTableName`). Defaulted timestamps use
   `GeneratedTimestamp`, not `Generated<Timestamp>`; defaulted ids use `Generated<string>`. App-side
   ids come from `uuidv7()` in `platform-kernel/ids.ts`.

10. **Database roles** (`infra/postgres/init.sql`; no default privileges, so a table without a
    grant is unreachable):
    - `replyx_owner` runs migrations only. `FORCE` applies policies to it, so data backfills must
      set `app.tenant_id` per tenant.
    - `replyx_app` (API and worker, `DATABASE_URL_APP`): NOBYPASSRLS, DML only via
      `grant_app_dml`. Narrow grants where the table demands it: `audit_logs` is
      SELECT/INSERT plus `REVOKE UPDATE, DELETE, TRUNCATE` (0005); `tenants` is SELECT,
      `INSERT (id, slug, name)`, `UPDATE (access_version, updated_at)` (0002).
    - `replyx_platform` (`PLATFORM_DB`, `DATABASE_URL_PLATFORM`): global tables (`tenants`,
      `platform_operators`, `operator_sessions`, `permission_definitions`) via `grant_platform_dml`.
      The only tenant-table exceptions are `outbox_events` (SELECT/UPDATE/DELETE plus policy
      `relay_all_tenants TO replyx_platform`, for the relay and pruning) and `processed_events`
      (SELECT/DELETE). Any new exception needs a plan decision.
    Wrong: `GRANT ALL ON ALL TABLES IN SCHEMA public TO replyx_app`; `ALTER ROLE ... BYPASSRLS`

11. **Global tables** have no `tenant_id` and are read through `PLATFORM_DB` in kernel services
    (tenant resolver, registry sync, relay), never through a `TenantRepository`.

12. **Every access path carries the tenant**: HTTP, sockets, jobs (payload/envelope has
    `tenantId`; the handler gets a `TenantTransaction`), search, attachments, exports. Redis keys
    include it: `session:{tenant}:{hash}`, `lockout:{tenant}:{user}`,
    `access:{tenantId}:{accessVersion}:{userId}`.
    Wrong: Redis key `` `user:${userId}:access` ``

## Checklist (before reporting done)
- [ ] No tenant id read from body/query/params/headers/socket payload; HTTP uses `tenantContextOf(req)`
- [ ] All tenant DB access goes through `UnitOfWork.withTenant*` and a `TenantRepository` subclass helper
- [ ] Joins between tenant tables match `tenant_id`
- [ ] New tenant table: `tenant_id NOT NULL`, `UNIQUE (tenant_id, id)`, `gen_uuid_v7()` id, indexes lead
      with `tenant_id`, composite FKs, `enable_tenant_rls(...)`, `grant_app_dml(...)`, row type in `tables/`
- [ ] No tenant table granted to `replyx_platform` (outbox exceptions aside); no BYPASSRLS
- [ ] Other tenant's id returns the same 404 as a missing id; cross-tenant fixture added
      (see testing-conventions)
- [ ] Job payloads and Redis keys include the tenant id
