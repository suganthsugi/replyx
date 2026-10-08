import { sql, type Kysely } from 'kysely';

/**
 * The `ai.paused` notification (specs/002-ai-assist research R10, T009): holders of
 * `ai_settings.manage` get one in-app entry when AI pauses on a bad key or no credit. It has no
 * ticket, so `ticket_id` stays null.
 */
const BEFORE = [
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
];

async function setEventTypes(db: Kysely<unknown>, types: readonly string[]): Promise<void> {
  await sql`ALTER TABLE notifications DROP CONSTRAINT notifications_event_type`.execute(db);
  await sql`
    ALTER TABLE notifications ADD CONSTRAINT notifications_event_type
      CHECK (event_type IN (${sql.join(types.map((type) => sql.lit(type)))}))
  `.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await setEventTypes(db, [...BEFORE, 'ai.paused']);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM notifications WHERE event_type = 'ai.paused'`.execute(db);
  await setEventTypes(db, BEFORE);
}
