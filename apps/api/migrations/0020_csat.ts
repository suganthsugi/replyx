import { sql, type Kysely } from 'kysely';

/**
 * Satisfaction ratings (T248, data-model.md "csat_ratings", FR-087, spec US16; module:
 * Satisfaction). Numbered 0020 because tasks.md's 0015 was taken long ago.
 *
 * - One row per ticket (`UNIQUE (tenant_id, ticket_id)`): rating again changes the row.
 * - `score` 1–5, or NULL when the customer skipped the offer (`skipped_at` set), so a skipped
 *   ticket is not offered again and never counts towards the satisfaction figure.
 * - `comment` up to 1,000 characters.
 * - The row goes with its ticket (delete or retention purge) and with its customer (erasure).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE csat_ratings (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      ticket_id uuid NOT NULL,
      customer_id uuid NOT NULL,
      score smallint,
      comment text,
      skipped_at timestamptz,
      rated_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT csat_ratings_tenant_id_id_key UNIQUE (tenant_id, id),
      CONSTRAINT csat_ratings_ticket_key UNIQUE (tenant_id, ticket_id),
      CONSTRAINT csat_ratings_ticket_fk FOREIGN KEY (tenant_id, ticket_id)
        REFERENCES tickets (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT csat_ratings_customer_fk FOREIGN KEY (tenant_id, customer_id)
        REFERENCES users (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT csat_ratings_score_range CHECK (score BETWEEN 1 AND 5),
      CONSTRAINT csat_ratings_comment_length CHECK (char_length(comment) <= 1000),
      CONSTRAINT csat_ratings_rated_or_skipped CHECK ((score IS NULL) = (rated_at IS NULL) AND (score IS NULL OR skipped_at IS NULL))
    )
  `.execute(db);
  // The dashboard figure: ratings in a time window.
  await sql`CREATE INDEX csat_ratings_tenant_rated ON csat_ratings (tenant_id, rated_at) WHERE score IS NOT NULL`.execute(db);
  // A customer's profile: their ratings.
  await sql`CREATE INDEX csat_ratings_tenant_customer ON csat_ratings (tenant_id, customer_id)`.execute(db);
  await sql`
    CREATE TRIGGER csat_ratings_touch BEFORE UPDATE ON csat_ratings
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
  `.execute(db);
  await sql`SELECT enable_tenant_rls('csat_ratings')`.execute(db);
  await sql`SELECT grant_app_dml('csat_ratings')`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE csat_ratings`.execute(db);
}
