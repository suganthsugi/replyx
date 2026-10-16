import { sql, type Kysely } from 'kysely';

/**
 * The tickets merged into a ticket (T266, perf-notes.md): its timeline includes their messages
 * (messages.repository.ts `listForTicket`). Partial, since only merged tickets have the column set.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX tickets_merged_into ON tickets (tenant_id, merged_into_id) WHERE merged_into_id IS NOT NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX tickets_merged_into`.execute(db);
}
