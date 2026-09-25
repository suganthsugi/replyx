import { sql, type Kysely } from 'kysely';

/**
 * Support access (data-model.md "support_access_grants", FR-001a): a tenant admin lets platform
 * operators read the workspace for a bounded window. The grant is tenant-owned with forced RLS,
 * so an operator's support session is scoped by the same policy as everyone else's reads.
 *
 * An active grant is `revoked_at IS NULL AND now() BETWEEN starts_at AND expires_at`; the window
 * can never exceed 7 days, which the CHECK enforces rather than the service.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE support_access_grants (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      granted_by uuid NOT NULL,
      reason text,
      starts_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      revoked_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT support_access_grants_tenant_id_id_key UNIQUE (tenant_id, id),
      CONSTRAINT support_access_grants_granted_by_fk FOREIGN KEY (tenant_id, granted_by)
        REFERENCES users (tenant_id, id),
      CONSTRAINT support_access_grants_revoked_by_fk FOREIGN KEY (tenant_id, revoked_by)
        REFERENCES users (tenant_id, id) ON DELETE SET NULL (revoked_by),
      CONSTRAINT support_access_grants_reason_length CHECK (char_length(reason) <= 500),
      CONSTRAINT support_access_grants_window CHECK (expires_at > starts_at),
      CONSTRAINT support_access_grants_max_window CHECK (expires_at - starts_at <= interval '7 days')
    )
  `.execute(db);
  // The lookup every support request makes: the tenant's grants that have not been revoked yet.
  await sql`
    CREATE INDEX support_access_grants_active ON support_access_grants (tenant_id, expires_at)
    WHERE revoked_at IS NULL
  `.execute(db);
  await sql`CREATE INDEX support_access_grants_tenant_created ON support_access_grants (tenant_id, created_at DESC)`.execute(db);
  await sql`SELECT enable_tenant_rls('support_access_grants')`.execute(db);
  await sql`SELECT grant_app_dml('support_access_grants')`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE support_access_grants`.execute(db);
}
