/**
 * What the chat components render: the customer conversation projection (contracts/customer.yaml)
 * plus the states only the page knows about (a message still sending, or one that failed). There
 * is deliberately no ticket id, number, state, group, owner or internal note here (constitution
 * XI, ui-components rule 7): the components can't show what they are never given.
 */

export type ChatDelivery = 'sending' | 'failed' | 'sent' | 'delivered' | 'read';

export interface ChatAttachment {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  scanStatus: 'pending' | 'clean' | 'blocked';
  /** API path that redirects to a short-lived download link; set once the file is clean. */
  downloadPath?: string | null;
}

export interface ChatMessage {
  kind: 'message';
  /** The server id, or the `clientMessageId` while the message is still local. */
  id: string;
  from: 'me' | 'support' | 'system';
  /** The agent's display name and avatar on support messages. */
  sender?: { name: string; avatarUrl?: string | null };
  body: string;
  attachments: ChatAttachment[];
  delivery: ChatDelivery;
  createdAt: string;
  clientMessageId?: string | null;
  /** Why a `failed` message wasn't sent. */
  error?: string;
}

export interface ChatResolvedMarker {
  kind: 'resolved';
  id: string;
  text: string;
  createdAt: string;
}

export type ChatItem = ChatMessage | ChatResolvedMarker;

export interface ChatStatus {
  code: 'idle' | 'received' | 'replying' | 'answered';
  text: string;
}

export interface TypingIndicator {
  name: string;
  avatarUrl?: string | null;
}

/** A file picked in the composer, uploading or ready to go with the next message. */
export interface ComposerAttachment {
  localId: string;
  fileName: string;
  status: 'uploading' | 'ready' | 'failed';
  /** 0–100 while uploading. */
  progress: number;
  error?: string;
}
