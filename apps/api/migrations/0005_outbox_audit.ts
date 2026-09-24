import { sql, type Kysely } from 'kysely';

/**
 * Outbox, consumer idempotency and audit (data-model.md, research D7, D12).
 *
 * `outbox_events`: services append inside their tenant transaction (app role, RLS WITH CHECK
 * keeps the tenant honest). The relay (worker, T035) reads every tenant's rows as
 * `replyx_platform` through a second policy scoped to that role, assigns `seq`, sets
 * `published_at` and prunes rows published more than 7 days ago.
 *
 * `audit_logs` is append-only for the app role: INSERT and SELECT only.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE outbox_events (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      type text NOT NULL,
      actor jsonb NOT NULL,
      payload jsonb NOT NULL,
      customer_payload jsonb,
      streams text[] NOT NULL,
      cause jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      seq bigint,
      published_at timestamptz,
      CONSTRAINT outbox_events_type_format CHECK (type ~ '^[a-z][a-z_]*(\\.[a-z][a-z_]*)+$'),
      CONSTRAINT outbox_events_streams_not_empty CHECK (cardinality(streams) > 0),
      CONSTRAINT outbox_events_published_has_seq CHECK (published_at IS NULL OR seq IS NOT NULL)
    )
  `.execute(db);
  // Relay scan: unpublished rows in id order.
  await sql`CREATE INDEX outbox_events_unpublished ON outbox_events (id) WHERE published_at IS NULL`.execute(db);
  await sql`CREATE UNIQUE INDEX outbox_events_seq ON outbox_events (seq)`.execute(db);
  await sql`CREATE INDEX outbox_events_streams ON outbox_events USING gin (streams)`.execute(db);
  await sql`CREATE INDEX outbox_events_published_at ON outbox_events (published_at)`.execute(db);
  // One wake-up per inserting statement; delivered to LISTEN outbox_new at commit.
  await sql`
    CREATE FUNCTION outbox_notify() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      PERFORM pg_notify('outbox_new', '');
      RETURN NULL;
    END
    $$
  `.execute(db);
  await sql`
    CREATE TRIGGER outbox_events_notify AFTER INSERT ON outbox_events
    FOR EACH STATEMENT EXECUTE FUNCTION outbox_notify()
  `.execute(db);
  await sql`SELECT enable_tenant_rls('outbox_events')`.execute(db);
  await sql`
    CREATE POLICY relay_all_tenants ON outbox_events TO replyx_platform
    USING (true) WITH CHECK (true)
  `.execute(db);
  await sql`SELECT grant_app_dml('outbox_events', ARRAY['SELECT', 'INSERT'])`.execute(db);
  await sql`SELECT grant_platform_dml('outbox_events', ARRAY['SELECT', 'UPDATE', 'DELETE'])`.execute(db);

  await sql`
    CREATE TABLE processed_events (
      consumer text NOT NULL,
      event_id uuid NOT NULL,
      processed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (consumer, event_id)
    )
  `.execute(db);
  await sql`CREATE INDEX processed_events_processed_at ON processed_events (processed_at)`.execute(db);
  await sql`SELECT grant_app_dml('processed_events', ARRAY['SELECT', 'INSERT'])`.execute(db);
  await sql`SELECT grant_platform_dml('processed_events', ARRAY['SELECT', 'DELETE'])`.execute(db);

  await sql`
    CREATE TABLE audit_logs (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      occurred_at timestamptz NOT NULL DEFAULT now(),
      actor_id uuid,
      actor_kind text NOT NULL,
      action text NOT NULL,
      resource_type text NOT NULL,
      resource_id uuid,
      details jsonb NOT NULL DEFAULT '{}'::jsonb,
      ip inet,
      request_id text,
      CONSTRAINT audit_logs_actor_kind CHECK (actor_kind IN ('user', 'operator', 'system', 'automation')),
      CONSTRAINT audit_logs_actor_id CHECK ((actor_kind = 'system') = (actor_id IS NULL)),
      CONSTRAINT audit_logs_action_format CHECK (action ~ '^[a-z][a-z_]*(\\.[a-z][a-z_]*)+$'),
      CONSTRAINT audit_logs_details CHECK (jsonb_typeof(details) = 'object')
    )
  `.execute(db);
  await sql`CREATE INDEX audit_logs_tenant_occurred ON audit_logs (tenant_id, occurred_at DESC)`.execute(db);
  await sql`CREATE INDEX audit_logs_tenant_actor ON audit_logs (tenant_id, actor_id)`.execute(db);
  await sql`
    CREATE INDEX audit_logs_tenant_resource ON audit_logs (tenant_id, resource_type, resource_id)
  `.execute(db);
  await sql`SELECT enable_tenant_rls('audit_logs')`.execute(db);
  await sql`SELECT grant_app_dml('audit_logs', ARRAY['SELECT', 'INSERT'])`.execute(db);
  // Explicit, so a later blanket grant can't make the log mutable by accident.
  await sql`REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM replyx_app`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE audit_logs`.execute(db);
  await sql`DROP TABLE processed_events`.execute(db);
  await sql`DROP TABLE outbox_events`.execute(db);
  await sql`DROP FUNCTION outbox_notify()`.execute(db);
}
