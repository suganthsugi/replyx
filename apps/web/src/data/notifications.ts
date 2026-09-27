import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import {
  listNotifications,
  useGetNotificationPreferences as useGetNotificationPreferencesQuery,
  useMarkNotificationsRead as useMarkNotificationsReadMutation,
  useUpdateNotificationPreferences as useUpdateNotificationPreferencesMutation,
} from '../api/generated/operations/operations';

import { mapError } from './errors';

import type { RealtimeClient } from './socket';
import type {
  ListNotifications200,
  ListNotificationsParams,
  MarkNotificationsReadBody,
  Notification,
  NotificationPreferences,
  NotificationPreferencesInput,
} from '../api/generated/model';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';

/**
 * The staff notification center (FR-078–FR-083): the paged list, the unread badge count, read
 * mutations and preferences. Components never import `api/generated/operations` directly
 * (data-hooks rule 6).
 *
 * Real time: `useNotificationEvents` (mount once per staff session, alongside
 * `useTicketListEvents`/`useViewCountEvents`) is the one place that registers the `user` stream
 * (`client.registerStreamKeys('user', ...)`) today, so a `resyncRequired` after a reconnect
 * refetches notifications. It applies `notification.created` (prepend + bump the unread count),
 * `notification.updated` (a burst grew an existing cached entry; invalidate instead when that
 * entry isn't cached) and `notification.read` (another session marked read). The separate
 * `useNotificationArrivals` lets the notification center announce new arrivals through `LiveRegion`
 * without the cache-patching logic living in a component.
 */

export type NotificationFilters = { unread?: boolean };

export const notificationKeys = {
  all: ['notifications'] as const,
  list: (filters: NotificationFilters) => [...notificationKeys.all, 'list', filters] as const,
  unreadCount: () => [...notificationKeys.all, 'unread-count'] as const,
  preferences: () => [...notificationKeys.all, 'preferences'] as const,
};

const PAGE_SIZE = 50;

type NotificationListData = InfiniteData<ListNotifications200, string | undefined>;

/** The signed-in staff member's notification center, newest first, optionally unread-only. */
export function useNotifications(filters: NotificationFilters = {}) {
  const queryClient = useQueryClient();
  const query = useInfiniteQuery<
    ListNotifications200,
    Error,
    NotificationListData,
    ReturnType<typeof notificationKeys.list>,
    string | undefined
  >({
    queryKey: notificationKeys.list(filters),
    queryFn: ({ pageParam, signal }) =>
      listNotifications(
        { ...toParams(filters), limit: PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
        { signal },
      ),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

  // Every page answers with the caller's current unread count; keep the badge (`useUnreadNotificationCount`) in step
  // with whichever list was fetched most recently, without a redundant request when one is already open.
  useEffect(() => {
    const freshest = query.data?.pages[0];
    if (freshest !== undefined) queryClient.setQueryData(notificationKeys.unreadCount(), freshest.unreadCount);
  }, [query.data, queryClient]);

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  return { ...query, items, error: query.error ? mapError(query.error) : undefined };
}

function toParams(filters: NotificationFilters): Pick<ListNotificationsParams, 'unread'> {
  return filters.unread === undefined ? {} : { unread: filters.unread };
}

/** The unread badge count, kept fresh by `useNotifications` and by real-time events. */
export function useUnreadNotificationCount() {
  const query = useQuery({
    queryKey: notificationKeys.unreadCount(),
    queryFn: async ({ signal }) => (await listNotifications({ limit: 1 }, { signal })).unreadCount,
  });
  return { ...query, error: query.error ? mapError(query.error) : undefined };
}

/** Marks specific ids, or everything (`{ all: true }`), read; syncs to every session (FR-083). */
export function useMarkNotificationsRead() {
  const queryClient = useQueryClient();
  const mutation = useMarkNotificationsReadMutation({
    mutation: {
      onMutate: async ({ data: body }: { data: MarkNotificationsReadBody }) => {
        await queryClient.cancelQueries({ queryKey: notificationKeys.all });
        const previousLists = queryClient.getQueriesData<NotificationListData>({ queryKey: [...notificationKeys.all, 'list'] });
        const previousUnreadCount = queryClient.getQueryData<number>(notificationKeys.unreadCount());
        patchNotificationLists(queryClient, (items) => markItemsRead(items, body));
        queryClient.setQueryData<number>(notificationKeys.unreadCount(), (count) =>
          'all' in body ? 0 : Math.max(0, (count ?? 0) - body.ids.length),
        );
        return { previousLists, previousUnreadCount };
      },
      onError: (_error, _body, context) => {
        for (const [queryKey, data] of context?.previousLists ?? []) queryClient.setQueryData(queryKey, data);
        if (context?.previousUnreadCount !== undefined) queryClient.setQueryData(notificationKeys.unreadCount(), context.previousUnreadCount);
      },
      onSuccess: (result) => queryClient.setQueryData(notificationKeys.unreadCount(), result.unreadCount),
    },
  });
  return { ...mutation, mutateAsync: (body: MarkNotificationsReadBody) => mutation.mutateAsync({ data: body }) };
}

/** Own preferences, merged with the tenant defaults (FR-080). */
export function useNotificationPreferences() {
  const query = useGetNotificationPreferencesQuery<NotificationPreferences>({ query: { queryKey: notificationKeys.preferences() } });
  return { ...query, error: query.error ? mapError(query.error) : undefined };
}

export function useUpdateNotificationPreferences() {
  const queryClient = useQueryClient();
  const mutation = useUpdateNotificationPreferencesMutation({
    mutation: {
      onSuccess: (preferences) => queryClient.setQueryData(notificationKeys.preferences(), preferences),
    },
  });
  return { ...mutation, mutateAsync: (data: NotificationPreferencesInput) => mutation.mutateAsync({ data }) };
}

// Real time: the notification center's cached lists and unread count.

function findNotificationListQueries(queryClient: QueryClient) {
  return queryClient.getQueryCache().findAll({ queryKey: [...notificationKeys.all, 'list'] });
}

function patchNotificationLists(queryClient: QueryClient, update: (items: Notification[]) => Notification[]): void {
  for (const query of findNotificationListQueries(queryClient)) {
    queryClient.setQueryData<NotificationListData>(query.queryKey, (data) =>
      data === undefined ? data : { ...data, pages: data.pages.map((page) => ({ ...page, items: update(page.items) })) },
    );
  }
}

function markItemsRead(items: Notification[], body: MarkNotificationsReadBody): Notification[] {
  if ('all' in body) return items.map((item) => (item.read ? item : { ...item, read: true }));
  const ids = new Set<string>(body.ids);
  return items.map((item) => (ids.has(item.id) && !item.read ? { ...item, read: true } : item));
}

/** Prepends a new notification to every cached list it belongs in (an unread-only list skips a read one). */
function prependNotification(queryClient: QueryClient, notification: Notification): void {
  for (const query of findNotificationListQueries(queryClient)) {
    const filters = query.queryKey[2] as NotificationFilters | undefined;
    if (filters?.unread === true && notification.read) continue;
    queryClient.setQueryData<NotificationListData>(query.queryKey, (data) => {
      if (data === undefined) return data;
      const [first, ...rest] = data.pages;
      if (first === undefined || first.items.some((item) => item.id === notification.id)) return data;
      return { ...data, pages: [{ ...first, items: [notification, ...first.items] }, ...rest] };
    });
  }
}

/** Applies a grown burst count to an already-cached entry; reports whether it found one to patch. */
function applyNotificationCount(queryClient: QueryClient, id: string, count: number): boolean {
  let found = false;
  for (const query of findNotificationListQueries(queryClient)) {
    queryClient.setQueryData<NotificationListData>(query.queryKey, (data) => {
      if (data === undefined) return data;
      let listChanged = false;
      const pages = data.pages.map((page) => {
        let pageChanged = false;
        const items = page.items.map((item) => {
          if (item.id !== id) return item;
          pageChanged = true;
          found = true;
          return { ...item, count };
        });
        if (!pageChanged) return page;
        listChanged = true;
        return { ...page, items };
      });
      return listChanged ? { ...data, pages } : data;
    });
  }
  return found;
}

/**
 * `notification.created`/`notification.updated`/`notification.read` on the `user` stream; mount
 * once per staff session (DeskLayout). Announcing arrivals is `useNotificationArrivals`.
 */
export function useNotificationEvents(client: RealtimeClient | undefined): void {
  useEffect(() => {
    if (!client) return undefined;
    client.registerStreamKeys('user', () => [notificationKeys.all]);
    const off = [
      client.onEvent('notification.created', (envelope, queryClient) => {
        const notification = envelope.data as Notification;
        prependNotification(queryClient, notification);
        if (!notification.read) queryClient.setQueryData<number>(notificationKeys.unreadCount(), (count) => (count ?? 0) + 1);
      }),
      client.onEvent('notification.updated', (envelope, queryClient) => {
        const { id, count } = envelope.data as { id: string; count: number };
        if (!applyNotificationCount(queryClient, id, count)) void queryClient.invalidateQueries({ queryKey: notificationKeys.all });
      }),
      client.onEvent('notification.read', (envelope, queryClient) => {
        const { ids, unreadCount } = envelope.data as { ids: string[] | 'all'; unreadCount: number };
        patchNotificationLists(queryClient, (items) => markItemsRead(items, ids === 'all' ? { all: true } : { ids }));
        queryClient.setQueryData(notificationKeys.unreadCount(), unreadCount);
      }),
    ];
    return () => off.forEach((unsubscribe) => unsubscribe());
  }, [client]);
}

/**
 * Calls `onArrival` for every newly created notification, so the notification center can announce
 * it through `LiveRegion` (T169). Listens only: the cache is patched by `useNotificationEvents`.
 */
export function useNotificationArrivals(client: RealtimeClient | undefined, onArrival: (notification: Notification) => void): void {
  const handler = useRef(onArrival);
  useEffect(() => {
    handler.current = onArrival;
  }, [onArrival]);

  useEffect(() => {
    if (!client) return undefined;
    return client.onEvent('notification.created', (envelope) => handler.current(envelope.data as Notification));
  }, [client]);
}

export type { MarkNotificationsReadBody, Notification, NotificationPreferences, NotificationPreferencesInput };
