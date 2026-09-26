import { sql, type Kysely } from 'kysely';

/**
 * `tickets.reminder_notified_at` (T144, research D11): marks the `pending_until` the sweeper last
 * fired `ticket.reminder_reached` for, so a still-due `pending_reminder` ticket isn't re-announced
 * every 30 s sweep. `NULL` or older than the ticket's current `pending_until` means "not yet
 * notified for this date"; since a state-machine transition only ever moves `pending_until`
 * forward (`state-machine.ts` rejects a date that isn't later than now), a stale
 * `reminder_notified_at` from an earlier date always compares before the new one, so no separate
 * clearing on edit is needed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE tickets ADD COLUMN reminder_notified_at timestamptz`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE tickets DROP COLUMN reminder_notified_at`.execute(db);
}
