import { sql, type Kysely } from 'kysely';

/**
 * Search (T230, research D14, data-model.md "tickets" indexes; module: Search). Numbered 0015
 * because 0013 and 0014 were taken by routing and SLA before search was built.
 *
 * - `pg_trgm` and `unaccent` live in `public` and are normally created by `infra/postgres/init.sql`
 *   (superuser). `CREATE EXTENSION IF NOT EXISTS` is a no-op then; on a database that lacks them
 *   the owner role can still create them (both are trusted extensions).
 * - `public.replyx_unaccent(text)` is an IMMUTABLE wrapper around `unaccent` with the dictionary
 *   pinned: `unaccent(text)` itself is only STABLE, which a generated column or an index
 *   expression rejects.
 * - `tickets.title_tsv` and `ticket_messages.body_tsv` are STORED generated columns, so there is
 *   no indexer to keep in sync: `to_tsvector('simple', unaccented text)` with GIN indexes. Message
 *   bodies are immutable (0008), so the column is written once with the row.
 * - Trigram (`gin_trgm_ops`) indexes serve the substring/prefix `ILIKE` lookups on customer name
 *   (unaccented, lower-cased by ILIKE), customer email and the ticket number as text. `users.email`
 *   is citext, so the index is on `email::text`; queries must use the identical expression.
 * - The GIN indexes cannot lead with `tenant_id` (no `btree_gin`); isolation comes from the tenant
 *   filter and RLS on the matched rows, not from the index.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public`.execute(db);
  await sql`CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public`.execute(db);

  await sql`
    CREATE FUNCTION public.replyx_unaccent(input text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
    AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, input) $$
  `.execute(db);

  await sql`
    ALTER TABLE tickets
      ADD COLUMN title_tsv tsvector
      GENERATED ALWAYS AS (to_tsvector('simple', public.replyx_unaccent(title))) STORED
  `.execute(db);
  await sql`CREATE INDEX tickets_title_tsv ON tickets USING gin (title_tsv)`.execute(db);
  await sql`CREATE INDEX tickets_number_trgm ON tickets USING gin ((number::text) gin_trgm_ops)`.execute(db);

  await sql`
    ALTER TABLE ticket_messages
      ADD COLUMN body_tsv tsvector
      GENERATED ALWAYS AS (to_tsvector('simple', public.replyx_unaccent(body))) STORED
  `.execute(db);
  await sql`CREATE INDEX ticket_messages_body_tsv ON ticket_messages USING gin (body_tsv)`.execute(db);

  await sql`CREATE INDEX users_name_trgm ON users USING gin ((public.replyx_unaccent(name)) gin_trgm_ops)`.execute(db);
  await sql`CREATE INDEX users_email_trgm ON users USING gin ((email::text) gin_trgm_ops)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX users_email_trgm`.execute(db);
  await sql`DROP INDEX users_name_trgm`.execute(db);
  await sql`DROP INDEX ticket_messages_body_tsv`.execute(db);
  await sql`ALTER TABLE ticket_messages DROP COLUMN body_tsv`.execute(db);
  await sql`DROP INDEX tickets_number_trgm`.execute(db);
  await sql`DROP INDEX tickets_title_tsv`.execute(db);
  await sql`ALTER TABLE tickets DROP COLUMN title_tsv`.execute(db);
  await sql`DROP FUNCTION public.replyx_unaccent(text)`.execute(db);
}
