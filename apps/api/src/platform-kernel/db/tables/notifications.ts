import type { Generated, GeneratedTimestamp, JsonValue, Timestamp } from './column-types.js';

/** Migration 0010_notifications (data-model.md "notifications", research D20). */

/** Notification events a user can receive (FR-079, contracts/operations.yaml `Notification`). */
export const NOTIFICATION_EVENT_TYPES = [
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
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export type NotificationChannel = 'in_app' | 'push' | 'email';

export interface NotificationsTable {
  id: Generated<string>;
  tenant_id: string;
  recipient_id: string;
  event_type: NotificationEventType;
  ticket_id: string | null;
  group_key: string | null;
  count: Generated<number>;
  title: string;
  summary: string | null;
  read_at: Timestamp | null;
  event_id: string;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface NotificationDeliveriesTable {
  tenant_id: string;
  recipient_id: string;
  event_id: string;
  channel: NotificationChannel;
  status: Generated<'pending' | 'sent' | 'failed' | 'skipped'>;
  sent_at: Timestamp | null;
  created_at: GeneratedTimestamp;
}

export interface NotificationPreferencesTable {
  tenant_id: string;
  user_id: string;
  enabled: Generated<boolean>;
  /** `{ [event]: { inApp?, push?, email? } }`, only the events the user changed. */
  events: Generated<JsonValue>;
  push_subscriptions: Generated<JsonValue>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface NotificationTables {
  notifications: NotificationsTable;
  notification_deliveries: NotificationDeliveriesTable;
  notification_preferences: NotificationPreferencesTable;
}
