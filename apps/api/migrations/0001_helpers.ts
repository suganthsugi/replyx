import { sql, type Kysely } from 'kysely';

/**
 * Helpers every later migration uses (research D3, tenant-scoping skill):
 *
 * - `enable_tenant_rls(table)`: ENABLE + FORCE row-level security and the single
 *   `tenant_isolation` policy. `NULLIF(..., '')` matters: on a pooled connection the setting reads
 *   as '' after an earlier transaction's SET LOCAL ended, and `''::uuid` would raise instead of
 *   matching no rows.
 * - `grant_app_dml(table, privileges)` / `grant_platform_dml(table, privileges)`: the only way
 *   tables get privileges. init.sql defines no default privileges, so a table without a grant is
 *   unreachable for the runtime roles. `replyx_platform` gets global tables only.
 * - `gen_uuid_v7()`: time-ordered UUID default for primary keys (PostgreSQL 17 has no uuidv7()).
 *
 * All helpers run as `replyx_owner` inside migrations; the runtime roles cannot execute them.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE FUNCTION gen_uuid_v7() RETURNS uuid
    LANGUAGE sql VOLATILE PARALLEL SAFE
    AS $$
      -- 48-bit Unix milliseconds, then gen_random_uuid()'s random bits with version 7.
      SELECT encode(
        set_bit(
          set_bit(
            overlay(uuid_send(gen_random_uuid())
                    PLACING substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
                    FROM 1 FOR 6),
            52, 1),
          53, 1),
        'hex')::uuid
    $$
  `.execute(db);

  await sql`
    CREATE FUNCTION enable_tenant_rls(tbl regclass) RETURNS void
    LANGUAGE plpgsql
    AS $$
    BEGIN
      EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
      EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %s '
        || 'USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
        || 'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
        tbl);
    END
    $$
  `.execute(db);

  await sql`
    CREATE FUNCTION grant_dml(tbl regclass, grantee name, privileges text[]) RETURNS void
    LANGUAGE plpgsql
    AS $$
    DECLARE
      privilege text;
    BEGIN
      IF grantee NOT IN ('replyx_app', 'replyx_platform') THEN
        RAISE EXCEPTION 'grant_dml: unexpected grantee %', grantee;
      END IF;
      IF cardinality(privileges) = 0 THEN
        RAISE EXCEPTION 'grant_dml: no privileges given for %', tbl;
      END IF;
      FOREACH privilege IN ARRAY privileges LOOP
        IF upper(privilege) NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE') THEN
          RAISE EXCEPTION 'grant_dml: privilege % is not DML', privilege;
        END IF;
        EXECUTE format('GRANT %s ON %s TO %I', upper(privilege), tbl, grantee);
      END LOOP;
    END
    $$
  `.execute(db);

  await sql`
    CREATE FUNCTION grant_app_dml(
      tbl regclass,
      privileges text[] DEFAULT ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']
    ) RETURNS void
    LANGUAGE sql
    AS $$ SELECT grant_dml(tbl, 'replyx_app', privileges) $$
  `.execute(db);

  await sql`
    CREATE FUNCTION grant_platform_dml(
      tbl regclass,
      privileges text[] DEFAULT ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']
    ) RETURNS void
    LANGUAGE sql
    AS $$ SELECT grant_dml(tbl, 'replyx_platform', privileges) $$
  `.execute(db);

  // Functions are executable by PUBLIC by default; the migration helpers are for the owner only.
  // gen_uuid_v7() stays callable because column defaults run as the inserting role.
  await sql`
    REVOKE EXECUTE ON FUNCTION
      enable_tenant_rls(regclass),
      grant_dml(regclass, name, text[]),
      grant_app_dml(regclass, text[]),
      grant_platform_dml(regclass, text[])
    FROM PUBLIC
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION grant_platform_dml(regclass, text[])`.execute(db);
  await sql`DROP FUNCTION grant_app_dml(regclass, text[])`.execute(db);
  await sql`DROP FUNCTION grant_dml(regclass, name, text[])`.execute(db);
  await sql`DROP FUNCTION enable_tenant_rls(regclass)`.execute(db);
  await sql`DROP FUNCTION gen_uuid_v7()`.execute(db);
}
