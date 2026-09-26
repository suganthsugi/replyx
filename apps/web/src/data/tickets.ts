import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  createTicketLink,
  deleteTicketLink,
  getTicket,
  listTicketHistory,
  listTickets,
  useCreateTicket as useCreateTicketMutation,
  useDeleteTicket as useDeleteTicketMutation,
  useUpdateTicket as useUpdateTicketMutation,
} from '../api/generated/tickets/tickets';

import { mapError } from './errors';
import { messageKeys } from './messages';

import type { RealtimeClient } from './socket';
import type {
  CreateTicketBody,
  CreateTicketLinkBody,
  HistoryEntry,
  ListTickets200,
  ListTicketHistory200,
  ListTicketsParams,
  ListTicketsSort,
  Priority,
  Ticket,
  TicketState,
  TicketSummary,
  UpdateTicketBody,
} from '../api/generated/model';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';

/**
 * Tickets (US6): the list a view or filter shows, a single ticket with `allowedActions`, and the
 * mutations the ticket screen and workspace need. Components never import
 * `api/generated/tickets` directly (data-hooks rule 6).
 *
 * Real time: `useTicketListEvents` (mount once, e.g. in the workspace shell) applies
 * `ticket.created`/`ticket.updated`/`ticket.removed_from_view` from `tickets:group:*` to every
 * cached list and to an open ticket's detail. `useTicketRoom` (mount while a ticket screen is
 * open) subscribes to `ticket:{id}` and registers its resync keys. `useTicketRemovedFromView`
 * lets the ticket screen close or flag itself, the same shape as `access.ts`'s
 * `useAccessRevoked`.
 */

export type TicketFilters = Omit<ListTicketsParams, 'limit' | 'cursor'>;

export const ticketKeys = {
  all: ['tickets'] as const,
  list: (filters: TicketFilters) => [...ticketKeys.all, 'list', filters] as const,
  detail: (id: string) => [...ticketKeys.all, 'detail', id] as const,
  history: (id: string) => [...ticketKeys.all, 'history', id] as const,
};

const PAGE_SIZE = 50;

type TicketListData = InfiniteData<ListTickets200, string | undefined>;
type TicketHistoryData = InfiniteData<ListTicketHistory200, string | undefined>;

/** Tickets visible to the caller, by view or ad-hoc filter (`viewId`, `state`, `priority`, ...). */
export function useTickets(filters: TicketFilters) {
  const query = useInfiniteQuery<ListTickets200, Error, TicketListData, ReturnType<typeof ticketKeys.list>, string | undefined>({
    queryKey: ticketKeys.list(filters),
    queryFn: ({ pageParam, signal }) => listTickets({ ...filters, limit: PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) }, { signal }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  return { ...query, items, error: query.error ? mapError(query.error) : undefined };
}

/**
 * One-off lookup for "open ticket #N" (the command bar): not a query hook since it's an imperative
 * action, not something a screen renders. Empty (not an error) when the number doesn't exist or
 * isn't visible to the caller.
 */
export async function findTicketByNumber(number: number): Promise<TicketSummary | undefined> {
  const result = await listTickets({ number, limit: 1 });
  return result.items[0];
}

/** A ticket with its `allowedActions`, links and customer summary. */
export function useTicket(id: string | undefined) {
  const query = useQuery({
    queryKey: ticketKeys.detail(id ?? ''),
    queryFn: ({ signal }) => getTicket(id ?? '', { signal }),
    enabled: id !== undefined,
  });
  return { ...query, error: query.error ? mapError(query.error) : undefined };
}

/** Change history, newest first. */
export function useTicketHistory(id: string | undefined) {
  const query = useInfiniteQuery<ListTicketHistory200, Error, TicketHistoryData, ReturnType<typeof ticketKeys.history>, string | undefined>({
    queryKey: ticketKeys.history(id ?? ''),
    queryFn: ({ pageParam, signal }) => listTicketHistory(id ?? '', { limit: PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) }, { signal }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: id !== undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  return { ...query, items, error: query.error ? mapError(query.error) : undefined };
}

/** Start a ticket for an existing customer (staff-started). */
export function useCreateTicket() {
  const queryClient = useQueryClient();
  const mutation = useCreateTicketMutation({
    mutation: { onSuccess: () => void queryClient.invalidateQueries({ queryKey: ticketKeys.all }) },
  });
  return { ...mutation, mutateAsync: (data: CreateTicketBody) => mutation.mutateAsync({ data }) };
}

/**
 * Title, state, priority, group, owner or tags. Only `title`/`state`/`priority` are patched
 * optimistically (they map straight onto the cached `Ticket`); group/owner/tag changes wait for
 * the server's response, since they replace nested refs the client can't build itself.
 */
export function useUpdateTicket() {
  const queryClient = useQueryClient();
  const mutation = useUpdateTicketMutation({
    mutation: {
      onMutate: async ({ id, data }: { id: string; data: UpdateTicketBody }) => {
        await queryClient.cancelQueries({ queryKey: ticketKeys.detail(id) });
        const previous = queryClient.getQueryData<Ticket>(ticketKeys.detail(id));
        if (previous !== undefined) queryClient.setQueryData<Ticket>(ticketKeys.detail(id), optimisticTicketPatch(previous, data));
        return { previous };
      },
      onError: (_error, { id }, context) => {
        if (context?.previous !== undefined) queryClient.setQueryData(ticketKeys.detail(id), context.previous);
      },
      onSuccess: (ticket) => queryClient.setQueryData(ticketKeys.detail(ticket.id), ticket),
      onSettled: (ticket, _error, { id }) => {
        void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === ticketKeys.all[0] && query.queryKey[1] === 'list' });
        void queryClient.invalidateQueries({ queryKey: ticketKeys.history(ticket?.id ?? id) });
      },
    },
  });
  return { ...mutation, mutateAsync: ({ id, ...data }: { id: string } & UpdateTicketBody) => mutation.mutateAsync({ id, data }) };
}

function optimisticTicketPatch(previous: Ticket, data: UpdateTicketBody): Ticket {
  return {
    ...previous,
    ...(data.title === undefined ? {} : { title: data.title }),
    ...(data.state === undefined ? {} : { state: data.state }),
    ...(data.priority === undefined ? {} : { priority: data.priority }),
  };
}

/** A hard delete (ticket.delete on its group); removes the detail cache and refetches lists. */
export function useDeleteTicket() {
  const queryClient = useQueryClient();
  const mutation = useDeleteTicketMutation({
    mutation: {
      onSuccess: (_data, { id }) => {
        queryClient.removeQueries({ queryKey: ticketKeys.detail(id) });
        void queryClient.invalidateQueries({ queryKey: ticketKeys.all });
      },
    },
  });
  return { ...mutation, mutateAsync: ({ id }: { id: string }) => mutation.mutateAsync({ id }) };
}

/** Links to another ticket; both invalidate this ticket's detail (its `links` array). */
export function useCreateTicketLink() {
  const queryClient = useQueryClient();
  return useMutationHelper((id: string, data: CreateTicketLinkBody) => createTicketLink(id, data), queryClient);
}

export function useDeleteTicketLink() {
  const queryClient = useQueryClient();
  return useMutationHelper((id: string, linkId: string) => deleteTicketLink(id, linkId), queryClient);
}

function useMutationHelper<A>(fn: (id: string, arg: A) => Promise<unknown>, queryClient: QueryClient) {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<ReturnType<typeof mapError> | undefined>(undefined);
  const mutateAsync = useCallback(
    async (id: string, arg: A) => {
      setIsPending(true);
      setError(undefined);
      try {
        const result = await fn(id, arg);
        void queryClient.invalidateQueries({ queryKey: ticketKeys.detail(id) });
        return result;
      } catch (caught) {
        const mapped = mapError(caught);
        setError(mapped);
        throw caught;
      } finally {
        setIsPending(false);
      }
    },
    [fn, queryClient],
  );
  return { mutateAsync, isPending, error };
}

// Real time: lists and the open ticket.

function findListQueries(queryClient: QueryClient) {
  return queryClient.getQueryCache().findAll({ queryKey: [...ticketKeys.all, 'list'] });
}

function patchLists(queryClient: QueryClient, update: (items: TicketSummary[]) => TicketSummary[]): void {
  for (const query of findListQueries(queryClient)) {
    queryClient.setQueryData<TicketListData>(query.queryKey, (data) =>
      data === undefined ? data : { ...data, pages: data.pages.map((page) => ({ ...page, items: update(page.items) })) },
    );
  }
}

/** Ignores a malformed payload (missing `id`/`customer`) instead of corrupting the list. */
function isWellFormedTicketSummary(ticket: TicketSummary | undefined | null): ticket is TicketSummary {
  return ticket != null && typeof ticket.id === 'string' && ticket.customer != null;
}

function upsertTicket(items: TicketSummary[], ticket: TicketSummary | undefined | null): TicketSummary[] {
  if (!isWellFormedTicketSummary(ticket)) return items;
  const exists = items.some((item) => item.id === ticket.id);
  return exists ? items.map((item) => (item.id === ticket.id ? ticket : item)) : [ticket, ...items];
}

function removeTicket(items: TicketSummary[], ticketId: string): TicketSummary[] {
  return items.filter((item) => item.id !== ticketId);
}

/** `ticket.created`/`ticket.updated`/`ticket.removed_from_view` on `tickets:group:*`; mount once. */
export function useTicketListEvents(client: RealtimeClient | undefined): void {
  useEffect(() => {
    if (!client) return undefined;
    client.registerStreamKeys('tickets', () => [ticketKeys.all]);
    const off = [
      client.onEvent('ticket.created', (envelope, queryClient) => {
        const { ticket } = envelope.data as { ticket: TicketSummary };
        patchLists(queryClient, (items) => upsertTicket(items, ticket));
      }),
      client.onEvent('ticket.updated', (envelope, queryClient) => {
        const { ticket } = envelope.data as { ticket: TicketSummary; changes: Array<{ field: string; old: unknown; new: unknown }> };
        patchLists(queryClient, (items) => upsertTicket(items, ticket));
        queryClient.setQueryData<Ticket>(ticketKeys.detail(ticket.id), (previous) => (previous === undefined ? previous : { ...previous, ...ticket }));
        void queryClient.invalidateQueries({ queryKey: ticketKeys.history(ticket.id) });
      }),
      client.onEvent('ticket.removed_from_view', (envelope, queryClient) => {
        const { ticketId } = envelope.data as { ticketId: string; reason: 'moved' | 'deleted' | 'merged' };
        patchLists(queryClient, (items) => removeTicket(items, ticketId));
      }),
    ];
    return () => off.forEach((unsubscribe) => unsubscribe());
  }, [client]);
}

/**
 * Calls `onRemoved` for every `ticket.removed_from_view` (same shape as `access.ts`'s
 * `useAccessRevoked`): the open ticket screen closes itself, or shows why, when it matches.
 */
export function useTicketRemovedFromView(
  client: RealtimeClient | undefined,
  onRemoved: (removed: { ticketId: string; reason: 'moved' | 'deleted' | 'merged' }) => void,
): void {
  const handler = useRef(onRemoved);
  useEffect(() => {
    handler.current = onRemoved;
  }, [onRemoved]);

  useEffect(() => {
    if (!client) return undefined;
    return client.onEvent('ticket.removed_from_view', (envelope) => {
      handler.current(envelope.data as { ticketId: string; reason: 'moved' | 'deleted' | 'merged' });
    });
  }, [client]);
}

/** Joins `ticket:{id}` while its screen is open, and registers its resync keys. */
export function useTicketRoom(client: RealtimeClient | undefined, id: string | undefined): void {
  useEffect(() => {
    if (!client || id === undefined) return undefined;
    client.registerStreamKeys('ticket', (stream) => {
      const ticketId = stream.split(':')[1];
      return ticketId === undefined ? [] : [ticketKeys.detail(ticketId), messageKeys.list(ticketId)];
    });
    const stream = `ticket:${id}`;
    void client.subscribe(stream);
    return () => client.unsubscribe(stream);
  }, [client, id]);
}

// Presence and typing on an open ticket.

export interface PresenceUser {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export type PresenceMember = PresenceUser | { kind: 'customer'; name: string };

export interface TicketPresence {
  viewers: PresenceUser[];
  typing: PresenceMember[];
}

const EMPTY_PRESENCE: TicketPresence = { viewers: [], typing: [] };

/** Sends `viewing` enter/leave and reads the `presence` payload the server answers with. */
export function useTicketPresence(client: RealtimeClient | undefined, ticketId: string | undefined): TicketPresence {
  const [presence, setPresence] = useState<TicketPresence>(EMPTY_PRESENCE);

  useEffect(() => {
    setPresence(EMPTY_PRESENCE);
    if (!client || ticketId === undefined) return undefined;
    client.send('viewing', { ticketId, state: 'enter' });
    const off = client.onEphemeral('presence', (signal) => {
      const data = signal.data as { ticketId: string; viewers: PresenceUser[]; typing: PresenceMember[] };
      if (data.ticketId !== ticketId) return;
      setPresence({ viewers: data.viewers, typing: data.typing });
    });
    return () => {
      client.send('viewing', { ticketId, state: 'leave' });
      off();
    };
  }, [client, ticketId]);

  return presence;
}

export type TicketTypingUser = { id: string; name: string; avatarUrl: string | null } | { kind: 'customer'; name: string };

const TYPING_TIMEOUT_MS = 10_000;

/** Who else is typing on this ticket right now, from `typing` ephemeral signals. */
export function useTicketTypingIndicator(client: RealtimeClient | undefined, ticketId: string | undefined): TicketTypingUser[] {
  const [typing, setTyping] = useState<Map<string, TicketTypingUser>>(new Map());

  useEffect(() => {
    setTyping(new Map());
    if (!client || ticketId === undefined) return undefined;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const off = client.onEphemeral('typing', (signal) => {
      const data = signal.data as { ticketId: string; user: TicketTypingUser; state: 'start' | 'stop' };
      if (data.ticketId !== ticketId) return;
      const key = 'id' in data.user ? data.user.id : `customer:${data.user.name}`;
      clearTimeout(timers.get(key));
      if (data.state === 'stop') {
        timers.delete(key);
        setTyping((current) => {
          if (!current.has(key)) return current;
          const next = new Map(current);
          next.delete(key);
          return next;
        });
        return;
      }
      setTyping((current) => new Map(current).set(key, data.user));
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          setTyping((current) => {
            if (!current.has(key)) return current;
            const next = new Map(current);
            next.delete(key);
            return next;
          });
        }, TYPING_TIMEOUT_MS),
      );
    });
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      off();
    };
  }, [client, ticketId]);

  return [...typing.values()];
}

const TYPING_IDLE_MS = 4_000;
const TYPING_REFRESH_MS = 10_000;

/**
 * Staff composing on `ticketId` sends `typing` (at most every 10 s while typing) and `stop` after
 * 4 s of quiet or on send.
 */
export function useTicketTypingSignal(client: RealtimeClient | undefined, ticketId: string | undefined, visibility: 'public' | 'internal') {
  const lastStart = useRef(0);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const stopTyping = useCallback(() => {
    clearTimeout(idle.current);
    if (lastStart.current === 0 || !client || ticketId === undefined) return;
    lastStart.current = 0;
    client.send('typing', { ticketId, state: 'stop', visibility });
  }, [client, ticketId, visibility]);

  const onTyping = useCallback(() => {
    if (!client || ticketId === undefined) return;
    const now = Date.now();
    if (now - lastStart.current > TYPING_REFRESH_MS) {
      lastStart.current = now;
      client.send('typing', { ticketId, state: 'start', visibility });
    }
    clearTimeout(idle.current);
    idle.current = setTimeout(stopTyping, TYPING_IDLE_MS);
  }, [client, ticketId, visibility, stopTyping]);

  useEffect(() => () => clearTimeout(idle.current), []);
  return { onTyping, stopTyping };
}

export type { HistoryEntry, ListTicketsSort, Priority, Ticket, TicketState, TicketSummary };
