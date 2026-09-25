import { sql, type Kysely } from 'kysely';

/**
 * Tickets, messages, links, history and attachments (data-model.md "Tickets", research D4, D9,
 * D10, D17). Every table is tenant-owned with composite foreign keys and forced RLS.
 *
 * - `tickets.group_id IS NULL` is Ungrouped; a group with tickets can't be deleted (FR-030,
 *   `ON DELETE RESTRICT`). Ticket deletion is a hard delete that cascades to its messages,
 *   links, history and attachments.
 * - `ticket_messages` are immutable (FR-036): a trigger rejects any UPDATE of `body` or
 *   `visibility`. Moving a message to another ticket (FR-042) and delivery/read receipts are
 *   the only updates. `(tenant_id, author_id, client_message_id)` makes sends idempotent (D10).
 * - `ticket_links` keep a tombstone (`to_ticket_id NULL`, `removed_reason`) when the linked
 *   ticket is purged by retention.
 * - `ticket_history` is append-only for the app role (SELECT and INSERT); rows go only with
 *   their ticket (FK cascade, which runs outside the app role's grants).
 * - `attachments.message_id` stays null until the upload is sent with a message; unattached
 *   uploads expire after 24 h.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE tickets (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      number bigint NOT NULL,
      title text NOT NULL,
      customer_id uuid NOT NULL,
      group_id uuid,
      owner_id uuid,
      priority text NOT NULL DEFAULT 'normal',
      state text NOT NULL,
      pending_until timestamptz,
      auto_close_at timestamptz,
      waiting_on text NOT NULL DEFAULT 'support',
      origin text NOT NULL,
      merged_into_id uuid,
      resolved_at timestamptz,
      closed_at timestamptz,
      last_customer_message_at timestamptz,
      last_agent_reply_at timestamptz,
      first_agent_reply_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT tickets_tenant_id_id_key UNIQUE (tenant_id, id),
      CONSTRAINT tickets_tenant_id_number_key UNIQUE (tenant_id, number),
      CONSTRAINT tickets_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES users (tenant_id, id),
      CONSTRAINT tickets_group_fk FOREIGN KEY (tenant_id, group_id)
        REFERENCES groups (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT tickets_owner_fk FOREIGN KEY (tenant_id, owner_id)
        REFERENCES users (tenant_id, id) ON DELETE SET NULL (owner_id),
      CONSTRAINT tickets_merged_into_fk FOREIGN KEY (tenant_id, merged_into_id)
        REFERENCES tickets (tenant_id, id) ON DELETE SET NULL (merged_into_id),
      CONSTRAINT tickets_title_length CHECK (char_length(title) BETWEEN 1 AND 200),
      CONSTRAINT tickets_number_positive CHECK (number > 0),
      CONSTRAINT tickets_priority CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
      CONSTRAINT tickets_state CHECK (
        state IN ('new', 'open', 'pending_reminder', 'pending_close', 'resolved', 'closed')
      ),
      CONSTRAINT tickets_waiting_on CHECK (waiting_on IN ('support', 'customer')),
      CONSTRAINT tickets_origin CHECK (origin IN ('customer_message', 'staff_started', 'split', 'follow_up')),
      CONSTRAINT tickets_pending_has_date CHECK (
        state NOT IN ('pending_reminder', 'pending_close') OR pending_until IS NOT NULL
      ),
      CONSTRAINT tickets_resolved_has_dates CHECK (
        state <> 'resolved' OR (resolved_at IS NOT NULL AND auto_close_at IS NOT NULL)
      ),
      CONSTRAINT tickets_closed_has_date CHECK (state <> 'closed' OR closed_at IS NOT NULL),
      CONSTRAINT tickets_not_merged_into_self CHECK (merged_into_id IS DISTINCT FROM id)
    )
  `.execute(db);
  await sql`CREATE INDEX tickets_state_group ON tickets (tenant_id, state, group_id)`.execute(db);
  await sql`
    CREATE INDEX tickets_group_owner_open ON tickets (tenant_id, group_id, owner_id)
    WHERE state <> 'closed'
  `.execute(db);
  await sql`CREATE INDEX tickets_owner_state ON tickets (tenant_id, owner_id, state)`.execute(db);
  // The conversation router's lookup: a customer's tickets, most recently updated first.
  await sql`CREATE INDEX tickets_customer_updated ON tickets (tenant_id, customer_id, updated_at DESC)`.execute(db);
  await sql`CREATE INDEX tickets_updated ON tickets (tenant_id, updated_at DESC)`.execute(db);
  await sql`CREATE INDEX tickets_created ON tickets (tenant_id, created_at DESC)`.execute(db);
  await sql`CREATE INDEX tickets_last_customer_message ON tickets (tenant_id, last_customer_message_at)`.execute(db);
  await sql`CREATE INDEX tickets_last_agent_reply ON tickets (tenant_id, last_agent_reply_at)`.execute(db);
  // Sweeper scans (research D11).
  await sql`
    CREATE INDEX tickets_pending_until ON tickets (tenant_id, pending_until)
    WHERE state IN ('pending_reminder', 'pending_close')
  `.execute(db);
  await sql`CREATE INDEX tickets_auto_close ON tickets (tenant_id, auto_close_at) WHERE state = 'resolved'`.execute(db);
  // Title search (research D14).
  await sql`CREATE INDEX tickets_title_search ON tickets USING gin (to_tsvector('simple', title))`.execute(db);
  await sql`
    CREATE TRIGGER tickets_touch BEFORE UPDATE ON tickets
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
  `.execute(db);
  await sql`SELECT enable_tenant_rls('tickets')`.execute(db);
  await sql`SELECT grant_app_dml('tickets')`.execute(db);

  await sql`
    CREATE TABLE ticket_messages (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      ticket_id uuid NOT NULL,
      author_id uuid,
      author_kind text NOT NULL,
      visibility text NOT NULL,
      body text NOT NULL,
      client_message_id text,
      mentions uuid[] NOT NULL DEFAULT '{}',
      moved_from_ticket_id uuid,
      delivered_at timestamptz,
      read_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ticket_messages_tenant_id_id_key UNIQUE (tenant_id, id),
      CONSTRAINT ticket_messages_client_message_key UNIQUE (tenant_id, author_id, client_message_id),
      CONSTRAINT ticket_messages_ticket_fk FOREIGN KEY (tenant_id, ticket_id)
        REFERENCES tickets (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT ticket_messages_author_fk FOREIGN KEY (tenant_id, author_id) REFERENCES users (tenant_id, id),
      CONSTRAINT ticket_messages_moved_from_fk FOREIGN KEY (tenant_id, moved_from_ticket_id)
        REFERENCES tickets (tenant_id, id) ON DELETE SET NULL (moved_from_ticket_id),
      CONSTRAINT ticket_messages_author_kind CHECK (author_kind IN ('customer', 'staff', 'system', 'automation')),
      CONSTRAINT ticket_messages_visibility CHECK (visibility IN ('public', 'internal')),
      CONSTRAINT ticket_messages_body_length CHECK (char_length(body) BETWEEN 1 AND 10000),
      CONSTRAINT ticket_messages_client_message_length CHECK (char_length(client_message_id) BETWEEN 1 AND 100),
      -- People write as themselves; system and automation messages have no author.
      CONSTRAINT ticket_messages_author CHECK ((author_kind IN ('customer', 'staff')) = (author_id IS NOT NULL)),
      -- Customers only ever write public messages.
      CONSTRAINT ticket_messages_customer_public CHECK (author_kind <> 'customer' OR visibility = 'public')
    )
  `.execute(db);
  await sql`CREATE INDEX ticket_messages_ticket_created ON ticket_messages (tenant_id, ticket_id, created_at)`.execute(db);
  // FR-036: messages are immutable. Only moves (FR-042) and receipts change a row.
  await sql`
    CREATE FUNCTION ticket_messages_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.body IS DISTINCT FROM OLD.body OR NEW.visibility IS DISTINCT FROM OLD.visibility THEN
        RAISE EXCEPTION 'ticket messages cannot be edited' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END
    $$
  `.execute(db);
  await sql`
    CREATE TRIGGER ticket_messages_immutable BEFORE UPDATE ON ticket_messages
    FOR EACH ROW EXECUTE FUNCTION ticket_messages_immutable()
  `.execute(db);
  await sql`
    CREATE TRIGGER ticket_messages_touch BEFORE UPDATE ON ticket_messages
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
  `.execute(db);
  await sql`SELECT enable_tenant_rls('ticket_messages')`.execute(db);
  await sql`SELECT grant_app_dml('ticket_messages')`.execute(db);

  await sql`
    CREATE TABLE ticket_links (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      from_ticket_id uuid NOT NULL,
      to_ticket_id uuid,
      kind text NOT NULL,
      removed_reason text,
      created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ticket_links_tenant_id_id_key UNIQUE (tenant_id, id),
      CONSTRAINT ticket_links_unique UNIQUE (tenant_id, from_ticket_id, to_ticket_id, kind),
      CONSTRAINT ticket_links_from_fk FOREIGN KEY (tenant_id, from_ticket_id)
        REFERENCES tickets (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT ticket_links_to_fk FOREIGN KEY (tenant_id, to_ticket_id)
        REFERENCES tickets (tenant_id, id) ON DELETE SET NULL (to_ticket_id),
      CONSTRAINT ticket_links_created_by_fk FOREIGN KEY (tenant_id, created_by)
        REFERENCES users (tenant_id, id) ON DELETE SET NULL (created_by),
      CONSTRAINT ticket_links_kind CHECK (kind IN ('follow_up_of', 'related', 'duplicate_of', 'merged_into', 'split_from')),
      CONSTRAINT ticket_links_removed_reason CHECK (removed_reason IN ('retention')),
      CONSTRAINT ticket_links_tombstone CHECK ((to_ticket_id IS NULL) = (removed_reason IS NOT NULL)),
      CONSTRAINT ticket_links_not_self CHECK (to_ticket_id IS DISTINCT FROM from_ticket_id)
    )
  `.execute(db);
  await sql`CREATE INDEX ticket_links_to ON ticket_links (tenant_id, to_ticket_id)`.execute(db);
  await sql`SELECT enable_tenant_rls('ticket_links')`.execute(db);
  await sql`SELECT grant_app_dml('ticket_links')`.execute(db);

  await sql`
    CREATE TABLE ticket_history (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      ticket_id uuid NOT NULL,
      actor_id uuid,
      actor_kind text NOT NULL,
      field text NOT NULL,
      old_value jsonb,
      new_value jsonb,
      event_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ticket_history_tenant_id_id_key UNIQUE (tenant_id, id),
      CONSTRAINT ticket_history_ticket_fk FOREIGN KEY (tenant_id, ticket_id)
        REFERENCES tickets (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT ticket_history_actor_kind CHECK (actor_kind IN ('user', 'operator', 'system', 'automation', 'routing')),
      CONSTRAINT ticket_history_field_format CHECK (field ~ '^[a-z][a-z_]*$')
    )
  `.execute(db);
  await sql`CREATE INDEX ticket_history_ticket_created ON ticket_history (tenant_id, ticket_id, created_at)`.execute(db);
  await sql`SELECT enable_tenant_rls('ticket_history')`.execute(db);
  await sql`SELECT grant_app_dml('ticket_history', ARRAY['SELECT', 'INSERT'])`.execute(db);

  await sql`
    CREATE TABLE attachments (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      message_id uuid,
      uploaded_by uuid NOT NULL,
      file_name text NOT NULL,
      content_type text NOT NULL,
      size_bytes bigint NOT NULL,
      storage_key text NOT NULL,
      scan_status text NOT NULL DEFAULT 'pending',
      scanned_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT attachments_tenant_id_id_key UNIQUE (tenant_id, id),
      CONSTRAINT attachments_message_fk FOREIGN KEY (tenant_id, message_id)
        REFERENCES ticket_messages (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT attachments_uploaded_by_fk FOREIGN KEY (tenant_id, uploaded_by) REFERENCES users (tenant_id, id),
      CONSTRAINT attachments_file_name_length CHECK (char_length(file_name) BETWEEN 1 AND 255),
      CONSTRAINT attachments_content_type_length CHECK (char_length(content_type) BETWEEN 1 AND 255),
      -- FR-045: 25 MB.
      CONSTRAINT attachments_size CHECK (size_bytes BETWEEN 1 AND 26214400),
      CONSTRAINT attachments_scan_status CHECK (scan_status IN ('pending', 'clean', 'blocked'))
    )
  `.execute(db);
  await sql`CREATE INDEX attachments_message ON attachments (tenant_id, message_id)`.execute(db);
  // Expiry of uploads that were never sent.
  await sql`CREATE INDEX attachments_unattached ON attachments (tenant_id, created_at) WHERE message_id IS NULL`.execute(db);
  await sql`
    CREATE TRIGGER attachments_touch BEFORE UPDATE ON attachments
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
  `.execute(db);
  await sql`SELECT enable_tenant_rls('attachments')`.execute(db);
  await sql`SELECT grant_app_dml('attachments')`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE attachments`.execute(db);
  await sql`DROP TABLE ticket_history`.execute(db);
  await sql`DROP TABLE ticket_links`.execute(db);
  await sql`DROP TABLE ticket_messages`.execute(db);
  await sql`DROP FUNCTION ticket_messages_immutable()`.execute(db);
  await sql`DROP TABLE tickets`.execute(db);
}
