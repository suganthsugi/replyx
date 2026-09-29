import { sql, type Kysely } from 'kysely';

/**
 * `PATCH /settings` (T183, contracts/operations.yaml `/settings`, `tenant_settings.edit`) needs to
 * rename the tenant, but `tenants` (0002_tenancy) only ever granted `replyx_app` an UPDATE on
 * `(access_version, updated_at)`. `tenant_settings` itself already has a full `grant_app_dml`
 * `UPDATE`, so its columns (brand colors, welcome message, timezone, ...) need no new grant.
 *
 * `tenants` has no `tenant_id` column (its own `id` is the tenant), so it cannot take the usual
 * `enable_tenant_rls` policy, and it is read in places (the host resolver, `access_version`
 * bumps, provisioning inserts) that run as `replyx_app` without `app.tenant_id` set yet, or as
 * `replyx_platform` for platform operator routes (`PATCH /platform/tenants/:id`) which never set
 * it at all — a blanket RLS policy on `id` would break both. Instead this is a narrow BEFORE
 * UPDATE trigger that only looks at `replyx_app` connections (`current_user`) changing `name`: it
 * requires the row's `id` to equal the caller's own `app.tenant_id`, the same expression
 * `enable_tenant_rls` uses elsewhere. `replyx_owner` (migrations, backfills) and `replyx_platform`
 * (the operator's own tenant rename) are untouched.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`GRANT UPDATE (name) ON tenants TO replyx_app`.execute(db);

  await sql`
    CREATE FUNCTION tenants_guard_name_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF current_user = 'replyx_app' AND NEW.name IS DISTINCT FROM OLD.name THEN
        IF NEW.id IS DISTINCT FROM NULLIF(current_setting('app.tenant_id', true), '')::uuid THEN
          RAISE EXCEPTION 'tenants: cannot rename another tenant' USING ERRCODE = '42501';
        END IF;
      END IF;
      RETURN NEW;
    END
    $$
  `.execute(db);
  await sql`
    CREATE TRIGGER tenants_guard_name BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION tenants_guard_name_change()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER tenants_guard_name ON tenants`.execute(db);
  await sql`DROP FUNCTION tenants_guard_name_change()`.execute(db);
  await sql`REVOKE UPDATE (name) ON tenants FROM replyx_app`.execute(db);
}
