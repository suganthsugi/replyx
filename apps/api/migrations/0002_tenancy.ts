import { sql, type Kysely } from 'kysely';

/**
 * Tenancy tables (data-model.md "Tenancy", research D2, D4).
 *
 * `tenants` is global (no RLS). `replyx_platform` manages it; `replyx_app` may read it, insert a
 * new tenant's identity columns (provisioning runs as one app transaction, T033) and bump
 * `access_version` (T032), but never change `status` (suspension is a platform action).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Shared by every table with `updated_at` (later migrations reuse it).
  await sql`
    CREATE FUNCTION touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END
    $$
  `.execute(db);

  await sql`
    CREATE TABLE tenants (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      slug text NOT NULL,
      name text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      access_version bigint NOT NULL DEFAULT 0,
      suspended_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT tenants_slug_key UNIQUE (slug),
      CONSTRAINT tenants_slug_format CHECK (
        char_length(slug) BETWEEN 3 AND 40
        AND slug ~ '^[a-z0-9](-?[a-z0-9])*$'
        AND slug NOT IN ('console', 'api', 'www', 'admin', 'static', 'internal', 'mail')
      ),
      CONSTRAINT tenants_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
      CONSTRAINT tenants_status CHECK (status IN ('active', 'suspended')),
      CONSTRAINT tenants_suspended_at CHECK ((status = 'suspended') = (suspended_at IS NOT NULL)),
      CONSTRAINT tenants_access_version CHECK (access_version >= 0)
    )
  `.execute(db);
  await sql`
    CREATE TRIGGER tenants_touch BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
  `.execute(db);
  await sql`SELECT grant_platform_dml('tenants')`.execute(db);
  await sql`GRANT SELECT ON tenants TO replyx_app`.execute(db);
  await sql`GRANT INSERT (id, slug, name) ON tenants TO replyx_app`.execute(db);
  await sql`GRANT UPDATE (access_version, updated_at) ON tenants TO replyx_app`.execute(db);

  await sql`
    CREATE TABLE tenant_settings (
      tenant_id uuid PRIMARY KEY REFERENCES tenants (id),
      logo_attachment_id uuid,
      brand_colors jsonb NOT NULL DEFAULT '{}'::jsonb,
      welcome_message text,
      timezone text NOT NULL DEFAULT 'UTC',
      self_registration boolean NOT NULL DEFAULT true,
      grace_period_hours integer NOT NULL DEFAULT 72,
      after_close_behavior text NOT NULL DEFAULT 'new_follow_up',
      offline_customer_notification text NOT NULL DEFAULT 'email',
      out_of_hours_message text,
      retention_period text NOT NULL DEFAULT 'forever',
      audit_retention text NOT NULL DEFAULT 'forever',
      notification_defaults jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT tenant_settings_brand_colors CHECK (jsonb_typeof(brand_colors) = 'object'),
      CONSTRAINT tenant_settings_welcome_message CHECK (char_length(welcome_message) <= 500),
      CONSTRAINT tenant_settings_out_of_hours_message CHECK (char_length(out_of_hours_message) <= 500),
      CONSTRAINT tenant_settings_grace_period CHECK (grace_period_hours BETWEEN 1 AND 720),
      CONSTRAINT tenant_settings_after_close CHECK (
        after_close_behavior IN ('new_follow_up', 'reopen_previous')
      ),
      CONSTRAINT tenant_settings_offline_notification CHECK (
        offline_customer_notification IN ('email', 'off')
      ),
      -- FR-005a: forever, or 1 to 7 years.
      CONSTRAINT tenant_settings_retention_period CHECK (
        retention_period = 'forever' OR retention_period ~ '^P[1-7]Y$'
      ),
      -- Audit log: forever, or at least one year.
      CONSTRAINT tenant_settings_audit_retention CHECK (
        audit_retention = 'forever' OR audit_retention ~ '^P[1-9][0-9]*Y$'
      ),
      CONSTRAINT tenant_settings_notification_defaults CHECK (
        jsonb_typeof(notification_defaults) = 'object'
      )
    )
  `.execute(db);
  await sql`
    CREATE TRIGGER tenant_settings_touch BEFORE UPDATE ON tenant_settings
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
  `.execute(db);
  await sql`SELECT enable_tenant_rls('tenant_settings')`.execute(db);
  await sql`SELECT grant_app_dml('tenant_settings', ARRAY['SELECT', 'INSERT', 'UPDATE'])`.execute(db);

  // Per-tenant gap-free counters, e.g. `ticket_number` (research D4): UPDATE ... RETURNING value.
  await sql`
    CREATE TABLE tenant_counters (
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      name text NOT NULL,
      value bigint NOT NULL,
      PRIMARY KEY (tenant_id, name)
    )
  `.execute(db);
  await sql`SELECT enable_tenant_rls('tenant_counters')`.execute(db);
  await sql`SELECT grant_app_dml('tenant_counters', ARRAY['SELECT', 'INSERT', 'UPDATE'])`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE tenant_counters`.execute(db);
  await sql`DROP TABLE tenant_settings`.execute(db);
  await sql`DROP TABLE tenants`.execute(db);
  await sql`DROP FUNCTION touch_updated_at()`.execute(db);
}
