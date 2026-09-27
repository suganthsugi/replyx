import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { RealtimeClient, type Envelope, type RealtimeSocket } from '../../src/data/socket';
import { useDeleteView, useReorderViews, useViewCountEvents, viewCountKeys } from '../../src/data/view-counts';
import { viewKeys } from '../../src/data/views';
import { API } from '../msw/handlers';
import { server } from '../setup';

import type { View } from '../../src/api/generated/model';

/**
 * `views.counts_changed` must only refetch `/views/counts`, never invalidate the view list
 * (data/views.ts no longer registers the `views` stream at all): a rename dropping a real list
 * request in flight is exactly the regression this guards against.
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

const envelope = (data: unknown): Envelope => ({
  id: 'evt-1',
  seq: 1,
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
  it('refetches view counts, and only view counts, on views.counts_changed', async () => {
    const socket = new FakeSocket();
    const queryClient = new QueryClient();
    const client = new RealtimeClient({ namespace: '/', userId: 'u1', queryClient, createSocket: () => socket });

    queryClient.setQueryData(viewKeys.list(), { items: [makeView()] });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useViewCountEvents(client));
    socket.fire('event', envelope({ viewIds: ['v1'] }));

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: viewCountKeys.all }));
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: viewKeys.all });
    // The view list itself is untouched.
    expect(queryClient.getQueryData(viewKeys.list())).toEqual({ items: [makeView()] });
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
