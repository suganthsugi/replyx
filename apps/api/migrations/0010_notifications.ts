import { sql, type Kysely } from 'kysely';

/**
 * Notifications (data-model.md "notifications", "notification_deliveries",
 * "notification_preferences", research D20, module: Notifications). Every table is tenant-owned
 * with composite foreign keys and forced RLS.
 *
 * - `notifications` are in-app entries. `event_type` is the notification event (FR-079), not the
 *   domain event; `event_id` is the domain event that created the entry (no foreign key: the
 *   outbox is pruned after 7 days). `group_key` batches a burst into one entry whose `count`
 *   grows (FR-082); the partial index finds the open, unread entry to add to. An entry about a
 *   ticket goes with the ticket when it is deleted or purged.
 * - `notification_deliveries` is the dedupe ledger: one row per recipient, domain event and
 *   channel, so a redelivered event never notifies twice (FR-082).
 * - `notification_preferences` holds a user's own choices; missing events fall back to the
 *   tenant's defaults (`tenant_settings.notification_defaults`, FR-080). Push subscriptions are
 *   stored now and used by US15.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE notifications (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      recipient_id uuid NOT NULL,
      event_type text NOT NULL,
      ticket_id uuid,
      group_key text,
      count integer NOT NULL DEFAULT 1,
      title text NOT NULL,
      summary text,
      read_at timestamptz,
      event_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT notifications_tenant_id_id_key UNIQUE (tenant_id, id),
      CONSTRAINT notifications_recipient_fk FOREIGN KEY (tenant_id, recipient_id)
        REFERENCES users (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT notifications_ticket_fk FOREIGN KEY (tenant_id, ticket_id)
        REFERENCES tickets (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT notifications_event_type CHECK (event_type IN (
        'ticket.ungrouped_created', 'ticket.arrived_in_group', 'message.customer_on_my_ticket',
        'message.customer_on_unassigned', 'ticket.assigned_to_me', 'ticket.my_ticket_changed',
        'mention', 'sla.warning', 'sla.breached', 'ticket.reminder_reached'
      )),
      CONSTRAINT notifications_count_positive CHECK (count >= 1),
      CONSTRAINT notifications_title_length CHECK (char_length(title) BETWEEN 1 AND 200),
      CONSTRAINT notifications_summary_length CHECK (char_length(summary) <= 300),
      CONSTRAINT notifications_group_key_length CHECK (char_length(group_key) <= 200)
    )
  `.execute(db);
  // The notification center: a user's entries, unread first, newest first.
  await sql`
    CREATE INDEX notifications_recipient_read_created
    ON notifications (tenant_id, recipient_id, read_at, created_at DESC)
  `.execute(db);
  // Burst grouping: the recipient's open (unread) entry for a group key.
  await sql`
    CREATE INDEX notifications_recipient_group_key
    ON notifications (tenant_id, recipient_id, group_key, created_at DESC)
    WHERE group_key IS NOT NULL AND read_at IS NULL
  `.execute(db);
  await sql`
    CREATE TRIGGER notifications_touch BEFORE UPDATE ON notifications
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
  `.execute(db);
  await sql`SELECT enable_tenant_rls('notifications')`.execute(db);
  await sql`SELECT grant_app_dml('notifications')`.execute(db);

  await sql`
    CREATE TABLE notification_deliveries (
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      recipient_id uuid NOT NULL,
      event_id uuid NOT NULL,
      channel text NOT NULL,
      status text NOT NULL DEFAULT 'sent',
      sent_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, recipient_id, event_id, channel),
      CONSTRAINT notification_deliveries_recipient_fk FOREIGN KEY (tenant_id, recipient_id)
        REFERENCES users (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT notification_deliveries_channel CHECK (channel IN ('in_app', 'push', 'email')),
      CONSTRAINT notification_deliveries_status CHECK (status IN ('pending', 'sent', 'failed', 'skipped'))
    )
  `.execute(db);
  await sql`SELECT enable_tenant_rls('notification_deliveries')`.execute(db);
  await sql`SELECT grant_app_dml('notification_deliveries')`.execute(db);

  await sql`
    CREATE TABLE notification_preferences (
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      user_id uuid NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      events jsonb NOT NULL DEFAULT '{}'::jsonb,
      push_subscriptions jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, user_id),
      CONSTRAINT notification_preferences_user_fk FOREIGN KEY (tenant_id, user_id)
        REFERENCES users (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT notification_preferences_events_object CHECK (jsonb_typeof(events) = 'object'),
      CONSTRAINT notification_preferences_push_array CHECK (jsonb_typeof(push_subscriptions) = 'array')
    )
  `.execute(db);
  await sql`
    CREATE TRIGGER notification_preferences_touch BEFORE UPDATE ON notification_preferences
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
  `.execute(db);
  await sql`SELECT enable_tenant_rls('notification_preferences')`.execute(db);
  await sql`SELECT grant_app_dml('notification_preferences')`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE notification_preferences`.execute(db);
  await sql`DROP TABLE notification_deliveries`.execute(db);
  await sql`DROP TABLE notifications`.execute(db);
}
