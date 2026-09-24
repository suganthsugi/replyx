import { sql, type Kysely } from 'kysely';

/**
 * Identity tables (data-model.md "Identity", research D5).
 *
 * Operators and their sessions are global (console host, no tenant) and belong to
 * `replyx_platform` only. Users and sessions are tenant-owned with forced RLS.
 * Tokens are never stored: only their SHA-256 hash.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE platform_operators (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      email citext NOT NULL,
      name text NOT NULL,
      password_hash text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      last_sign_in_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT platform_operators_email_key UNIQUE (email),
      CONSTRAINT platform_operators_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
      CONSTRAINT platform_operators_status CHECK (status IN ('active', 'deactivated'))
    )
  `.execute(db);
  await sql`
    CREATE TRIGGER platform_operators_touch BEFORE UPDATE ON platform_operators
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
  `.execute(db);
  await sql`SELECT grant_platform_dml('platform_operators')`.execute(db);

  await sql`
    CREATE TABLE operator_sessions (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      operator_id uuid NOT NULL REFERENCES platform_operators (id) ON DELETE CASCADE,
      token_hash bytea NOT NULL,
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      ip inet,
      user_agent text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT operator_sessions_token_hash_key UNIQUE (token_hash),
      CONSTRAINT operator_sessions_token_hash_length CHECK (octet_length(token_hash) = 32)
    )
  `.execute(db);
  await sql`CREATE INDEX operator_sessions_operator ON operator_sessions (operator_id)`.execute(db);
  await sql`CREATE INDEX operator_sessions_expires ON operator_sessions (expires_at)`.execute(db);
  await sql`SELECT grant_platform_dml('operator_sessions')`.execute(db);

  await sql`
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      email citext NOT NULL,
      name text NOT NULL,
      avatar_attachment_id uuid,
      password_hash text,
      status text NOT NULL DEFAULT 'invited',
      kind text NOT NULL,
      availability text NOT NULL DEFAULT 'offline',
      time_display jsonb NOT NULL DEFAULT '{}'::jsonb,
      failed_sign_ins integer NOT NULL DEFAULT 0,
      locked_until timestamptz,
      last_sign_in_at timestamptz,
      erased_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT users_tenant_id_id_key UNIQUE (tenant_id, id),
      CONSTRAINT users_tenant_id_email_key UNIQUE (tenant_id, email),
      CONSTRAINT users_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
      CONSTRAINT users_status CHECK (status IN ('invited', 'active', 'deactivated')),
      CONSTRAINT users_kind CHECK (kind IN ('staff', 'customer')),
      CONSTRAINT users_availability CHECK (availability IN ('online', 'away', 'offline')),
      CONSTRAINT users_time_display CHECK (jsonb_typeof(time_display) = 'object'),
      CONSTRAINT users_failed_sign_ins CHECK (failed_sign_ins >= 0)
    )
  `.execute(db);
  await sql`CREATE INDEX users_tenant_kind_status ON users (tenant_id, kind, status)`.execute(db);
  await sql`
    CREATE TRIGGER users_touch BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
  `.execute(db);
  await sql`SELECT enable_tenant_rls('users')`.execute(db);
  await sql`SELECT grant_app_dml('users')`.execute(db);

  await sql`
    CREATE TABLE sessions (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      user_id uuid NOT NULL,
      token_hash bytea NOT NULL,
      kind text NOT NULL,
      trusted_device boolean NOT NULL DEFAULT false,
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      ip inet,
      user_agent text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT sessions_token_hash_key UNIQUE (token_hash),
      CONSTRAINT sessions_token_hash_length CHECK (octet_length(token_hash) = 32),
      CONSTRAINT sessions_kind CHECK (kind IN ('staff', 'customer')),
      CONSTRAINT sessions_user_fk FOREIGN KEY (tenant_id, user_id)
        REFERENCES users (tenant_id, id) ON DELETE CASCADE
    )
  `.execute(db);
  await sql`CREATE INDEX sessions_tenant_user ON sessions (tenant_id, user_id)`.execute(db);
  await sql`CREATE INDEX sessions_tenant_expires ON sessions (tenant_id, expires_at)`.execute(db);
  await sql`SELECT enable_tenant_rls('sessions')`.execute(db);
  await sql`SELECT grant_app_dml('sessions')`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE sessions`.execute(db);
  await sql`DROP TABLE users`.execute(db);
  await sql`DROP TABLE operator_sessions`.execute(db);
  await sql`DROP TABLE platform_operators`.execute(db);
}
