import type { ColumnType, Generated, GeneratedTimestamp, JsonValue, Timestamp } from './column-types.js';

/** Migration 0008_tickets_messages (data-model.md "Tickets"). */

export type TicketState = 'new' | 'open' | 'pending_reminder' | 'pending_close' | 'resolved' | 'closed';
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';
export type WaitingOn = 'support' | 'customer';
export type TicketOrigin = 'customer_message' | 'staff_started' | 'split' | 'follow_up';

export interface TicketsTable {
  id: Generated<string>;
  tenant_id: string;
  /** bigint: pg returns it as a string. */
  number: ColumnType<string, number | string, number | string>;
  title: string;
  customer_id: string;
  /** null = Ungrouped. */
  group_id: string | null;
  owner_id: string | null;
  priority: Generated<TicketPriority>;
  state: TicketState;
  pending_until: Timestamp | null;
  auto_close_at: Timestamp | null;
  waiting_on: Generated<WaitingOn>;
  origin: TicketOrigin;
  merged_into_id: string | null;
  resolved_at: Timestamp | null;
  closed_at: Timestamp | null;
  last_customer_message_at: Timestamp | null;
  last_agent_reply_at: Timestamp | null;
  first_agent_reply_at: Timestamp | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type MessageAuthorKind = 'customer' | 'staff' | 'system' | 'automation';
export type MessageVisibility = 'public' | 'internal';

/** Immutable except for moves (FR-042) and receipts; a trigger rejects edits of body/visibility. */
export interface TicketMessagesTable {
  id: Generated<string>;
  tenant_id: string;
  ticket_id: string;
  author_id: string | null;
  author_kind: MessageAuthorKind;
  visibility: MessageVisibility;
  body: string;
  client_message_id: string | null;
  mentions: Generated<string[]>;
  moved_from_ticket_id: string | null;
  delivered_at: Timestamp | null;
  read_at: Timestamp | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type TicketLinkKind = 'follow_up_of' | 'related' | 'duplicate_of' | 'merged_into' | 'split_from';

/** `to_ticket_id` is null only for a retention tombstone (`removed_reason = 'retention'`). */
export interface TicketLinksTable {
  id: Generated<string>;
  tenant_id: string;
  from_ticket_id: string;
  to_ticket_id: string | null;
  kind: TicketLinkKind;
  removed_reason: 'retention' | null;
  created_by: string | null;
  created_at: GeneratedTimestamp;
}

export type HistoryActorKind = 'user' | 'operator' | 'system' | 'automation' | 'routing';

/** Append-only (the app role has SELECT and INSERT). */
export interface TicketHistoryTable {
  id: Generated<string>;
  tenant_id: string;
  ticket_id: string;
  actor_id: string | null;
  actor_kind: HistoryActorKind;
  field: string;
  old_value: JsonValue | null;
  new_value: JsonValue | null;
  event_id: string | null;
  created_at: GeneratedTimestamp;
}

export type ScanStatus = 'pending' | 'clean' | 'blocked';

/** `storage_key` never leaves the API; `message_id` is null until the upload is sent. */
export interface AttachmentsTable {
  id: Generated<string>;
  tenant_id: string;
  message_id: string | null;
  uploaded_by: string;
  file_name: string;
  content_type: string;
  /** bigint: pg returns it as a string. */
  size_bytes: ColumnType<string, number | string, number | string>;
  storage_key: string;
  scan_status: Generated<ScanStatus>;
  scanned_at: Timestamp | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface TicketTables {
  tickets: TicketsTable;
  ticket_messages: TicketMessagesTable;
  ticket_links: TicketLinksTable;
  ticket_history: TicketHistoryTable;
  attachments: AttachmentsTable;
}
