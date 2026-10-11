import { sql, type Kysely } from 'kysely';

/**
 * Automation rules (T254, data-model.md "automation_rules", FR-088, FR-089, spec US17; module:
 * Routing). Numbered 0021 because tasks.md's 0016 was taken by macros.
 *
 * - `automation_rules`: `trigger` is `{ event, after?, since? }` (`time.elapsed` needs both
 *   `after`, an ISO duration, and `since`, the ticket timestamp it counts from); `conditions` is a
 *   view condition tree (or null for "every ticket"); `actions` is validated by the rules service.
 *   Rules run in `position` order.
 * - `automation_runs`: one row per (rule, ticket, trigger key). The key is the domain event id for
 *   event triggers and `since:<timestamp>` for `time.elapsed`, so a rule runs once per event and a
 *   time rule once per waiting period, even when the sweeper overlaps itself. `status` is `done`
 *   or `failed` (`error` holds the refusal code, e.g. `OWNER_NOT_ELIGIBLE`). Runs go with their
 *   rule and their ticket.
 * - Notifications gain the `automation.rule` event (the rule's "notify users" action).
 */
const NOTIFICATION_TYPES_BEFORE = [
  'ticket.ungrouped_created',
  'ticket.arrived_in_group',
  'message.customer_on_my_ticket',
  'message.customer_on_unassigned',
  'ticket.assigned_to_me',
  'ticket.my_ticket_changed',
  'mention',
  'sla.warning',
  'sla.breached',
  'ticket.reminder_reached',
  'ai.paused',
];

async function setNotificationTypes(db: Kysely<unknown>, types: readonly string[]): Promise<void> {
  await sql`ALTER TABLE notifications DROP CONSTRAINT notifications_event_type`.execute(db);
  await sql`
    ALTER TABLE notifications ADD CONSTRAINT notifications_event_type
      CHECK (event_type IN (${sql.join(types.map((type) => sql.lit(type)))}))
  `.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE automation_rules (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      name text NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      position integer NOT NULL,
      trigger jsonb NOT NULL,
      conditions jsonb,
      actions jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT automation_rules_tenant_id_id_key UNIQUE (tenant_id, id),
      CONSTRAINT automation_rules_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
      CONSTRAINT automation_rules_position CHECK (position >= 0),
      CONSTRAINT automation_rules_trigger_object CHECK (jsonb_typeof(trigger) = 'object'),
      CONSTRAINT automation_rules_actions_object CHECK (jsonb_typeof(actions) = 'object')
    )
  `.execute(db);
  // The engine reads a tenant's enabled rules for one trigger, in order.
  await sql`CREATE INDEX automation_rules_tenant_position ON automation_rules (tenant_id, position, id)`.execute(db);
  await sql`
    CREATE TRIGGER automation_rules_touch BEFORE UPDATE ON automation_rules
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
  `.execute(db);
  await sql`SELECT enable_tenant_rls('automation_rules')`.execute(db);
  await sql`SELECT grant_app_dml('automation_rules')`.execute(db);

  await sql`
    CREATE TABLE automation_runs (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      rule_id uuid NOT NULL,
      ticket_id uuid NOT NULL,
      trigger_key text NOT NULL,
      status text NOT NULL,
      error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT automation_runs_once UNIQUE (tenant_id, rule_id, ticket_id, trigger_key),
      CONSTRAINT automation_runs_rule_fk FOREIGN KEY (tenant_id, rule_id)
        REFERENCES automation_rules (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT automation_runs_ticket_fk FOREIGN KEY (tenant_id, ticket_id)
        REFERENCES tickets (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT automation_runs_status CHECK (status IN ('done', 'failed')),
      CONSTRAINT automation_runs_trigger_key_length CHECK (char_length(trigger_key) BETWEEN 1 AND 100),
      CONSTRAINT automation_runs_error_length CHECK (char_length(error) <= 200)
    )
  `.execute(db);
  await sql`CREATE INDEX automation_runs_tenant_ticket ON automation_runs (tenant_id, ticket_id)`.execute(db);
  await sql`SELECT enable_tenant_rls('automation_runs')`.execute(db);
  await sql`SELECT grant_app_dml('automation_runs')`.execute(db);

  await setNotificationTypes(db, [...NOTIFICATION_TYPES_BEFORE, 'automation.rule']);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM notifications WHERE event_type = 'automation.rule'`.execute(db);
  await setNotificationTypes(db, NOTIFICATION_TYPES_BEFORE);
  await sql`DROP TABLE automation_runs`.execute(db);
  await sql`DROP TABLE automation_rules`.execute(db);
}
