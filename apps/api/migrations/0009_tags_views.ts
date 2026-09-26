import { sql, type Kysely } from 'kysely';

/**
 * Tags and views (data-model.md "tags, ticket_tags, customer_tags" and "views", module: Tags,
 * Views). Every table is tenant-owned with composite foreign keys and forced RLS.
 *
 * - `tags` names are unique per tenant case-insensitively (`UNIQUE (tenant_id, lower(name))`),
 *   matching the `roles`/`groups` name-uniqueness pattern (0004_authorization).
 * - `ticket_tags` and `customer_tags` are pure join tables (no `updated_at`), same shape as
 *   `user_roles` (0004_authorization): composite PK, cascade on either side.
 * - `views.owner_id` is set only for `visibility = 'personal'`; `shared_role_ids` /
 *   `shared_group_ids` are plain uuid arrays (Postgres has no array foreign keys) used only when
 *   `visibility` is `roles` / `groups`. `conditions` (an object, the expression tree) and `sort`
 *   (an array of `{field, direction}`) are validated for shape only here; the condition schema
 *   itself is service-side (research D13). System views (`system_key` set) are unique per tenant
 *   like `roles.system_key` (0004_authorization).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE tags (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT tags_tenant_id_id_key UNIQUE (tenant_id, id),
      CONSTRAINT tags_name_length CHECK (char_length(name) BETWEEN 1 AND 40)
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX tags_tenant_name ON tags (tenant_id, lower(name))`.execute(db);
  await sql`
    CREATE TRIGGER tags_touch BEFORE UPDATE ON tags
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
  `.execute(db);
  await sql`SELECT enable_tenant_rls('tags')`.execute(db);
  await sql`SELECT grant_app_dml('tags')`.execute(db);

  await sql`
    CREATE TABLE ticket_tags (
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      ticket_id uuid NOT NULL,
      tag_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, ticket_id, tag_id),
      CONSTRAINT ticket_tags_ticket_fk FOREIGN KEY (tenant_id, ticket_id)
        REFERENCES tickets (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT ticket_tags_tag_fk FOREIGN KEY (tenant_id, tag_id)
        REFERENCES tags (tenant_id, id) ON DELETE CASCADE
    )
  `.execute(db);
  // Filtering tickets by tag (view conditions, FR-026).
  await sql`CREATE INDEX ticket_tags_tenant_tag ON ticket_tags (tenant_id, tag_id)`.execute(db);
  await sql`SELECT enable_tenant_rls('ticket_tags')`.execute(db);
  await sql`SELECT grant_app_dml('ticket_tags')`.execute(db);

  await sql`
    CREATE TABLE customer_tags (
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      user_id uuid NOT NULL,
      tag_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, user_id, tag_id),
      CONSTRAINT customer_tags_user_fk FOREIGN KEY (tenant_id, user_id)
        REFERENCES users (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT customer_tags_tag_fk FOREIGN KEY (tenant_id, tag_id)
        REFERENCES tags (tenant_id, id) ON DELETE CASCADE
    )
  `.execute(db);
  // Routing rules match on customer tags (data-model.md "routing_rules").
  await sql`CREATE INDEX customer_tags_tenant_tag ON customer_tags (tenant_id, tag_id)`.execute(db);
  await sql`SELECT enable_tenant_rls('customer_tags')`.execute(db);
  await sql`SELECT grant_app_dml('customer_tags')`.execute(db);

  await sql`
    CREATE TABLE views (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      name text NOT NULL,
      description text,
      system_key text,
      owner_id uuid,
      visibility text NOT NULL,
      shared_role_ids uuid[] NOT NULL DEFAULT '{}',
      shared_group_ids uuid[] NOT NULL DEFAULT '{}',
      conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
      sort jsonb NOT NULL DEFAULT '[]'::jsonb,
      columns text[] NOT NULL DEFAULT '{}',
      position integer NOT NULL DEFAULT 0,
      hidden boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT views_tenant_id_id_key UNIQUE (tenant_id, id),
      CONSTRAINT views_owner_fk FOREIGN KEY (tenant_id, owner_id)
        REFERENCES users (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT views_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
      CONSTRAINT views_description_length CHECK (char_length(description) <= 300),
      CONSTRAINT views_system_key_length CHECK (system_key IS NULL OR char_length(system_key) BETWEEN 1 AND 60),
      CONSTRAINT views_visibility CHECK (visibility IN ('personal', 'all_staff', 'roles', 'groups')),
      CONSTRAINT views_personal_has_owner CHECK (visibility <> 'personal' OR owner_id IS NOT NULL),
      CONSTRAINT views_conditions_object CHECK (jsonb_typeof(conditions) = 'object'),
      CONSTRAINT views_sort_array CHECK (jsonb_typeof(sort) = 'array')
    )
  `.execute(db);
  // FR-073: system views are unique per tenant, same pattern as roles.system_key.
  await sql`
    CREATE UNIQUE INDEX views_tenant_system_key ON views (tenant_id, system_key)
    WHERE system_key IS NOT NULL
  `.execute(db);
  // Personal views: a user's own view list.
  await sql`
    CREATE INDEX views_tenant_owner ON views (tenant_id, owner_id)
    WHERE owner_id IS NOT NULL
  `.execute(db);
  // Reordering / listing (FR-073: editable, hideable, reorderable).
  await sql`CREATE INDEX views_tenant_position ON views (tenant_id, position)`.execute(db);
  await sql`
    CREATE TRIGGER views_touch BEFORE UPDATE ON views
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
  `.execute(db);
  await sql`SELECT enable_tenant_rls('views')`.execute(db);
  await sql`SELECT grant_app_dml('views')`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE views`.execute(db);
  await sql`DROP TABLE customer_tags`.execute(db);
  await sql`DROP TABLE ticket_tags`.execute(db);
  await sql`DROP TABLE tags`.execute(db);
}
