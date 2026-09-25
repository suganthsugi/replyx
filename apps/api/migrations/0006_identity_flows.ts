import { sql, type Kysely } from 'kysely';

/**
 * Identity flows (data-model.md "Identity", FR-012): staff invitations, customer sign-in links,
 * password resets and customer profiles. All tenant-owned with forced RLS. Tokens are never
 * stored: only their SHA-256 hash (32 bytes), unique across tenants so a lookup by hash finds at
 * most one row.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // An invitation belongs to the `invited` user it activates (POST /users creates both).
  await sql`
    CREATE TABLE user_invitations (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      user_id uuid NOT NULL,
      email citext NOT NULL,
      role_ids uuid[] NOT NULL,
      invited_by uuid,
      token_hash bytea NOT NULL,
      expires_at timestamptz NOT NULL,
      accepted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT user_invitations_token_hash_key UNIQUE (token_hash),
      CONSTRAINT user_invitations_token_hash_length CHECK (octet_length(token_hash) = 32),
      CONSTRAINT user_invitations_role_ids CHECK (cardinality(role_ids) >= 1),
      CONSTRAINT user_invitations_user_fk FOREIGN KEY (tenant_id, user_id)
        REFERENCES users (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT user_invitations_invited_by_fk FOREIGN KEY (tenant_id, invited_by)
        REFERENCES users (tenant_id, id) ON DELETE SET NULL (invited_by)
    )
  `.execute(db);
  // One pending invitation per email: re-inviting replaces the pending row.
  await sql`
    CREATE UNIQUE INDEX user_invitations_pending_email ON user_invitations (tenant_id, email)
    WHERE accepted_at IS NULL
  `.execute(db);
  await sql`CREATE INDEX user_invitations_tenant_user ON user_invitations (tenant_id, user_id)`.execute(db);
  await sql`SELECT enable_tenant_rls('user_invitations')`.execute(db);
  await sql`SELECT grant_app_dml('user_invitations')`.execute(db);

  // A new link supersedes the user's older unused ones (FR-012).
  await sql`
    CREATE TABLE sign_in_links (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      user_id uuid NOT NULL,
      token_hash bytea NOT NULL,
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      superseded_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT sign_in_links_token_hash_key UNIQUE (token_hash),
      CONSTRAINT sign_in_links_token_hash_length CHECK (octet_length(token_hash) = 32),
      CONSTRAINT sign_in_links_user_fk FOREIGN KEY (tenant_id, user_id)
        REFERENCES users (tenant_id, id) ON DELETE CASCADE
    )
  `.execute(db);
  await sql`
    CREATE INDEX sign_in_links_open ON sign_in_links (tenant_id, user_id)
    WHERE used_at IS NULL AND superseded_at IS NULL
  `.execute(db);
  await sql`CREATE INDEX sign_in_links_tenant_expires ON sign_in_links (tenant_id, expires_at)`.execute(db);
  await sql`SELECT enable_tenant_rls('sign_in_links')`.execute(db);
  await sql`SELECT grant_app_dml('sign_in_links')`.execute(db);

  await sql`
    CREATE TABLE password_resets (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      user_id uuid NOT NULL,
      token_hash bytea NOT NULL,
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT password_resets_token_hash_key UNIQUE (token_hash),
      CONSTRAINT password_resets_token_hash_length CHECK (octet_length(token_hash) = 32),
      CONSTRAINT password_resets_user_fk FOREIGN KEY (tenant_id, user_id)
        REFERENCES users (tenant_id, id) ON DELETE CASCADE
    )
  `.execute(db);
  await sql`CREATE INDEX password_resets_tenant_user ON password_resets (tenant_id, user_id)`.execute(db);
  await sql`CREATE INDEX password_resets_tenant_expires ON password_resets (tenant_id, expires_at)`.execute(db);
  await sql`SELECT enable_tenant_rls('password_resets')`.execute(db);
  await sql`SELECT grant_app_dml('password_resets')`.execute(db);

  // Customers only (module: Customers); `notes` is staff-only and never in customer projections.
  await sql`
    CREATE TABLE customer_profiles (
      user_id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      phone text,
      company text,
      notes text,
      last_message_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT customer_profiles_tenant_id_user_id_key UNIQUE (tenant_id, user_id),
      CONSTRAINT customer_profiles_user_fk FOREIGN KEY (tenant_id, user_id)
        REFERENCES users (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT customer_profiles_phone_length CHECK (char_length(phone) <= 40),
      CONSTRAINT customer_profiles_company_length CHECK (char_length(company) <= 120),
      CONSTRAINT customer_profiles_notes_length CHECK (char_length(notes) <= 10000)
    )
  `.execute(db);
  await sql`
    CREATE TRIGGER customer_profiles_touch BEFORE UPDATE ON customer_profiles
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
  `.execute(db);
  await sql`SELECT enable_tenant_rls('customer_profiles')`.execute(db);
  await sql`SELECT grant_app_dml('customer_profiles')`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE customer_profiles`.execute(db);
  await sql`DROP TABLE password_resets`.execute(db);
  await sql`DROP TABLE sign_in_links`.execute(db);
  await sql`DROP TABLE user_invitations`.execute(db);
}
