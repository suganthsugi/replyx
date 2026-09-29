import { sql, type Kysely } from 'kysely';

/**
 * Audit-log retention role (T193, research D18, FR-005a). `audit_logs` is append-only for
 * `replyx_app` (0005), so entries past a tenant's `audit_retention` are deleted by a dedicated
 * role, `replyx_retention` (created by `infra/postgres/init.sql`). It gets SELECT and DELETE on
 * `audit_logs` and nothing else, not even a schema-wide default: without a grant a table is
 * unreachable to it. It stays under forced row-level security, so a delete only ever sees the
 * tenant set in `app.tenant_id`.
 *
 * `grant_dml` only knows the app and platform roles, so this migration grants directly (the one
 * exception, like the audit revokes in 0005).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Existing databases only get the role by rerunning init.sql (idempotent); fail with that hint
  // instead of an opaque "role does not exist".
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'replyx_retention') THEN
        RAISE EXCEPTION 'role replyx_retention is missing: rerun infra/postgres/init.sql (it is idempotent), then migrate again';
      END IF;
    END
    $$
  `.execute(db);
  await sql`GRANT SELECT, DELETE ON audit_logs TO replyx_retention`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`REVOKE SELECT, DELETE ON audit_logs FROM replyx_retention`.execute(db);
}
