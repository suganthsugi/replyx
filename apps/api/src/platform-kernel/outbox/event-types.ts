/**
 * Domain event types (research D7, contracts/realtime-events.md). Names are
 * `<resource>.<past_tense_verb>` in snake_case and are declared here once, with their payload.
 * Modules add their events to `DomainEventMap` when they are built; reuse a name before
 * inventing one.
 *
 * `payload` is what staff streams and consumers see. Events on a `conversation:*` stream also
 * carry a `customerPayload` built by the messaging projector (research D9): the customer event
 * type (`conversation.*`) and its data, since one domain event can mean different things to a
 * customer (a state change can be `conversation.status` or `conversation.resolved`).
 *
 * `ticket.state_changed`, `ticket.assigned` and `ticket.removed_from_view` are for consumers
 * (webhooks, notifications, SLA, audit) besides the staff `ticket.updated` stream event; the
 * property change itself is still reported through `ticket.updated`'s `changes` list.
 */

import type { FriendlyStatusCode } from '../../messaging/customer-projection.js';
import type { MessageDto } from '../../messaging/message-dto.js';
import type { NotificationDto } from '../../notifications/notification-dto.js';
import type { TicketSummaryDto } from '../../tickets/ticket-dto.js';
import type { JsonValue } from '../db/tables/column-types.js';
import type { TicketState } from '../db/tables/tickets.js';

/** Who caused the event. Matches `TenantContext['actor']`; `name` is filled in for display. */
export type EventActor =
  | { kind: 'user'; id: string; name?: string }
  | { kind: 'operator'; id: string; name?: string }
  | { kind: 'automation'; id: string; name?: string }
  | { kind: 'system' };

/** Automation loop guard (data-model.md "automation_rules"). */
export interface EventCause {
  ruleId?: string;
  depth?: number;
  eventId?: string;
}

export interface DomainEventMap {
  /** Sessions deleted by sign-out-all, deactivation or suspension; sockets disconnect. */
  'session.revoked': {
    userId: string;
    sessionIds: string[];
    reason: 'sign_out' | 'sign_out_all' | 'deactivated' | 'deleted' | 'tenant_suspended';
  };
  /** Roles, role permissions, group access, user roles or user status changed (research D6). */
  'access.changed': { accessVersion: string; reason: string };
  /** Sent to a user's stream after their rooms were recomputed (FR-025). */
  'access.revoked': { ticketIds?: string[]; groupIds?: (string | null)[] };
  /**
   * A role's permissions or group access changed (FR-022–FR-026). `groupsLostEdit` (`null` =
   * Ungrouped) is consumed by the tickets module (T142) to unassign owners who lost edit on it.
   */
  'role.updated': { roleId: string; groupsLostEdit: (string | null)[] };
  /** The tenant was suspended; every socket of the tenant disconnects. */
  'tenant.suspended': Record<string, never>;
  /** Deactivated by an admin (FR-008): tickets consumers unassign the user's open tickets. */
  'user.deactivated': { userId: string };
  /** An admin asked for the user's data to be erased; the erasure job does it (T062). */
  'user.erasure_requested': { userId: string };
  /** A ticket appeared (customer message, follow-up, staff start): staff list rooms. */
  'ticket.created': { ticket: TicketSummaryDto };
  /** Properties or state changed; `changes` lists each field once. */
  'ticket.updated': { ticket: TicketSummaryDto; changes: TicketFieldChange[] };
  /** Moved from resolved or closed back to open (consumers: notifications, SLA). */
  'ticket.reopened': { ticketId: string; from: TicketState };
  /** Entered closed (consumers: CSAT, retention, SLA). */
  'ticket.closed': { ticketId: string };
  /** An explicit agent state change (data-model.md "Ticket state machine"). */
  'ticket.state_changed': { ticketId: string; from: TicketState; to: TicketState };
  /** The owner changed, including to or from unassigned (webhook-events.md `ticket.assigned`). */
  'ticket.assigned': { ticketId: string; previousOwnerId: string | null; ownerId: string | null };
  /** Left a group's list room: moved, deleted or merged (contract "Staff events"). */
  'ticket.removed_from_view': { ticketId: string; reason: 'moved' | 'deleted' | 'merged' };
  /**
   * A `pending_reminder` date passed; the state stays `pending_reminder` (T144, FR-034,
   * research D11). Fires once per `pending_until` (`tickets.reminder_notified_at`, migration
   * 0009c) — not on every 30 s sweep — and again if a later date is set while still pending.
   */
  'ticket.reminder_reached': { ticketId: string; ownerId: string | null };
  /** A message or internal note was added; the staff payload is the full `Message`. */
  'message.created': MessageDto;
  /** A customer message was moved to another of the same customer's tickets (FR-042). */
  'message.moved': MessageDto;
  /** The customer read support's replies up to a message (FR-053). */
  'message.read': { ticketId: string; upToMessageId: string; readAt: string };
  /** A customer message's receipt changed: shown as ✓✓ in the chat (FR-053). */
  'message.delivery_updated': { ticketId: string; messageId: string; delivery: 'delivered' | 'read' };
  /** A file was uploaded to quarantine; the attachments consumer scans it (FR-047). */
  'attachment.uploaded': { attachmentId: string };
  /** The scan finished: clean files can be downloaded, blocked ones are gone (FR-047). */
  'attachment.scanned': { attachmentId: string; messageId: string | null; scanStatus: 'clean' | 'blocked' };
  /** The customer's friendly status changed (FR-052); customer stream only. */
  'conversation.status_changed': { customerId: string; status: FriendlyStatusCode };
  /** A ticket was resolved: the customer's thread gets the resolved marker (FR-035); customer stream only. */
  'conversation.resolved': { customerId: string; ticketId: string };
  /**
   * A hint on the viewer's `views` stream to refetch `GET /views/counts` (research D13); sent by
   * the counts notifier at most once per 500 ms per viewer, never carries counts itself.
   */
  'views.counts_changed': { viewIds: string[] };
  /** A new in-app notification on the recipient's `user` stream (research D20). */
  'notification.created': NotificationDto;
  /** A burst grew an unread entry instead of adding one (FR-082). */
  'notification.updated': { id: string; count: number };
  /** Marked read in one session; every session of the user updates (FR-083). */
  'notification.read': { ids: string[] | 'all'; unreadCount: number };
}

export interface TicketFieldChange {
  field: string;
  old: JsonValue;
  new: JsonValue;
}

export type DomainEventType = keyof DomainEventMap;

/** What customer sockets receive for an event (contracts/realtime-events.md "Customer events"). */
export interface CustomerProjection {
  type: `conversation.${string}`;
  data: JsonValue;
}

export function isCustomerProjection(value: unknown): value is CustomerProjection {
  if (typeof value !== 'object' || value === null) return false;
  const { type, data } = value as { type?: unknown; data?: unknown };
  return typeof type === 'string' && type.startsWith('conversation.') && data !== undefined;
}

/**
 * Events the gateways act on besides delivering them (T037/T039): the relay also broadcasts
 * them to every api process with `serverSideEmit`.
 */
export const CONTROL_EVENT_TYPES: ReadonlySet<DomainEventType> = new Set([
  'session.revoked',
  'tenant.suspended',
  'access.changed',
]);

export type DomainEventPayload<T extends DomainEventType> = DomainEventMap[T];

/**
 * Stream keys are tenant-less; the relay and gateway add `t:{tenantId}:`
 * (realtime-events skill rule 4).
 */
export type StreamKey =
  | `user:${string}`
  | `views:${string}`
  | `ticket:${string}`
  | `tickets:group:${string}`
  | `conversation:${string}`
  /** Tenant-wide control stream: `access.changed`, `tenant.suspended` (gateway only). */
  | 'tenant';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const STREAM_PATTERN = new RegExp(
  `^(?:(?:user|views|ticket|conversation):${UUID}|tickets:group:(?:${UUID}|ungrouped)|tenant)$`,
);

export function isStreamKey(value: string): value is StreamKey {
  return STREAM_PATTERN.test(value);
}

export function isCustomerStream(stream: StreamKey): boolean {
  return stream.startsWith('conversation:');
}

/**
 * The stream name clients see in the envelope and send back in `sync` (contract "Streams"):
 * a socket only ever sees its own `user`, `views` and `conversation` streams, so those drop the
 * id; `tickets:group:*` rooms are all the `tickets` stream; `ticket:{id}` is kept.
 */
export function clientStream(stream: StreamKey): string {
  if (stream.startsWith('user:')) return 'user';
  if (stream.startsWith('views:')) return 'views';
  if (stream.startsWith('conversation:')) return 'conversation';
  if (stream.startsWith('tickets:group:')) return 'tickets';
  return stream;
}
