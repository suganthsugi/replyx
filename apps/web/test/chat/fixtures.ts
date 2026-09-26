import { vi } from 'vitest';

import type { ConversationMessage, CustomerMe, GetConversation200, ThreadItem } from '../../src/api/generated/model';
import type { Envelope, RealtimeSocket } from '../../src/data/socket';

export const me: CustomerMe = { id: 'c1', name: 'Cam Customer', email: 'cam@example.test', hasPassword: false, emailOnReply: true };

export function supportMessage(id: string, body: string, createdAt = '2026-09-26T09:01:00.000Z'): ConversationMessage {
  return {
    id,
    from: { kind: 'support', name: 'Ann Agent', avatarUrl: null },
    body,
    attachments: [],
    clientMessageId: null,
    delivery: 'delivered',
    createdAt,
  };
}

export function myMessage(id: string, body: string, clientMessageId: string | null = null, createdAt = '2026-09-26T09:00:00.000Z'): ConversationMessage {
  return { id, from: { kind: 'me' }, body, attachments: [], clientMessageId, delivery: 'read', createdAt };
}

/**
 * A thread with a resolved earlier issue and an active one. Each item also carries the ticket
 * fields a buggy or hostile API might leak (number, state, group, owner, priority, SLA, an
 * internal note body): the UI must render none of them.
 */
const leaky = {
  ticketId: '0192f3c4-0000-7000-8000-000000000001',
  ticketNumber: 1001,
  state: 'pending_close',
  group: { id: 'g1', name: 'Billing Escalations' },
  owner: { id: 'u9', name: 'Olga Owner' },
  priority: 'urgent',
  sla: { status: 'breached' },
  internalNote: 'Internal note: refund abuse suspected',
};

export const thread: ThreadItem[] = [
  { type: 'message', message: { ...myMessage('m1', 'My invoice link is broken.', 'cm-1', '2026-09-20T09:00:00.000Z'), ...leaky } },
  { type: 'message', message: { ...supportMessage('m2', 'Here is a fresh link.', '2026-09-20T09:05:00.000Z'), ...leaky } },
  { type: 'resolved_marker', marker: { id: 'resolved-abc', text: 'Glad we could help, just reply if you need anything else', createdAt: '2026-09-20T10:00:00.000Z', ...leaky } },
  { type: 'message', message: { ...myMessage('m3', 'My new order has not shipped.', 'cm-3'), ...leaky } },
  { type: 'message', message: { ...supportMessage('m4', 'Checking with the warehouse now.'), ...leaky } },
] as ThreadItem[];

export function conversationPage(items: ThreadItem[], overrides: Partial<GetConversation200> = {}): GetConversation200 {
  return {
    items,
    olderCursor: null,
    status: { code: 'answered', text: 'Support has replied' },
    streamSeq: 10,
    ...overrides,
  };
}

/** A socket.io stand-in: tests fire server events and read what the client emitted. */
export class FakeSocket implements RealtimeSocket {
  connected = false;
  handlers = new Map<string, ((...args: never[]) => void)[]>();
  emitted: [string, unknown][] = [];
  disconnect = vi.fn(() => {
    this.connected = false;
  });

  on(event: string, listener: (...args: never[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
  }
  emit(event: string, ...args: unknown[]) {
    this.emitted.push([event, args[0]]);
  }
  timeout() {
    return {
      emitWithAck: (event: string, payload: unknown) => {
        this.emitted.push([event, payload]);
        return Promise.resolve(event === 'sync' ? { ok: true, upToSeq: 10, resyncRequired: [] } : { ok: true });
      },
    };
  }
  connect() {}
  fire(event: string, payload?: unknown) {
    for (const handler of this.handlers.get(event) ?? []) (handler as (p: unknown) => void)(payload);
  }
  open() {
    this.connected = true;
    this.fire('connect');
  }
  drop() {
    this.connected = false;
    this.fire('disconnect');
  }
}

let seq = 10;

export function conversationEvent(type: string, data: unknown): Envelope {
  seq += 1;
  return { id: `evt-${seq}`, seq, stream: 'conversation', type, occurredAt: new Date().toISOString(), actor: { kind: 'system' }, data };
}
