import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';

import { listTicketMessages, postTicketMessage, useMoveTicketMessage as useMoveTicketMessageMutation } from '../api/generated/tickets/tickets';

import { mapError } from './errors';

import type { RealtimeClient } from './socket';
import type { ListTicketMessages200, Message, PostTicketMessageBodyVisibility } from '../api/generated/model';

/**
 * A ticket's message timeline (US6): public replies, internal notes and the customer's own
 * messages. Components never import `api/generated/tickets` directly (data-hooks rule 6).
 *
 * `useSendTicketMessage` follows the outbox pattern in `data/conversation.ts`: each send gets a
 * `clientMessageId` once and keeps it through retries, so a repeat gets the message already
 * stored for it back instead of a duplicate. Pages newest-chunk-first in the cache (oldest to
 * newest within a page), same shape as `conversation.ts`'s thread.
 */

export const messageKeys = {
  all: ['ticket-messages'] as const,
  list: (ticketId: string, includeMerged = false) => [...messageKeys.all, ticketId, includeMerged] as const,
  outbox: (ticketId: string) => [...messageKeys.all, ticketId, 'outbox'] as const,
};

const PAGE_SIZE = 50;

type MessagesData = InfiniteData<ListTicketMessages200, string | undefined>;

/** A message being sent that the API hasn't confirmed yet (or refused). */
export interface OutboxEntry {
  clientMessageId: string;
  visibility: PostTicketMessageBodyVisibility;
  body: string;
  attachmentIds: string[];
  mentionIds: string[];
  createdAt: string;
  status: 'sending' | 'failed';
  error?: string;
}

export function useTicketMessages(ticketId: string | undefined, includeMerged = false) {
  const query = useInfiniteQuery<ListTicketMessages200, Error, MessagesData, ReturnType<typeof messageKeys.list>, string | undefined>({
    queryKey: messageKeys.list(ticketId ?? '', includeMerged),
    queryFn: ({ pageParam, signal }) =>
      listTicketMessages(ticketId ?? '', { limit: PAGE_SIZE, includeMerged: includeMerged ? 'true' : 'false', ...(pageParam === undefined ? {} : { cursor: pageParam }) }, { signal }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: ticketId !== undefined,
  });
  const outbox = useOutbox(ticketId ?? '');
  const items = useMemo(() => buildItems(query.data, outbox), [query.data, outbox]);

  return {
    items,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error ? mapError(query.error) : undefined,
    refetch: query.refetch,
    hasOlder: query.hasNextPage,
    loadingOlder: query.isFetchingNextPage,
    loadOlder: useCallback(() => void query.fetchNextPage(), [query]),
  };
}

function useOutbox(ticketId: string): OutboxEntry[] {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: messageKeys.outbox(ticketId),
    // Local only: written by `useSendTicketMessage`, never fetched.
    queryFn: () => queryClient.getQueryData<OutboxEntry[]>(messageKeys.outbox(ticketId)) ?? [],
    initialData: [] as OutboxEntry[],
    staleTime: Infinity,
    gcTime: Infinity,
    enabled: ticketId !== '',
  });
  return data;
}

function setOutbox(queryClient: QueryClient, ticketId: string, update: (entries: OutboxEntry[]) => OutboxEntry[]): void {
  queryClient.setQueryData<OutboxEntry[]>(messageKeys.outbox(ticketId), (entries = []) => update(entries));
}

export interface SendTicketMessageInput {
  visibility: PostTicketMessageBodyVisibility;
  body: string;
  attachmentIds?: string[];
  mentionIds?: string[];
}

/** Send a public reply or add an internal note, with an idempotent `clientMessageId`. */
export function useSendTicketMessage(ticketId: string) {
  const queryClient = useQueryClient();

  const deliver = useCallback(
    async (entry: OutboxEntry) => {
      setOutbox(queryClient, ticketId, (entries) => [
        ...entries.filter((existing) => existing.clientMessageId !== entry.clientMessageId),
        { ...entry, status: 'sending', error: undefined },
      ]);
      try {
        const message = await postTicketMessage(ticketId, {
          visibility: entry.visibility,
          body: entry.body,
          clientMessageId: entry.clientMessageId,
          ...(entry.attachmentIds.length === 0 ? {} : { attachmentIds: entry.attachmentIds }),
          ...(entry.mentionIds.length === 0 ? {} : { mentionIds: entry.mentionIds }),
        });
        patchMessages(queryClient, ticketId, (data) => upsertMessage(data, message));
        setOutbox(queryClient, ticketId, (entries) => entries.filter((existing) => existing.clientMessageId !== entry.clientMessageId));
      } catch (caught) {
        const error = mapError(caught);
        setOutbox(queryClient, ticketId, (entries) =>
          entries.map((existing) => (existing.clientMessageId === entry.clientMessageId ? { ...existing, status: 'failed', error: error.message } : existing)),
        );
      }
    },
    [queryClient, ticketId],
  );

  const send = useCallback(
    (input: SendTicketMessageInput) =>
      deliver({
        clientMessageId: crypto.randomUUID(),
        visibility: input.visibility,
        body: input.body,
        attachmentIds: input.attachmentIds ?? [],
        mentionIds: input.mentionIds ?? [],
        createdAt: new Date().toISOString(),
        status: 'sending',
      }),
    [deliver],
  );

  /** Sends a failed message again with the same `clientMessageId`. */
  const retry = useCallback(
    (clientMessageId: string) => {
      const entry = queryClient.getQueryData<OutboxEntry[]>(messageKeys.outbox(ticketId))?.find((existing) => existing.clientMessageId === clientMessageId);
      return entry === undefined ? Promise.resolve() : deliver(entry);
    },
    [queryClient, ticketId, deliver],
  );

  return { send, retry };
}

/** Move a customer message to another of the same customer's tickets. */
export function useMoveTicketMessage() {
  const queryClient = useQueryClient();
  const mutation = useMoveTicketMessageMutation({
    mutation: {
      onSuccess: (message, { id }) => {
        patchMessages(queryClient, id, (data) => removeMessage(data, message.id));
        void queryClient.invalidateQueries({ queryKey: messageKeys.list(message.ticketId) });
      },
    },
  });
  return { ...mutation, mutateAsync: ({ id, messageId, targetTicketId }: { id: string; messageId: string; targetTicketId: string }) => mutation.mutateAsync({ id, messageId, data: { targetTicketId } }) };
}

/** Wires `message.created`, `message.moved` and `message.read` into this ticket's cache. */
export function useTicketMessageEvents(client: RealtimeClient | undefined, ticketId: string | undefined): void {
  useEffect(() => {
    if (!client || ticketId === undefined) return undefined;
    const off = [
      client.onEvent('message.created', (envelope, queryClient) => {
        const message = envelope.data as Message;
        if (message.ticketId !== ticketId) return;
        patchMessages(queryClient, ticketId, (data) => upsertMessage(data, message));
      }),
      client.onEvent('message.moved', (envelope, queryClient) => {
        const { messageId, fromTicketId, toTicketId } = envelope.data as { messageId: string; fromTicketId: string; toTicketId: string };
        if (fromTicketId === ticketId) patchMessages(queryClient, ticketId, (data) => removeMessage(data, messageId));
        if (toTicketId === ticketId) void queryClient.invalidateQueries({ queryKey: messageKeys.list(ticketId) });
      }),
      client.onEvent('message.read', (envelope, queryClient) => {
        const { upToMessageId, readAt } = envelope.data as { upToMessageId: string; readAt: string };
        patchMessages(queryClient, ticketId, (data) => markRead(data, upToMessageId, readAt));
      }),
    ];
    return () => off.forEach((unsubscribe) => unsubscribe());
  }, [client, ticketId]);
}

// Cache helpers. Pages are newest-chunk-first; items within a page are oldest first.

function patchMessages(queryClient: QueryClient, ticketId: string, update: (data: MessagesData) => MessagesData): void {
  for (const includeMerged of [false, true]) {
    queryClient.setQueryData<MessagesData>(messageKeys.list(ticketId, includeMerged), (data) => (data === undefined ? data : update(data)));
  }
}

function withFirstPage(data: MessagesData, update: (page: ListTicketMessages200) => ListTicketMessages200): MessagesData {
  const [first, ...rest] = data.pages;
  return first === undefined ? data : { ...data, pages: [update(first), ...rest] };
}

function appendMessage(data: MessagesData, message: Message): MessagesData {
  return withFirstPage(data, (page) => ({ ...page, items: [...page.items, message] }));
}

function upsertMessage(data: MessagesData, message: Message): MessagesData {
  const exists = data.pages.some((page) => page.items.some((item) => item.id === message.id));
  if (!exists) return appendMessage(data, message);
  return { ...data, pages: data.pages.map((page) => ({ ...page, items: page.items.map((item) => (item.id === message.id ? message : item)) })) };
}

function removeMessage(data: MessagesData, messageId: string): MessagesData {
  return { ...data, pages: data.pages.map((page) => ({ ...page, items: page.items.filter((item) => item.id !== messageId) })) };
}

function flattenAscending(data: MessagesData): Message[] {
  return [...data.pages].reverse().flatMap((page) => page.items);
}

function markRead(data: MessagesData, upToMessageId: string, readAt: string): MessagesData {
  const ordered = flattenAscending(data);
  const index = ordered.findIndex((message) => message.id === upToMessageId);
  if (index === -1) return data;
  const readIds = new Set(ordered.slice(0, index + 1).map((message) => message.id));
  return { ...data, pages: data.pages.map((page) => ({ ...page, items: page.items.map((item) => (readIds.has(item.id) ? { ...item, readAt } : item)) })) };
}

function toOutboxMessage(entry: OutboxEntry): Message {
  return {
    id: entry.clientMessageId,
    ticketId: '',
    author: null,
    authorKind: 'staff',
    visibility: entry.visibility,
    body: entry.body,
    mentions: [],
    attachments: [],
    clientMessageId: entry.clientMessageId,
    deliveredAt: null,
    readAt: null,
    movedFromTicketId: null,
    createdAt: entry.createdAt,
  };
}

function buildItems(data: MessagesData | undefined, outbox: OutboxEntry[]): Message[] {
  const items = data === undefined ? [] : flattenAscending(data);
  const sentClientIds = new Set(items.map((item) => item.clientMessageId).filter((id): id is string => id !== null && id !== undefined));
  return [...items, ...outbox.filter((entry) => !sentClientIds.has(entry.clientMessageId)).map(toOutboxMessage)];
}

export type { Message };
