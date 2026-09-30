import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RealtimeClient, type Envelope, type RealtimeSocket } from '../../src/data/socket';
import { reorderViewsMutationKey, useDeleteView, useReorderViews, useViewCountEvents, VIEW_LIST_REFRESH_MS, viewCountKeys } from '../../src/data/view-counts';
import { viewKeys } from '../../src/data/views';
import { API } from '../msw/handlers';
import { server } from '../setup';

import type { View } from '../../src/api/generated/model';

/**
 * `views.counts_changed` contract: every hint refetches `/views/counts` at once; the view list is
 * refreshed by a one-shot trailing timer (VIEW_LIST_REFRESH_MS) armed by the first hint of a burst,
 * skipped while a reorder mutation is pending. Asserted through observed queries (real fetches).
 */

class FakeSocket implements RealtimeSocket {
  connected = false;
  handlers = new Map<string, ((...args: never[]) => void)[]>();
  on(event: string, listener: (...args: never[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
  }
  emit() {}
  timeout() {
    return { emitWithAck: () => Promise.resolve({ ok: true, upToSeq: 0, resyncRequired: [] }) };
  }
  connect() {}
  disconnect() {}
  fire(event: string, payload?: unknown) {
    for (const handler of this.handlers.get(event) ?? []) (handler as (p: unknown) => void)(payload);
  }
}

let nextSeq = 1;
const envelope = (data: unknown): Envelope => ({
  id: `evt-${nextSeq}`,
  seq: nextSeq++,
  stream: 'views',
  type: 'views.counts_changed',
  occurredAt: '2026-09-27T10:00:00.000Z',
  actor: { kind: 'system' },
  data,
});

function makeView(overrides: Partial<View> = {}): View {
  return {
    id: 'v1',
    name: 'Needs triage',
    description: null,
    visibility: 'shared',
    sharedRoleIds: [],
    sharedGroupIds: [],
    conditions: { operator: 'and', conditions: [] },
    sort: [],
    columns: [],
    system: 'needs_triage',
    count: 3,
    position: 0,
    hidden: false,
    editable: true,
    ...overrides,
  } as View;
}

describe('useViewCountEvents', () => {
  afterEach(() => vi.useRealTimers());

  function setup() {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const queryClient = new QueryClient();
    const client = new RealtimeClient({ namespace: '/', userId: 'u1', queryClient, createSocket: () => socket });
    const fetches = { counts: 0, list: 0 };
    const observe = (queryKey: readonly unknown[], name: 'counts' | 'list') =>
      new QueryObserver(queryClient, {
        queryKey,
        staleTime: Infinity,
        queryFn: () => {
          fetches[name] += 1;
          return Promise.resolve({ items: [] });
        },
      }).subscribe(() => {});
    const unsubscribes = [observe(viewCountKeys.all, 'counts'), observe(viewKeys.list(), 'list')];
    const hook = renderHook(() => useViewCountEvents(client));
    const hint = () => socket.fire('event', envelope({ viewIds: ['v1'] }));
    const settle = () => vi.advanceTimersByTimeAsync(0);
    return { socket, queryClient, client, fetches, hook, hint, settle, unsubscribes };
  }

  it('refetches counts at once and the list only after the trailing window', async () => {
    const { fetches, hint, settle, hook, unsubscribes } = setup();
    await settle();
    expect(fetches).toEqual({ counts: 1, list: 1 });

    hint();
    await settle();
    expect(fetches).toEqual({ counts: 2, list: 1 });

    await vi.advanceTimersByTimeAsync(VIEW_LIST_REFRESH_MS - 1);
    expect(fetches.list).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetches).toEqual({ counts: 2, list: 2 });

    // One-shot: nothing further without a new hint.
    await vi.advanceTimersByTimeAsync(VIEW_LIST_REFRESH_MS * 3);
    expect(fetches).toEqual({ counts: 2, list: 2 });
    hook.unmount();
    unsubscribes.forEach((off) => off());
  });

  it('coalesces a burst: each hint refetches counts, one list refresh follows the first hint', async () => {
    const { fetches, hint, settle } = setup();
    await settle();

    hint();
    await vi.advanceTimersByTimeAsync(2_000);
    hint();
    await vi.advanceTimersByTimeAsync(2_000);
    hint();
    await settle();
    expect(fetches).toEqual({ counts: 4, list: 1 });

    // 5 s after the FIRST hint (not the last).
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetches).toEqual({ counts: 4, list: 2 });

    // A hint after the timer fired starts a new window.
    hint();
    await settle();
    expect(fetches).toEqual({ counts: 5, list: 2 });
    await vi.advanceTimersByTimeAsync(VIEW_LIST_REFRESH_MS);
    expect(fetches).toEqual({ counts: 5, list: 3 });
  });

  it('skips the list refresh, without rescheduling, while a reorder is pending', async () => {
    const { fetches, hint, settle, queryClient } = setup();
    await settle();

    const reorder = queryClient.getMutationCache().build(queryClient, { mutationKey: reorderViewsMutationKey, mutationFn: () => new Promise<void>(() => {}) });
    void reorder.execute(undefined).catch(() => {});
    expect(queryClient.isMutating({ mutationKey: reorderViewsMutationKey })).toBe(1);

    hint();
    await vi.advanceTimersByTimeAsync(VIEW_LIST_REFRESH_MS * 3);
    expect(fetches).toEqual({ counts: 2, list: 1 });
  });

  it('clears the pending timer on unmount', async () => {
    const { fetches, hint, settle, hook } = setup();
    await settle();
    hint();
    await settle();
    hook.unmount();
    await vi.advanceTimersByTimeAsync(VIEW_LIST_REFRESH_MS * 2);
    expect(fetches).toEqual({ counts: 2, list: 1 });
  });

  it('registers the views stream with counts and list keys for an immediate resync refetch', () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    const client = new RealtimeClient({ namespace: '/', userId: 'u1', queryClient, createSocket: () => new FakeSocket() });
    const register = vi.spyOn(client, 'registerStreamKeys');
    renderHook(() => useViewCountEvents(client));
    expect(register).toHaveBeenCalledWith('views', expect.any(Function));
    const keysFor = register.mock.calls[0]![1];
    expect(keysFor('views')).toEqual([viewCountKeys.all, viewKeys.list()]);
  });
});

function renderWithClient<T>(hook: () => T) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  return { queryClient, ...renderHook(hook, { wrapper }) };
}

describe('useReorderViews', () => {
  it('patches the cached view list optimistically and rolls back on error', async () => {
    const { result, queryClient } = renderWithClient(() => useReorderViews());
    const v1 = makeView({ id: 'v1', position: 0 });
    const v2 = makeView({ id: 'v2', position: 1 });
    queryClient.setQueryData(viewKeys.list(), { items: [v1, v2] });

    server.use(http.put(`${API}/views/order`, () => HttpResponse.json({ error: { code: 'PERMISSION_DENIED', message: 'no' } }, { status: 403 })));

    await expect(
      result.current.mutateAsync({ items: [{ id: 'v1', position: 1, hidden: false }, { id: 'v2', position: 0, hidden: false }] }),
    ).rejects.toBeTruthy();

    await waitFor(() => {
      const cached = queryClient.getQueryData<{ items: View[] }>(viewKeys.list());
      expect(cached?.items.map((view) => view.id)).toEqual(['v1', 'v2']);
    });
  });

  it('reflects the new order immediately, before the server answers', async () => {
    const { result, queryClient } = renderWithClient(() => useReorderViews());
    const v1 = makeView({ id: 'v1', position: 0 });
    const v2 = makeView({ id: 'v2', position: 1 });
    queryClient.setQueryData(viewKeys.list(), { items: [v1, v2] });

    server.use(
      http.put(`${API}/views/order`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const promise = result.current.mutateAsync({ items: [{ id: 'v1', position: 1, hidden: false }, { id: 'v2', position: 0, hidden: false }] });

    await waitFor(() => {
      const cached = queryClient.getQueryData<{ items: View[] }>(viewKeys.list());
      expect(cached?.items.map((view) => view.id)).toEqual(['v2', 'v1']);
    });

    await promise;
  });
});

describe('useDeleteView', () => {
  it('removes the detail cache and invalidates the view list after a delete', async () => {
    const { result, queryClient } = renderWithClient(() => useDeleteView());
    queryClient.setQueryData(viewKeys.detail('v1'), makeView({ id: 'v1' }));

    server.use(http.delete(`${API}/views/v1`, () => new HttpResponse(null, { status: 204 })));

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    await result.current.mutateAsync({ id: 'v1' });

    expect(queryClient.getQueryData(viewKeys.detail('v1'))).toBeUndefined();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: viewKeys.all });
  });
});
