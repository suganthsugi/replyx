import { sql, type Kysely } from 'kysely';

/**
 * Webhooks (T259, data-model.md "webhooks" and "webhook_deliveries", FR-090, FR-091, research
 * D16, spec US18; module: Integrations). Numbered 0022 because tasks.md's 0017 was taken by AI.
 *
 * - `webhooks`: an HTTPS endpoint (http only in development, checked by the service), its signing
 *   secret sealed with the secret box (`secret_encrypted`, never returned after create or rotate),
 *   the subscribed `events` and the on/off switch. At most 20 per workspace (service).
 * - `webhook_deliveries`: one row per attempt. Attempt 1 is written by the webhooks consumer when
 *   the event happens; each failed attempt sets `next_attempt_at` and writes the next attempt as
 *   `pending` with that time, up to 8 (the last failure is `gave_up`). `payload` is the exact body,
 *   so every attempt of an event sends the same bytes. `response_code`, `duration_ms` and `error`
 *   describe what happened; response bodies are not kept. Rows go with their webhook and are
 *   deleted after 30 days by the webhook retention job.
 */
const WEBHOOK_EVENTS = ['ticket.created', 'ticket.updated', 'message.created', 'ticket.assigned', 'ticket.closed'];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE webhooks (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      url text NOT NULL,
      secret_encrypted text NOT NULL,
      events text[] NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT webhooks_tenant_id_id_key UNIQUE (tenant_id, id),
      CONSTRAINT webhooks_created_by_fk FOREIGN KEY (tenant_id, created_by)
        REFERENCES users (tenant_id, id) ON DELETE SET NULL (created_by),
      CONSTRAINT webhooks_url_scheme CHECK (url ~ '^https?://'),
      CONSTRAINT webhooks_url_length CHECK (char_length(url) <= 2000),
      CONSTRAINT webhooks_events_known CHECK (
        cardinality(events) > 0 AND events <@ ARRAY[${sql.join(WEBHOOK_EVENTS.map((event) => sql.lit(event)))}]::text[]
      )
    )
  `.execute(db);
  await sql`
    CREATE TRIGGER webhooks_touch BEFORE UPDATE ON webhooks
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
  `.execute(db);
  await sql`SELECT enable_tenant_rls('webhooks')`.execute(db);
  await sql`SELECT grant_app_dml('webhooks')`.execute(db);

  await sql`
    CREATE TABLE webhook_deliveries (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      webhook_id uuid NOT NULL,
      event_id uuid NOT NULL,
      event_type text NOT NULL,
      attempt smallint NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      payload jsonb NOT NULL,
      response_code smallint,
      duration_ms integer,
      error text,
      next_attempt_at timestamptz,
      attempted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT webhook_deliveries_once UNIQUE (tenant_id, webhook_id, event_id, attempt),
      CONSTRAINT webhook_deliveries_webhook_fk FOREIGN KEY (tenant_id, webhook_id)
        REFERENCES webhooks (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT webhook_deliveries_attempt CHECK (attempt BETWEEN 1 AND 8),
      CONSTRAINT webhook_deliveries_status CHECK (status IN ('pending', 'succeeded', 'failed', 'gave_up')),
      CONSTRAINT webhook_deliveries_pending_due CHECK (status <> 'pending' OR next_attempt_at IS NOT NULL),
      CONSTRAINT webhook_deliveries_error_length CHECK (char_length(error) <= 500),
      CONSTRAINT webhook_deliveries_payload_object CHECK (jsonb_typeof(payload) = 'object')
    )
  `.execute(db);
  // An endpoint's history, newest first.
  await sql`CREATE INDEX webhook_deliveries_history ON webhook_deliveries (tenant_id, webhook_id, created_at DESC, id DESC)`.execute(db);
  // The recovery sweep: attempts whose time has come.
  await sql`CREATE INDEX webhook_deliveries_due ON webhook_deliveries (tenant_id, next_attempt_at) WHERE status = 'pending'`.execute(db);
  // The 30-day retention purge.
  await sql`CREATE INDEX webhook_deliveries_created ON webhook_deliveries (tenant_id, created_at)`.execute(db);
  await sql`SELECT enable_tenant_rls('webhook_deliveries')`.execute(db);
  await sql`SELECT grant_app_dml('webhook_deliveries')`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE webhook_deliveries`.execute(db);
  await sql`DROP TABLE webhooks`.execute(db);
}
