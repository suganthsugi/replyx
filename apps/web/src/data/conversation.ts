import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getConversation, sendCustomerMessage, useMarkConversationRead } from '../api/generated/customer/customer';

import { mapError } from './errors';
import { useRealtime } from './realtime';

import type {
  AttachmentSummary,
  ConversationMessage,
  FriendlyStatus,
  GetConversation200,
  ResolvedMarker,
} from '../api/generated/model';
import type { ChatAttachment, ChatItem, ChatMessage, ChatStatus, TypingIndicator } from '../components/chat/types';

/**
 * The customer's conversation (data-hooks rule 8: the `customer` tag and the `conversation`
 * stream only, never ticket hooks or keys).
 *
 * - `useConversation()`: the thread, newest page first in the cache, loading older pages on
 *   demand (`GET /customer/conversation?before=`), merged with messages still being sent.
 * - `useSendMessage()`: optimistic send. Each message gets a `clientMessageId` once and keeps it
 *   through retries, so the API answers a repeat with the original instead of a duplicate.
 * - `useConversationEvents()`: `conversation.*` envelopes patch the cache (`RealtimeClient`
 *   dedupes and replays them after a reconnect).
 * - `useSupportTyping()` / `useTypingSignal()`: ephemeral typing both ways.
 * - `useMarkRead()`: read receipts for support replies the customer has on screen.
 */

export const conversationKeys = {
  all: ['conversation'] as const,
  thread: () => [...conversationKeys.all, 'thread'] as const,
  outbox: () => [...conversationKeys.all, 'outbox'] as const,
};

const PAGE_SIZE = 50;
const STREAM = 'conversation';

type ThreadData = InfiniteData<GetConversation200, string | undefined>;

/**
 * A message the customer sent that the API hasn't confirmed yet (or refused). `sent` keeps the
 * entry around (with the server's `message`) until `buildItems` sees a message in the fetched
 * thread with the same `clientMessageId` — the thread query may still be loading, or its cached
 * snapshot may predate the POST, so removing the entry as soon as the POST resolves can drop the
 * message from the UI until a `conversation.message` event arrives.
 */
export interface OutboxEntry {
  clientMessageId: string;
  body: string;
  attachments: AttachmentSummary[];
  createdAt: string;
  status: 'sending' | 'sent' | 'failed';
  error?: string;
  message?: ConversationMessage;
}

export function useConversation() {
  const client = useRealtime();
  // The paged thread is an infinite query over the generated `getConversation` fetcher: orval
  // generates plain queries only, and `before` pagination needs the page params.
  const query = useInfiniteQuery<GetConversation200, Error, ThreadData, ReturnType<typeof conversationKeys.thread>, string | undefined>({
    queryKey: conversationKeys.thread(),
    queryFn: ({ pageParam, signal }) => getConversation({ limit: PAGE_SIZE, ...(pageParam === undefined ? {} : { before: pageParam }) }, { signal }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.olderCursor ?? undefined,
  });
  const outbox = useOutbox();

  // The snapshot is current up to `streamSeq`: a reconnect only needs what came after it.
  const streamSeq = query.data?.pages[0]?.streamSeq;
  useEffect(() => {
    if (client !== undefined && streamSeq !== undefined) client.seedCursor(STREAM, streamSeq);
  }, [client, streamSeq]);

  const items = useMemo(() => buildItems(query.data, outbox), [query.data, outbox]);
  const status: ChatStatus | undefined = query.data?.pages[0]?.status;

  // Once the thread actually contains a `sent` entry's message, `buildItems` already dedupes it;
  // drop it from the outbox too so it doesn't linger forever in memory.
  const queryClient = useQueryClient();
  useEffect(() => {
    if (query.data === undefined) return;
    const present = new Set(
      [...query.data.pages].reverse().flatMap((page) => page.items).flatMap((item) => (item.type === 'message' && item.message.clientMessageId ? [item.message.clientMessageId] : [])),
    );
    const stale = outbox.some((entry) => entry.status === 'sent' && present.has(entry.clientMessageId));
    if (stale) setOutbox(queryClient, (entries) => entries.filter((entry) => !(entry.status === 'sent' && present.has(entry.clientMessageId))));
  }, [query.data, outbox, queryClient]);

  return {
    items,
    status,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error ? mapError(query.error) : undefined,
    refetch: query.refetch,
    hasOlder: query.hasNextPage,
    loadingOlder: query.isFetchingNextPage,
    loadOlder: useCallback(() => void query.fetchNextPage(), [query]),
  };
}

function useOutbox(): OutboxEntry[] {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: conversationKeys.outbox(),
    // Local only: written by `useSendMessage`, never fetched.
    queryFn: () => queryClient.getQueryData<OutboxEntry[]>(conversationKeys.outbox()) ?? [],
    initialData: [] as OutboxEntry[],
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data;
}

function setOutbox(queryClient: QueryClient, update: (entries: OutboxEntry[]) => OutboxEntry[]): void {
  queryClient.setQueryData<OutboxEntry[]>(conversationKeys.outbox(), (entries = []) => update(entries));
}

export function useSendMessage() {
  const queryClient = useQueryClient();
  const [rateLimitedUntil, setRateLimitedUntil] = useState<number | undefined>();

  const deliver = useCallback(
    async (entry: OutboxEntry) => {
      setOutbox(queryClient, (entries) => [
        ...entries.filter((existing) => existing.clientMessageId !== entry.clientMessageId),
        { ...entry, status: 'sending', error: undefined },
      ]);
      try {
        const message = await sendCustomerMessage({
          body: entry.body,
          clientMessageId: entry.clientMessageId,
          ...(entry.attachments.length === 0 ? {} : { attachmentIds: entry.attachments.map((attachment) => attachment.id) }),
        });
        const applied = patchThread(queryClient, (data) => upsertMessage(data, message));
        // Keep the entry as `sent` (with the server message) rather than removing it outright:
        // the thread query may still be loading, or its cached snapshot may predate this send, so
        // `patchThread` was a no-op and the message would otherwise vanish until a socket event
        // catches up. `buildItems`'s `sent` dedupe drops it once the thread has it.
        setOutbox(queryClient, (entries) =>
          entries.map((existing) => (existing.clientMessageId === entry.clientMessageId ? { ...existing, status: 'sent', message, error: undefined } : existing)),
        );
        if (!applied) void queryClient.invalidateQueries({ queryKey: conversationKeys.thread() });
      } catch (caught) {
        const error = mapError(caught);
        if (error.code === 'RATE_LIMITED') setRateLimitedUntil(Date.now() + (error.retryAfter ?? 30) * 1000);
        setOutbox(queryClient, (entries) =>
          entries.map((existing) => (existing.clientMessageId === entry.clientMessageId ? { ...existing, status: 'failed', error: error.message } : existing)),
        );
      }
    },
    [queryClient],
  );

  const send = useCallback(
    (body: string, attachments: AttachmentSummary[] = []) =>
      deliver({ clientMessageId: crypto.randomUUID(), body, attachments, createdAt: new Date().toISOString(), status: 'sending' }),
    [deliver],
  );

  /** Sends a failed message again with the same `clientMessageId`. */
  const retry = useCallback(
    (clientMessageId: string) => {
      const entry = queryClient.getQueryData<OutboxEntry[]>(conversationKeys.outbox())?.find((existing) => existing.clientMessageId === clientMessageId);
      return entry === undefined ? Promise.resolve() : deliver(entry);
    },
    [queryClient, deliver],
  );

  return { send, retry, rateLimitedUntil };
}

/** Wires the `conversation` stream into the cache; mount once per signed-in customer. */
export function useConversationEvents(): void {
  const client = useRealtime();
  useEffect(() => {
    if (client === undefined) return undefined;
    client.registerStreamKeys(STREAM, () => [conversationKeys.thread()]);
    const off = [
      client.onEvent('conversation.message', (envelope, queryClient) => {
        const message = envelope.data as ConversationMessage;
        patchThread(queryClient, (data) => upsertMessage(data, message));
        // Our own message from another device (or its echo): nothing is pending any more.
        if (message.clientMessageId) setOutbox(queryClient, (entries) => entries.filter((entry) => entry.clientMessageId !== message.clientMessageId));
      }),
      client.onEvent('conversation.delivery', (envelope, queryClient) => {
        const { messageId, delivery } = envelope.data as { messageId: string; delivery: 'delivered' | 'read' };
        patchThread(queryClient, (data) => patchMessage(data, messageId, (message) => ({ ...message, delivery: laterDelivery(message.delivery, delivery) })));
      }),
      client.onEvent('conversation.attachment', (envelope, queryClient) => {
        const { messageId, attachment } = envelope.data as { messageId: string | null; attachment: AttachmentSummary };
        if (messageId === null) return;
        patchThread(queryClient, (data) =>
          patchMessage(data, messageId, (message) => ({
            ...message,
            attachments: message.attachments.map((existing) => (existing.id === attachment.id ? attachment : existing)),
          })),
        );
      }),
      client.onEvent('conversation.status', (envelope, queryClient) => {
        const status = envelope.data as FriendlyStatus;
        patchThread(queryClient, (data) => withFirstPage(data, (page) => ({ ...page, status })));
      }),
      client.onEvent('conversation.resolved', (envelope, queryClient) => {
        const marker = envelope.data as ResolvedMarker;
        patchThread(queryClient, (data) => appendItem(data, { type: 'resolved_marker', marker }));
      }),
    ];
    return () => off.forEach((unsubscribe) => unsubscribe());
  }, [client]);
}

/** How long a "typing" signal counts without a refresh or a stop. */
const TYPING_TIMEOUT_MS = 10_000;

/** Who from support is typing right now, from `conversation.typing` signals. */
export function useSupportTyping(): TypingIndicator | null {
  const client = useRealtime();
  const [typing, setTyping] = useState<TypingIndicator | null>(null);
  useEffect(() => {
    if (client === undefined) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      clearTimeout(timer);
      setTyping(null);
    };
    const offTyping = client.onEphemeral('conversation.typing', (signal) => {
      const data = signal.data as { name: string; avatarUrl: string | null; state: 'start' | 'stop' };
      if (data.state === 'stop') return stop();
      clearTimeout(timer);
      setTyping({ name: data.name, avatarUrl: data.avatarUrl });
      timer = setTimeout(stop, TYPING_TIMEOUT_MS);
    });
    // The reply landing ends the typing, whether or not a stop arrives.
    const offMessage = client.onEvent('conversation.message', (envelope) => {
      if ((envelope.data as ConversationMessage).from.kind === 'support') stop();
    });
    return () => {
      clearTimeout(timer);
      offTyping();
      offMessage();
    };
  }, [client]);
  return typing;
}

/** Stop after this long without a keystroke; refresh "start" at most this often. */
const TYPING_IDLE_MS = 4_000;
const TYPING_REFRESH_MS = 10_000;

/**
 * `customer.typing` for staff. `onTyping` on each keystroke sends `start` (at most every 10 s)
 * and `stop` after 4 s of quiet; `stopTyping` on send.
 */
export function useTypingSignal() {
  const client = useRealtime();
  const lastStart = useRef(0);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const stopTyping = useCallback(() => {
    clearTimeout(idle.current);
    if (lastStart.current === 0) return;
    lastStart.current = 0;
    client?.send('customer.typing', { state: 'stop' });
  }, [client]);

  const onTyping = useCallback(() => {
    if (client === undefined) return;
    const now = Date.now();
    if (now - lastStart.current > TYPING_REFRESH_MS) {
      lastStart.current = now;
      client.send('customer.typing', { state: 'start' });
    }
    clearTimeout(idle.current);
    idle.current = setTimeout(stopTyping, TYPING_IDLE_MS);
  }, [client, stopTyping]);

  useEffect(() => () => clearTimeout(idle.current), []);
  return { onTyping, stopTyping };
}

/**
 * Marks support replies read (`POST /customer/messages/read`) up to the newest one while the page
 * is visible, and again when the customer comes back to the tab.
 */
export function useMarkRead(items: ChatItem[]): void {
  const { mutate } = useMarkConversationRead();
  const lastMarked = useRef<string | undefined>(undefined);
  const newestSupport = items.findLast((item): item is ChatMessage => item.kind === 'message' && item.from === 'support')?.id;

  useEffect(() => {
    if (newestSupport === undefined) return undefined;
    const mark = () => {
      if (document.visibilityState !== 'visible' || lastMarked.current === newestSupport) return;
      lastMarked.current = newestSupport;
      mutate({ data: { upToMessageId: newestSupport } }, { onError: () => (lastMarked.current = undefined) });
    };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [newestSupport, mutate]);
}

/** Whether the conversation socket is connected (false while reconnecting). */
export function useConnection(): boolean {
  const client = useRealtime();
  const [connected, setConnected] = useState(true);
  useEffect(() => {
    if (client === undefined) return undefined;
    return client.onConnectionChange(setConnected);
  }, [client]);
  return connected;
}

// Cache helpers. Pages are newest first; items within a page are oldest first.

/** Returns whether the thread cache had data to patch. */
function patchThread(queryClient: QueryClient, update: (data: ThreadData) => ThreadData): boolean {
  let applied = false;
  queryClient.setQueryData<ThreadData>(conversationKeys.thread(), (data) => {
    if (data === undefined) return data;
    applied = true;
    return update(data);
  });
  return applied;
}

function withFirstPage(data: ThreadData, update: (page: GetConversation200) => GetConversation200): ThreadData {
  const [first, ...rest] = data.pages;
  return first === undefined ? data : { ...data, pages: [update(first), ...rest] };
}

function appendItem(data: ThreadData, item: GetConversation200['items'][number]): ThreadData {
  return withFirstPage(data, (page) => ({ ...page, items: [...page.items, item] }));
}

function upsertMessage(data: ThreadData, message: ConversationMessage): ThreadData {
  const exists = data.pages.some((page) => page.items.some((item) => item.type === 'message' && item.message.id === message.id));
  if (!exists) return appendItem(data, { type: 'message', message });
  return patchMessage(data, message.id, (current) => ({ ...message, delivery: laterDelivery(current.delivery, message.delivery) }));
}

function patchMessage(data: ThreadData, id: string, update: (message: ConversationMessage) => ConversationMessage): ThreadData {
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((item) => (item.type === 'message' && item.message.id === id ? { ...item, message: update(item.message) } : item)),
    })),
  };
}

const DELIVERY_ORDER = ['sent', 'delivered', 'read'] as const;

/** Delivery only moves forward: a late "delivered" never undoes "read". */
function laterDelivery(current: ConversationMessage['delivery'], next: ConversationMessage['delivery']): ConversationMessage['delivery'] {
  return DELIVERY_ORDER.indexOf(next) > DELIVERY_ORDER.indexOf(current) ? next : current;
}

function toChatAttachment(attachment: AttachmentSummary): ChatAttachment {
  return { ...attachment, downloadPath: attachment.downloadPath ?? null };
}

function toChatMessage(message: ConversationMessage): ChatMessage {
  return {
    kind: 'message',
    // Own messages keep their client id, so the bubble stays the same element from optimistic to
    // confirmed.
    id: message.clientMessageId ?? message.id,
    from: message.from.kind,
    ...(message.from.kind === 'support' ? { sender: { name: message.from.name ?? 'Support', avatarUrl: message.from.avatarUrl ?? null } } : {}),
    body: message.body,
    attachments: message.attachments.map(toChatAttachment),
    delivery: message.delivery,
    createdAt: message.createdAt,
    clientMessageId: message.clientMessageId,
  };
}

function buildItems(data: ThreadData | undefined, outbox: OutboxEntry[]): ChatItem[] {
  const items: ChatItem[] = [];
  const sent = new Set<string>();
  for (const page of [...(data?.pages ?? [])].reverse()) {
    for (const item of page.items) {
      if (item.type === 'message') {
        if (item.message.clientMessageId) sent.add(item.message.clientMessageId);
        items.push(toChatMessage(item.message));
      } else {
        items.push({ kind: 'resolved', ...item.marker });
      }
    }
  }
  for (const entry of outbox) {
    if (sent.has(entry.clientMessageId)) continue;
    if (entry.status === 'sent' && entry.message) {
      items.push(toChatMessage(entry.message));
      continue;
    }
    items.push({
      kind: 'message',
      id: entry.clientMessageId,
      from: 'me',
      body: entry.body,
      attachments: entry.attachments.map(toChatAttachment),
      delivery: entry.status,
      createdAt: entry.createdAt,
      clientMessageId: entry.clientMessageId,
      ...(entry.error === undefined ? {} : { error: entry.error }),
    });
  }
  return items;
}
