import { sql, type Kysely } from 'kysely';

/**
 * Routing rules (T214, data-model.md "routing_rules" and "Routing rules (P2)"; module: Routing).
 * The rule router evaluates rules by `position` at ticket creation and applies the first match.
 *
 * - `conditions` (object; all present parts must match: `messageContainsAny`, `messageContainsAll`,
 *   `customerTagIds`, `emailDomains`) and `actions` (object; `groupId` required, `priority` and
 *   `tagIds` optional) are checked for shape only here. Their content, and that `groupId` /
 *   `tagIds` / `customerTagIds` name rows of the same tenant, is validated in the routing service
 *   (research D13); there is no foreign key from jsonb to `groups` or `tags`, so a group that is
 *   later deactivated or a tag that is deleted is handled by the router (it skips such rules).
 * - `position` is not unique, like `views.position` (0009): reordering rewrites positions in one
 *   transaction and ties break on `id`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE routing_rules (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      name text NOT NULL,
      position integer NOT NULL DEFAULT 0,
      enabled boolean NOT NULL DEFAULT true,
      conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
      actions jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT routing_rules_tenant_id_id_key UNIQUE (tenant_id, id),
      CONSTRAINT routing_rules_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
      CONSTRAINT routing_rules_conditions_object CHECK (jsonb_typeof(conditions) = 'object'),
      CONSTRAINT routing_rules_actions_object CHECK (
        jsonb_typeof(actions) = 'object' AND actions ? 'groupId'
      )
    )
  `.execute(db);
  // Router evaluation order and admin listing.
  await sql`CREATE INDEX routing_rules_tenant_position ON routing_rules (tenant_id, position, id)`.execute(db);
  await sql`
    CREATE TRIGGER routing_rules_touch BEFORE UPDATE ON routing_rules
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
  `.execute(db);
  await sql`SELECT enable_tenant_rls('routing_rules')`.execute(db);
  await sql`SELECT grant_app_dml('routing_rules')`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE routing_rules`.execute(db);
}
