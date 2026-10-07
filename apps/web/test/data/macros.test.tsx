import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { filterMacros, useApplyMacro, useCreateMacro, useDeleteMacro, useMacros } from '../../src/data/macros';
import { API, errorResponse } from '../msw/handlers';
import { server } from '../setup';

import type { ApplyMacroRequest, ErrorResponse, ListMacros200, Macro, MacroInput, Ticket } from '../../src/api/generated/model';

function renderWithClient<T>(hook: () => T) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  return { queryClient, ...renderHook(hook, { wrapper }) };
}

function macro(overrides: Partial<Macro> = {}): Macro {
  return { id: 'm1', name: 'Greeting', body: 'Hello there', actions: {}, visibility: 'all_staff', sharedRoleIds: [], sharedGroupIds: [], ...overrides };
}

describe('filterMacros', () => {
  const list = [macro({ id: 'a', name: 'Refund policy', body: 'We refund' }), macro({ id: 'b', name: 'Greeting', body: 'refund me not' }), macro({ id: 'c', name: 'Re-open', body: 'x' })];

  it('returns everything for an empty query', () => expect(filterMacros(list, '  ')).toHaveLength(3));
  it('ranks name prefix, then name, then body matches', () => expect(filterMacros(list, 're').map((m) => m.id)).toEqual(['c', 'a', 'b']));
  it('is case-insensitive and drops non-matches', () => expect(filterMacros(list, 'GREET').map((m) => m.id)).toEqual(['b']));
});

describe('macro hooks', () => {
  it('lists, creates and deletes with cache updates', async () => {
    let items: Macro[] = [macro()];
    server.use(
      http.get(`${API}/macros`, () => HttpResponse.json<ListMacros200>({ items })),
      http.post(`${API}/macros`, async ({ request }) => {
        const body = (await request.json()) as MacroInput;
        const created = macro({ id: 'm2', name: body.name, body: body.body });
        items = [...items, created];
        return HttpResponse.json<Macro>(created, { status: 201 });
      }),
      http.delete(`${API}/macros/m1`, () => {
        items = items.filter((m) => m.id !== 'm1');
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { result } = renderWithClient(() => ({ list: useMacros(), create: useCreateMacro(), del: useDeleteMacro() }));
    await waitFor(() => expect(result.current.list.data).toHaveLength(1));
    await act(() => result.current.create.mutateAsync({ name: 'Bye', body: 'Goodbye' }));
    await waitFor(() => expect(result.current.list.data?.map((m) => m.name)).toEqual(['Greeting', 'Bye']));
    await act(() => result.current.del.mutateAsync({ id: 'm1' }));
    await waitFor(() => expect(result.current.list.data?.map((m) => m.id)).toEqual(['m2']));
  });

  it('exposes a mapped error when listing is forbidden', async () => {
    server.use(http.get(`${API}/macros`, () => errorResponse(403, 'PERMISSION_DENIED')));
    const { result } = renderWithClient(() => useMacros());
    await waitFor(() => expect(result.current.error?.code).toBe('PERMISSION_DENIED'));
  });
});

describe('useApplyMacro', () => {
  const ticket = { id: 't1' } as Ticket;

  it('reuses the clientMessageId after a failed attempt and renews it after success', async () => {
    const ids: string[] = [];
    let fail = true;
    server.use(
      http.post<never, ApplyMacroRequest, Ticket | ErrorResponse>(`${API}/tickets/t1/apply-macro`, async ({ request }) => {
        const body = await request.json();
        ids.push(body.clientMessageId);
        return fail ? errorResponse(422, 'INVALID_TRANSITION') : HttpResponse.json(ticket);
      }),
    );
    const { result, queryClient } = renderWithClient(() => useApplyMacro('t1'));
    await act(async () => {
      await expect(result.current.mutateAsync({ macroId: 'm1' })).rejects.toBeDefined();
    });
    await waitFor(() => expect(result.current.error?.code).toBe('INVALID_TRANSITION'));
    expect(result.current.error?.message).toMatch(/can't change/);
    fail = false;
    await act(() => result.current.mutateAsync({ macroId: 'm1' }));
    await act(() => result.current.mutateAsync({ macroId: 'm1' }));
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(queryClient.getQueryData(['tickets', 'detail', 't1'])).toEqual(ticket);
  });

  it('maps MACRO_NOT_FOUND', async () => {
    server.use(http.post(`${API}/tickets/t1/apply-macro`, () => errorResponse(404, 'MACRO_NOT_FOUND')));
    const { result } = renderWithClient(() => useApplyMacro('t1'));
    await act(async () => {
      await expect(result.current.mutateAsync({ macroId: 'x' })).rejects.toBeDefined();
    });
    await waitFor(() => expect(result.current.error?.message).toMatch(/no longer exists/));
  });
});
