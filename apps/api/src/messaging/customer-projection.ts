import { createHash } from 'node:crypto';

import type { AttachmentRow, AuthorRef, MessageRow } from './messages.repository.js';
import type { CustomerProjection } from '../platform-kernel/outbox/event-types.js';

/**
 * The customer projection (research D9, contracts/customer.yaml, realtime-events.md "Customer
 * events"). The only code allowed to build what a customer receives, over HTTP or a socket: a
 * public message becomes a `ConversationMessage`, a resolved ticket becomes a `ResolvedMarker`,
 * and the conversation's state becomes a `FriendlyStatus`.
 *
 * Nothing here carries a ticket id, number, state, group, owner, priority, SLA data or internal
 * note: the shapes have no such fields, internal messages are refused outright, and marker ids
 * are opaque hashes rather than ticket ids. Types are plain aliases so they are JSON values.
 */

export type FriendlyStatusCode = 'idle' | 'received' | 'replying' | 'answered';

export type FriendlyStatus = { code: FriendlyStatusCode; text: string };

const STATUS_TEXT: Readonly<Record<FriendlyStatusCode, string>> = {
  idle: "Send us a message and we'll get back to you",
  received: 'Support has your message',
  replying: 'Support is replying',
  answered: 'Support has replied',
};

export type CustomerAttachment = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  scanStatus: 'pending' | 'clean' | 'blocked';
  downloadPath: string | null;
};

export type MessageSender = { kind: 'me' } | { kind: 'support'; name: string; avatarUrl: string | null } | { kind: 'system' };

export type Delivery = 'sent' | 'delivered' | 'read';

export type ConversationMessage = {
  id: string;
  from: MessageSender;
  body: string;
  attachments: CustomerAttachment[];
  clientMessageId: string | null;
  delivery: Delivery;
  createdAt: string;
};

export type ResolvedMarker = { id: string; text: string; createdAt: string };

export type ThreadItem = { type: 'message'; message: ConversationMessage } | { type: 'resolved_marker'; marker: ResolvedMarker };

export const RESOLVED_MARKER_TEXT = 'Glad we could help, just reply if you need anything else';

export function friendlyStatus(code: FriendlyStatusCode): FriendlyStatus {
  return { code, text: STATUS_TEXT[code] };
}

export function deliveryOf(row: Pick<MessageRow, 'delivered_at' | 'read_at'>): Delivery {
  if (row.read_at !== null) return 'read';
  return row.delivered_at !== null ? 'delivered' : 'sent';
}

export function customerAttachment(row: AttachmentRow): CustomerAttachment {
  return {
    id: row.id,
    fileName: row.file_name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    scanStatus: row.scan_status,
    downloadPath: row.scan_status === 'clean' ? `/api/v1/customer/attachments/${row.id}/download` : null,
  };
}

/**
 * A public message as the customer sees it. Throws on an internal note: no caller may get this
 * far with one, and failing loudly beats leaking it.
 */
export function toConversationMessage(
  row: MessageRow,
  customerId: string,
  refs: { authors: ReadonlyMap<string, AuthorRef>; attachments: ReadonlyMap<string, AttachmentRow[]> },
): ConversationMessage {
  if (row.visibility !== 'public') throw new Error('Internal notes are never projected to customers');
  let from: MessageSender;
  if (row.author_id === customerId) from = { kind: 'me' };
  else if (row.author_kind === 'staff' && row.author_id !== null) {
    from = { kind: 'support', name: refs.authors.get(row.author_id)?.name ?? 'Support', avatarUrl: null };
  } else from = { kind: 'system' };
  return {
    id: row.id,
    from,
    body: row.body,
    attachments: (refs.attachments.get(row.id) ?? []).map(customerAttachment),
    // Only the customer's own messages carry their idempotency key (optimistic send matching).
    clientMessageId: from.kind === 'me' ? row.client_message_id : null,
    delivery: from.kind === 'me' ? deliveryOf(row) : 'delivered',
    createdAt: row.created_at.toISOString(),
  };
}

/** An opaque, stable id for a ticket's resolution: never the ticket id itself. */
export function markerId(tenantId: string, ticketId: string, at: Date): string {
  const digest = createHash('sha256').update(`${tenantId}:${ticketId}:${at.toISOString()}`).digest('hex');
  return `resolved-${digest.slice(0, 24)}`;
}

export function resolvedMarker(tenantId: string, ticketId: string, at: Date): ResolvedMarker {
  return { id: markerId(tenantId, ticketId, at), text: RESOLVED_MARKER_TEXT, createdAt: at.toISOString() };
}

/** Customer stream payloads for outbox events. */
export const customerEvents = {
  message(message: ConversationMessage): CustomerProjection {
    return { type: 'conversation.message', data: message };
  },
  delivery(messageId: string, delivery: 'delivered' | 'read'): CustomerProjection {
    return { type: 'conversation.delivery', data: { messageId, delivery } };
  },
  /** A scan finished: `messageId` is null while the upload hasn't been sent yet. */
  attachment(messageId: string | null, attachment: CustomerAttachment): CustomerProjection {
    return { type: 'conversation.attachment', data: { messageId, attachment } };
  },
  resolved(marker: ResolvedMarker): CustomerProjection {
    return { type: 'conversation.resolved', data: marker };
  },
  status(code: FriendlyStatusCode): CustomerProjection {
    return { type: 'conversation.status', data: friendlyStatus(code) };
  },
};
