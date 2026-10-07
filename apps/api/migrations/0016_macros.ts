import { sql, type Kysely } from 'kysely';

/**
 * Macros (T236, data-model.md "macros", FR-068, spec US14; module: Macros). Numbered 0016 because
 * 0014 and 0015 were taken by SLA and search before macros were built (tasks.md says 0014).
 *
 * - `body` is the reply template (0 to 10,000 characters; empty for a macro that only sets fields).
 *   `actions` is an object whose keys (`state`, `pendingInHours`, `priority`, `addTagIds`,
 *   `assignToMe`) are validated by the macros service (research D13); there is no foreign key from
 *   jsonb to `tags`, so a tag deleted later is skipped when the macro is applied.
 * - Sharing follows `views` (0009): `visibility` is `all_staff`, `roles` or `groups`, and
 *   `shared_role_ids` / `shared_group_ids` are plain uuid arrays used only for `roles` / `groups`.
 *   There is no `personal` visibility. `created_by` is the creating user, who always sees the
 *   macro (so sharing it with roles or groups they are not in never hides it from them); it is
 *   nulled when that user is hard-deleted (`ON DELETE SET NULL (created_by)` keeps `tenant_id`).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE macros (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      name text NOT NULL,
      body text NOT NULL DEFAULT '',
      actions jsonb NOT NULL DEFAULT '{}'::jsonb,
      visibility text NOT NULL DEFAULT 'all_staff',
      shared_role_ids uuid[] NOT NULL DEFAULT '{}',
      shared_group_ids uuid[] NOT NULL DEFAULT '{}',
      created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT macros_tenant_id_id_key UNIQUE (tenant_id, id),
      CONSTRAINT macros_created_by_fk FOREIGN KEY (tenant_id, created_by)
        REFERENCES users (tenant_id, id) ON DELETE SET NULL (created_by),
      CONSTRAINT macros_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
      CONSTRAINT macros_body_length CHECK (char_length(body) <= 10000),
      CONSTRAINT macros_visibility CHECK (visibility IN ('all_staff', 'roles', 'groups')),
      CONSTRAINT macros_actions_object CHECK (jsonb_typeof(actions) = 'object')
    )
  `.execute(db);
  // Listing for the picker and the admin page: by name within the tenant.
  await sql`CREATE INDEX macros_tenant_name ON macros (tenant_id, lower(name), id)`.execute(db);
  await sql`
    CREATE TRIGGER macros_touch BEFORE UPDATE ON macros
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
  `.execute(db);
  await sql`SELECT enable_tenant_rls('macros')`.execute(db);
  await sql`SELECT grant_app_dml('macros')`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE macros`.execute(db);
}
