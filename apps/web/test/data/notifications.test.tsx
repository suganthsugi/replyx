import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import {
  notificationKeys,
  useMarkNotificationsRead,
  useNotificationArrivals,
  useNotificationEvents,
  useNotifications,
} from '../../src/data/notifications';
import { RealtimeClient, type Envelope, type RealtimeSocket } from '../../src/data/socket';
import { API } from '../msw/handlers';
import { server } from '../setup';

import type { Notification } from '../../src/api/generated/model';

/**
 * The notification center's cache patching (FR-078–FR-083): a new burst prepends and bumps the
 * unread count, a grown burst updates the cached entry in place (or invalidates when it isn't
 * cached), and a read from another session clears exactly the ids given.
 */

class FakeSocket implements RealtimeSocket {
  connected = false;
  handlers = new Map<string, ((...args: never[]) => void)[]>();
  on(event: string, listener: (...args: never[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
  }
  emit() {}
  timeout(): { emitWithAck(event: string, payload: unknown): Promise<unknown> } {
    return { emitWithAck: () => Promise.resolve({ ok: true, upToSeq: 0, resyncRequired: [] }) };
  }
  connect() {}
  disconnect() {}
  fire(event: string, payload?: unknown) {
    for (const handler of this.handlers.get(event) ?? []) (handler as (p: unknown) => void)(payload);
  }
}

function envelope(type: string, data: unknown): Envelope {
  return { id: `evt-${type}`, seq: 1, stream: 'user', type, occurredAt: '2026-09-27T10:00:00.000Z', actor: { kind: 'system' }, data };
}

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'n1',
    eventType: 'ticket.assigned_to_me',
    title: 'Assigned to you',
    summary: 'Ticket #12 was assigned to you',
    ticketId: 't12',
    count: 1,
    read: false,
    createdAt: '2026-09-27T09:00:00.000Z',
    ...overrides,
  };
}

// Each test gets its own userId: `RealtimeClient` persists cursors to `sessionStorage` keyed by
// `namespace:userId` (data/socket.ts), which otherwise survives across tests in this file and
// makes a later envelope with a lower `seq` look already applied.
let nextUserId = 0;

function setup() {
  const socket = new FakeSocket();
  const queryClient = new QueryClient();
  const client = new RealtimeClient({ namespace: '/', userId: `u${(nextUserId += 1)}`, queryClient, createSocket: () => socket });
  return { socket, queryClient, client };
}

function seedList(queryClient: QueryClient, items: Notification[], unreadCount: number) {
  queryClient.setQueryData(notificationKeys.list({}), { pages: [{ items, unreadCount, nextCursor: null }], pageParams: [undefined] });
}

describe('useNotificationEvents', () => {
  it('registers the user stream so a resyncRequired after a reconnect refetches notifications', async () => {
    const socket = new FakeSocket();
    const queryClient = new QueryClient();
    socket.timeout = () => ({
      emitWithAck: () => Promise.resolve({ ok: true, upToSeq: 5, resyncRequired: ['user'] }),
    });
    const client = new RealtimeClient({ namespace: '/', userId: `u${(nextUserId += 1)}`, queryClient, createSocket: () => socket });
    renderHook(() => useNotificationEvents(client));

    // A prior applied envelope, so the reconnect below has a cursor to sync from.
    socket.fire('event', envelope('notification.created', makeNotification()));
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    socket.connected = true;
    socket.fire('connect');

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: notificationKeys.all }));
  });

  it('prepends a new notification and bumps the unread count', () => {
    const { socket, queryClient, client } = setup();
    seedList(queryClient, [], 0);
    const onArrival = vi.fn();

    renderHook(() => {
      useNotificationEvents(client);
      useNotificationArrivals(client, onArrival);
    });

    const notification = makeNotification();
    socket.fire('event', envelope('notification.created', notification));

    const cached = queryClient.getQueryData(notificationKeys.list({})) as { pages: { items: Notification[] }[] };
    expect(cached.pages[0]?.items).toEqual([notification]);
    expect(queryClient.getQueryData(notificationKeys.unreadCount())).toBe(1);
    expect(onArrival).toHaveBeenCalledWith(notification);
  });

  it('applies a grown burst to a cached entry in place', () => {
    const { socket, queryClient, client } = setup();
    seedList(queryClient, [makeNotification({ count: 1 })], 1);

    renderHook(() => useNotificationEvents(client));
    socket.fire('event', envelope('notification.updated', { id: 'n1', count: 4 }));

    const cached = queryClient.getQueryData(notificationKeys.list({})) as { pages: { items: Notification[] }[] };
    expect(cached.pages[0]?.items[0]?.count).toBe(4);
  });

  it('invalidates instead when the grown entry is not cached', () => {
    const { socket, queryClient, client } = setup();
    seedList(queryClient, [], 0);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useNotificationEvents(client));
    socket.fire('event', envelope('notification.updated', { id: 'missing', count: 2 }));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: notificationKeys.all });
  });

  it('marks the given ids read and sets the unread count from the payload', () => {
    const { socket, queryClient, client } = setup();
    seedList(queryClient, [makeNotification({ id: 'n1', read: false }), makeNotification({ id: 'n2', read: false })], 2);

    renderHook(() => useNotificationEvents(client));
    socket.fire('event', envelope('notification.read', { ids: ['n1'], unreadCount: 1 }));

    const cached = queryClient.getQueryData(notificationKeys.list({})) as { pages: { items: Notification[] }[] };
    expect(cached.pages[0]?.items.map((item) => [item.id, item.read])).toEqual([
      ['n1', true],
      ['n2', false],
    ]);
    expect(queryClient.getQueryData(notificationKeys.unreadCount())).toBe(1);
  });

  it('marks everything read on { ids: "all" }', () => {
    const { socket, queryClient, client } = setup();
    seedList(queryClient, [makeNotification({ id: 'n1', read: false }), makeNotification({ id: 'n2', read: false })], 2);

    renderHook(() => useNotificationEvents(client));
    socket.fire('event', envelope('notification.read', { ids: 'all', unreadCount: 0 }));

    const cached = queryClient.getQueryData(notificationKeys.list({})) as { pages: { items: Notification[] }[] };
    expect(cached.pages[0]?.items.every((item) => item.read)).toBe(true);
    expect(queryClient.getQueryData(notificationKeys.unreadCount())).toBe(0);
  });
});

function renderWithClient<T>(hook: () => T) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  return { queryClient, ...renderHook(hook, { wrapper }) };
}

describe('useNotifications', () => {
  it('keeps the unread count in step with the freshest fetched page', async () => {
    server.use(
      http.get(`${API}/notifications`, () => HttpResponse.json({ items: [makeNotification()], unreadCount: 3, nextCursor: null })),
    );

    const { result, queryClient } = renderWithClient(() => useNotifications());

    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(queryClient.getQueryData(notificationKeys.unreadCount())).toBe(3);
  });
});

describe('useMarkNotificationsRead', () => {
  it('optimistically marks ids read and rolls back on error', async () => {
    const { result, queryClient } = renderWithClient(() => useMarkNotificationsRead());
    seedList(queryClient, [makeNotification({ id: 'n1', read: false })], 1);
    queryClient.setQueryData(notificationKeys.unreadCount(), 1);

    server.use(http.post(`${API}/notifications/read`, () => HttpResponse.json({ error: { code: 'INTERNAL', message: 'boom' } }, { status: 500 })));

    await expect(result.current.mutateAsync({ ids: ['n1'] })).rejects.toBeTruthy();

    await waitFor(() => {
      const cached = queryClient.getQueryData(notificationKeys.list({})) as { pages: { items: Notification[] }[] };
      expect(cached.pages[0]?.items[0]?.read).toBe(false);
    });
    expect(queryClient.getQueryData(notificationKeys.unreadCount())).toBe(1);
  });

  it('sets the unread count from the server on success', async () => {
    const { result, queryClient } = renderWithClient(() => useMarkNotificationsRead());
    seedList(queryClient, [makeNotification({ id: 'n1', read: false })], 1);

    server.use(http.post(`${API}/notifications/read`, () => HttpResponse.json({ unreadCount: 0 })));

    await result.current.mutateAsync({ ids: ['n1'] });

    expect(queryClient.getQueryData(notificationKeys.unreadCount())).toBe(0);
  });
});
