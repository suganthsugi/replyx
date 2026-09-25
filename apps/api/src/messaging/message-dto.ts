import type { AttachmentRow, AuthorRef, MessageRow } from './messages.repository.js';
import type { MessageAuthorKind, MessageVisibility, ScanStatus } from '../platform-kernel/db/tables/tickets.js';

/**
 * Staff-facing message DTOs (contracts/tickets.yaml `Message`, common.yaml `AttachmentSummary`).
 * Customer payloads are built only by customer-projection.ts and never reuse these.
 */

export interface AttachmentSummaryDto {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  scanStatus: ScanStatus;
  /** API path that authorizes and redirects to a short-lived link; null unless clean. */
  downloadPath: string | null;
}

export interface UserRefDto {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export interface MessageDto {
  id: string;
  ticketId: string;
  author: UserRefDto | null;
  authorKind: MessageAuthorKind;
  visibility: MessageVisibility;
  body: string;
  mentions: UserRefDto[];
  attachments: AttachmentSummaryDto[];
  clientMessageId: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  movedFromTicketId: string | null;
  createdAt: string;
}

/** `/api/v1/attachments` for staff, `/api/v1/customer/attachments` for customers. */
export type DownloadBase = '/api/v1/attachments' | '/api/v1/customer/attachments';

export function toAttachmentSummary(row: AttachmentRow, base: DownloadBase): AttachmentSummaryDto {
  return {
    id: row.id,
    fileName: row.file_name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    scanStatus: row.scan_status,
    downloadPath: row.scan_status === 'clean' ? `${base}/${row.id}/download` : null,
  };
}

export function userRef(author: AuthorRef): UserRefDto {
  // Avatar URLs arrive with attachment-backed avatars.
  return { id: author.id, name: author.name, avatarUrl: null };
}

export function toMessageDto(
  row: MessageRow,
  refs: { authors: ReadonlyMap<string, AuthorRef>; attachments: ReadonlyMap<string, AttachmentRow[]> },
): MessageDto {
  const author = row.author_id === null ? undefined : refs.authors.get(row.author_id);
  return {
    id: row.id,
    ticketId: row.ticket_id,
    author: author === undefined ? null : userRef(author),
    authorKind: row.author_kind,
    visibility: row.visibility,
    body: row.body,
    mentions: row.mentions.flatMap((id) => {
      const mentioned = refs.authors.get(id);
      return mentioned === undefined ? [] : [userRef(mentioned)];
    }),
    attachments: (refs.attachments.get(row.id) ?? []).map((attachment) => toAttachmentSummary(attachment, '/api/v1/attachments')),
    clientMessageId: row.client_message_id,
    deliveredAt: row.delivered_at?.toISOString() ?? null,
    readAt: row.read_at?.toISOString() ?? null,
    movedFromTicketId: row.moved_from_ticket_id,
    createdAt: row.created_at.toISOString(),
  };
}
