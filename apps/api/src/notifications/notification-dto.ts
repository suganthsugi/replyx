import type { NotificationEventType } from '../platform-kernel/db/tables/notifications.js';

/** contracts/operations.yaml `Notification`: an entry in the user's notification center. */
export interface NotificationDto {
  id: string;
  eventType: NotificationEventType;
  title: string;
  summary: string | null;
  ticketId: string | null;
  /** How many events this entry groups (FR-082). */
  count: number;
  read: boolean;
  createdAt: string;
}

export interface NotificationRow {
  id: string;
  event_type: NotificationEventType;
  title: string;
  summary: string | null;
  ticket_id: string | null;
  count: number;
  read_at: Date | null;
  created_at: Date;
}

export function toNotificationDto(row: NotificationRow): NotificationDto {
  return {
    id: row.id,
    eventType: row.event_type,
    title: row.title,
    summary: row.summary,
    ticketId: row.ticket_id,
    count: row.count,
    read: row.read_at !== null,
    createdAt: row.created_at.toISOString(),
  };
}
