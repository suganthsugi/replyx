import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import {
  routingRuleKeys,
  useCreateRoutingRule,
  useDeleteRoutingRule,
  useReorderRoutingRules,
  useRoutingRules,
  useTestRoutingRules,
  useUpdateRoutingRule,
} from '../../src/data/routing-rules';
import { makeDryRun, makeRoutingRule } from '../admin/routing-fixtures';
import { API, errorResponse } from '../msw/handlers';
import { server } from '../setup';

import type { ListRoutingRules200, RoutingDryRun, RoutingRule } from '../../src/api/generated/model';
import type { ReactNode } from 'react';

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  return { queryClient, Wrapper };
}

const a = makeRoutingRule({ id: 'a', name: 'A', position: 0 });
const b = makeRoutingRule({ id: 'b', name: 'B', position: 1 });
const body = { name: 'A', enabled: false, conditions: a.conditions, actions: a.actions };

const cached = (queryClient: QueryClient) => queryClient.getQueryData<ListRoutingRules200>(routingRuleKeys.list());

/** A handler that only answers once released, so the optimistic state can be observed. */
function gate() {
  let release: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release };
}

describe('useRoutingRules', () => {
  it('sorts the items by position', async () => {
    server.use(http.get(`${API}/routing-rules`, () => HttpResponse.json<ListRoutingRules200>({ items: [b, a] })));
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useRoutingRules(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('maps a failure to a user-facing error', async () => {
    server.use(http.get(`${API}/routing-rules`, () => errorResponse(500, 'INTERNAL', 'Boom')));
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useRoutingRules(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toEqual(expect.any(String));
  });
});

describe('useUpdateRoutingRule', () => {
  it('flips the switch in the cache before the server answers, then refetches', async () => {
    const { opened, release } = gate();
    let current: RoutingRule[] = [a, b];
    server.use(
      http.get(`${API}/routing-rules`, () => HttpResponse.json<ListRoutingRules200>({ items: current })),
      http.put(`${API}/routing-rules/:id`, async () => {
        await opened;
        current = [{ ...a, enabled: false }, b];
        return HttpResponse.json<RoutingRule>(current[0] ?? a);
      }),
    );
    const { queryClient, Wrapper } = wrapper();
    const list = renderHook(() => useRoutingRules(), { wrapper: Wrapper });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    const { result } = renderHook(() => useUpdateRoutingRule(), { wrapper: Wrapper });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current.mutateAsync({ id: 'a', body });
    });
    await waitFor(() => expect(cached(queryClient)?.items[0]?.enabled).toBe(false));
    release();
    await act(async () => {
      await pending;
    });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: routingRuleKeys.list() }));
  });

  it('rolls the cache back when the update fails', async () => {
    server.use(
      http.get(`${API}/routing-rules`, () => HttpResponse.json<ListRoutingRules200>({ items: [a, b] })),
      http.put(`${API}/routing-rules/:id`, () => errorResponse(500, 'INTERNAL', 'Boom')),
    );
    const { queryClient, Wrapper } = wrapper();
    const list = renderHook(() => useRoutingRules(), { wrapper: Wrapper });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    const { result } = renderHook(() => useUpdateRoutingRule(), { wrapper: Wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ id: 'a', body })).rejects.toBeDefined();
    });
    expect(cached(queryClient)?.items[0]?.enabled).toBe(true);
  });
});

describe('useReorderRoutingRules', () => {
  it('reorders the cache optimistically and sends { ids }', async () => {
    const { opened, release } = gate();
    const sent: unknown[] = [];
    server.use(
      http.get(`${API}/routing-rules`, () => HttpResponse.json<ListRoutingRules200>({ items: [a, b] })),
      http.put(`${API}/routing-rules/order`, async ({ request }) => {
        sent.push(await request.json());
        await opened;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { queryClient, Wrapper } = wrapper();
    const list = renderHook(() => useRoutingRules(), { wrapper: Wrapper });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    const { result } = renderHook(() => useReorderRoutingRules(), { wrapper: Wrapper });

    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current.mutateAsync(['b', 'a']);
    });
    await waitFor(() => expect(cached(queryClient)?.items.map((r) => [r.id, r.position])).toEqual([['b', 0], ['a', 1]]));
    release();
    await act(async () => {
      await pending;
    });
    expect(sent).toEqual([{ ids: ['b', 'a'] }]);
  });

  it('restores the order when the server refuses', async () => {
    server.use(
      http.get(`${API}/routing-rules`, () => HttpResponse.json<ListRoutingRules200>({ items: [a, b] })),
      http.put(`${API}/routing-rules/order`, () => errorResponse(400, 'VALIDATION_FAILED', 'Stale')),
    );
    const { queryClient, Wrapper } = wrapper();
    const list = renderHook(() => useRoutingRules(), { wrapper: Wrapper });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    const { result } = renderHook(() => useReorderRoutingRules(), { wrapper: Wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync(['b', 'a'])).rejects.toBeDefined();
    });
    expect(cached(queryClient)?.items.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('create, delete and test', () => {
  it('create and delete invalidate the list', async () => {
    server.use(
      http.post(`${API}/routing-rules`, () => HttpResponse.json<RoutingRule>(a, { status: 201 })),
      http.delete(`${API}/routing-rules/:id`, () => new HttpResponse(null, { status: 204 })),
    );
    const { queryClient, Wrapper } = wrapper();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const created = renderHook(() => useCreateRoutingRule(), { wrapper: Wrapper });
    const deleted = renderHook(() => useDeleteRoutingRule(), { wrapper: Wrapper });
    await act(async () => {
      await created.result.current.mutateAsync({ name: 'A', enabled: true, conditions: a.conditions, actions: a.actions });
      await deleted.result.current.mutateAsync('a');
    });
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: routingRuleKeys.list() });
  });

  it('the dry run returns the result and leaves the cache alone', async () => {
    server.use(http.post(`${API}/routing-rules/test`, () => HttpResponse.json<RoutingDryRun>(makeDryRun({ matchedRuleId: 'a', matchedRuleName: 'A', actions: a.actions }))));
    const { queryClient, Wrapper } = wrapper();
    const { result } = renderHook(() => useTestRoutingRules(), { wrapper: Wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ message: 'hi' })).resolves.toMatchObject({ matchedRuleId: 'a' });
    });
    expect(cached(queryClient)).toBeUndefined();
  });
});
