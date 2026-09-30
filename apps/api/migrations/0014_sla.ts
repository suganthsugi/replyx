import { sql, type Kysely } from 'kysely';

/**
 * SLA and business hours (T221, data-model.md "business_hours", "sla_policies", "ticket_sla",
 * "sla_events"; research D15; module: Sla).
 *
 * - `business_hours.intervals` is an object of weekday (`mon`..`sun`) to a list of `{from, to}`
 *   `HH:MM` ranges in the calendar's `timezone`; its content (weekday keys, ranges, overlaps, IANA
 *   zone) is validated in the SLA service, only the shape is checked here. `holidays` are local dates.
 * - `sla_policies` are ordered by `position` (not unique, like `views.position`; ties break on `id`).
 *   `conditions` is the shared condition group (priority, group), validated in the service. Each
 *   target may be omitted (null). `business_hours_id` is required and deleting a calendar that a
 *   policy or `tenant_settings` still uses is refused (no ON DELETE action).
 * - `ticket_sla` is one row per ticket (PK `ticket_id`), recomputed by the SLA consumer. A due or
 *   warn time is null when the policy has no such target or the target is met. `status` is the
 *   worst state over the targets. `paused_since` is set while a pending state pauses the
 *   resolution timer. Deleting a policy deletes its rows; the service recomputes open tickets.
 * - `sla_events` records each warning or breach once per ticket and target (unique key), which
 *   makes the sweeper idempotent (insert, and emit the notification only when a row was inserted).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE business_hours (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      name text NOT NULL,
      timezone text NOT NULL,
      intervals jsonb NOT NULL DEFAULT '{}'::jsonb,
      holidays date[] NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT business_hours_tenant_id_id_key UNIQUE (tenant_id, id),
      CONSTRAINT business_hours_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
      CONSTRAINT business_hours_timezone_length CHECK (char_length(timezone) BETWEEN 1 AND 64),
      CONSTRAINT business_hours_intervals_object CHECK (jsonb_typeof(intervals) = 'object')
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX business_hours_tenant_name ON business_hours (tenant_id, lower(name))`.execute(db);
  await sql`
    CREATE TRIGGER business_hours_touch BEFORE UPDATE ON business_hours
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
  `.execute(db);
  await sql`SELECT enable_tenant_rls('business_hours')`.execute(db);
  await sql`SELECT grant_app_dml('business_hours')`.execute(db);

  await sql`
    CREATE TABLE sla_policies (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      name text NOT NULL,
      position integer NOT NULL DEFAULT 0,
      conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
      business_hours_id uuid NOT NULL,
      first_response_minutes integer,
      next_response_minutes integer,
      resolution_minutes integer,
      warning_percent integer NOT NULL DEFAULT 80,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT sla_policies_tenant_id_id_key UNIQUE (tenant_id, id),
      CONSTRAINT sla_policies_business_hours_fk FOREIGN KEY (tenant_id, business_hours_id)
        REFERENCES business_hours (tenant_id, id),
      CONSTRAINT sla_policies_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
      CONSTRAINT sla_policies_conditions_object CHECK (jsonb_typeof(conditions) = 'object'),
      CONSTRAINT sla_policies_first_response CHECK (first_response_minutes IS NULL OR first_response_minutes >= 1),
      CONSTRAINT sla_policies_next_response CHECK (next_response_minutes IS NULL OR next_response_minutes >= 1),
      CONSTRAINT sla_policies_resolution CHECK (resolution_minutes IS NULL OR resolution_minutes >= 1),
      CONSTRAINT sla_policies_warning_percent CHECK (warning_percent BETWEEN 50 AND 99)
    )
  `.execute(db);
  // Policy evaluation order (first match applies) and admin listing.
  await sql`CREATE INDEX sla_policies_tenant_position ON sla_policies (tenant_id, position, id)`.execute(db);
  // "Refused while a policy uses it" check on calendar delete.
  await sql`CREATE INDEX sla_policies_business_hours ON sla_policies (tenant_id, business_hours_id)`.execute(db);
  await sql`
    CREATE TRIGGER sla_policies_touch BEFORE UPDATE ON sla_policies
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
  `.execute(db);
  await sql`SELECT enable_tenant_rls('sla_policies')`.execute(db);
  await sql`SELECT grant_app_dml('sla_policies')`.execute(db);

  await sql`
    CREATE TABLE ticket_sla (
      ticket_id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      policy_id uuid NOT NULL,
      first_response_due_at timestamptz,
      first_response_warn_at timestamptz,
      next_response_due_at timestamptz,
      next_response_warn_at timestamptz,
      resolution_due_at timestamptz,
      resolution_warn_at timestamptz,
      status text NOT NULL DEFAULT 'ok',
      paused_since timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ticket_sla_tenant_ticket_key UNIQUE (tenant_id, ticket_id),
      CONSTRAINT ticket_sla_ticket_fk FOREIGN KEY (tenant_id, ticket_id)
        REFERENCES tickets (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT ticket_sla_policy_fk FOREIGN KEY (tenant_id, policy_id)
        REFERENCES sla_policies (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT ticket_sla_status CHECK (status IN ('ok', 'warning', 'breached'))
    )
  `.execute(db);
  // Escalated view and dashboard counts.
  await sql`CREATE INDEX ticket_sla_tenant_status ON ticket_sla (tenant_id, status)`.execute(db);
  await sql`CREATE INDEX ticket_sla_tenant_policy ON ticket_sla (tenant_id, policy_id)`.execute(db);
  // Sweeper: per target, the next warn and due times of running (not paused) timers.
  for (const target of ['first_response', 'next_response', 'resolution']) {
    for (const kind of ['warn', 'due']) {
      const column = `${target}_${kind}_at`;
      await sql`
        CREATE INDEX ${sql.id(`ticket_sla_${column}`)} ON ticket_sla (tenant_id, ${sql.id(column)})
        WHERE ${sql.id(column)} IS NOT NULL AND paused_since IS NULL
      `.execute(db);
    }
  }
  await sql`
    CREATE TRIGGER ticket_sla_touch BEFORE UPDATE ON ticket_sla
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
  `.execute(db);
  await sql`SELECT enable_tenant_rls('ticket_sla')`.execute(db);
  await sql`SELECT grant_app_dml('ticket_sla')`.execute(db);

  await sql`
    CREATE TABLE sla_events (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      ticket_id uuid NOT NULL,
      target text NOT NULL,
      kind text NOT NULL,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT sla_events_tenant_id_id_key UNIQUE (tenant_id, id),
      CONSTRAINT sla_events_once UNIQUE (tenant_id, ticket_id, target, kind),
      CONSTRAINT sla_events_ticket_fk FOREIGN KEY (tenant_id, ticket_id)
        REFERENCES tickets (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT sla_events_target CHECK (target IN ('first_response', 'next_response', 'resolution')),
      CONSTRAINT sla_events_kind CHECK (kind IN ('warning', 'breached'))
    )
  `.execute(db);
  await sql`SELECT enable_tenant_rls('sla_events')`.execute(db);
  await sql`SELECT grant_app_dml('sla_events')`.execute(db);

  // The tenant's calendar for out-of-hours handling (contracts/operations.yaml Settings.businessHoursId).
  await sql`ALTER TABLE tenant_settings ADD COLUMN business_hours_id uuid`.execute(db);
  await sql`
    ALTER TABLE tenant_settings ADD CONSTRAINT tenant_settings_business_hours_fk
      FOREIGN KEY (tenant_id, business_hours_id) REFERENCES business_hours (tenant_id, id)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE tenant_settings DROP CONSTRAINT tenant_settings_business_hours_fk`.execute(db);
  await sql`ALTER TABLE tenant_settings DROP COLUMN business_hours_id`.execute(db);
  await sql`DROP TABLE sla_events`.execute(db);
  await sql`DROP TABLE ticket_sla`.execute(db);
  await sql`DROP TABLE sla_policies`.execute(db);
  await sql`DROP TABLE business_hours`.execute(db);
}
