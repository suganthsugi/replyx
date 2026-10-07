import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { splitHighlight, useQuickSearch, useSearchResults } from '../../src/data/search';
import { API, errorResponse } from '../msw/handlers';
import { server } from '../setup';

import type { SearchCustomerResult, SearchTickets200 } from '../../src/api/generated/model';

function customer(id: string): SearchCustomerResult {
  return { type: 'customer', customer: { id, name: `Customer ${id}` }, email: `${id}@example.com` };
}

function renderWithClient<T, P>(hook: (props: P) => T, initialProps: P) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  return renderHook(hook, { wrapper, initialProps });
}

describe('splitHighlight', () => {
  it('splits on the markers', () => {
    expect(splitHighlight('Refund ⟦policy⟧ for orders')).toEqual([
      { text: 'Refund ', match: false },
      { text: 'policy', match: true },
      { text: ' for orders', match: false },
    ]);
  });
  it('handles empty, plain, adjacent and unbalanced input without producing HTML', () => {
    expect(splitHighlight(undefined)).toEqual([]);
    expect(splitHighlight('')).toEqual([]);
    expect(splitHighlight('plain')).toEqual([{ text: 'plain', match: false }]);
    expect(splitHighlight('⟦a⟧⟦b⟧')).toEqual([
      { text: 'a', match: true },
      { text: 'b', match: true },
    ]);
    expect(splitHighlight('x ⟦open')).toEqual([
      { text: 'x ', match: false },
      { text: 'open', match: true },
    ]);
    expect(splitHighlight('stray⟧ end')).toEqual([
      { text: 'stray', match: false },
      { text: ' end', match: false },
    ]);
    expect(splitHighlight('<b>hi</b>')).toEqual([{ text: '<b>hi</b>', match: false }]);
  });
});

describe('useQuickSearch', () => {
  it('does not request for empty or whitespace-only input', async () => {
    let calls = 0;
    server.use(http.get(`${API}/search`, () => { calls += 1; return HttpResponse.json<SearchTickets200>({ items: [], nextCursor: null }); }));
    const { result } = renderWithClient((q: string) => useQuickSearch(q, { debounceMs: 0 }), '   ');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(0);
    expect(result.current.data).toBeUndefined();
  });

  it('debounces, trims and sends a small limit with type=all', async () => {
    const seen: URL[] = [];
    server.use(http.get(`${API}/search`, ({ request }) => {
      seen.push(new URL(request.url));
      return HttpResponse.json<SearchTickets200>({ items: [customer('c1')], nextCursor: null });
    }));
    const { result, rerender } = renderWithClient<ReturnType<typeof useQuickSearch>, string>((q) => useQuickSearch(q, { debounceMs: 50 }), '');
    rerender('a');
    rerender('  ann  ');
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.searchParams.get('q')).toBe('ann');
    expect(seen[0]?.searchParams.get('type')).toBe('all');
    expect(seen[0]?.searchParams.get('limit')).toBe('8');
  });

  it('maps errors', async () => {
    server.use(http.get(`${API}/search`, () => errorResponse(403, 'FORBIDDEN', 'No')));
    const { result } = renderWithClient((q: string) => useQuickSearch(q, { debounceMs: 0 }), 'x');
    await waitFor(() => expect(result.current.error?.code).toBe('FORBIDDEN'));
  });
});

describe('useSearchResults', () => {
  it('pages by cursor and refetches on type change', async () => {
    const seen: URLSearchParams[] = [];
    server.use(http.get(`${API}/search`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      seen.push(params);
      if (params.get('type') === 'customers') return HttpResponse.json<SearchTickets200>({ items: [customer('c9')], nextCursor: null });
      return params.get('cursor') === 'next'
        ? HttpResponse.json<SearchTickets200>({ items: [customer('c2')], nextCursor: null })
        : HttpResponse.json<SearchTickets200>({ items: [customer('c1')], nextCursor: 'next' });
    }));
    const { result, rerender } = renderWithClient(({ q, type }: { q: string; type: 'all' | 'customers' }) => useSearchResults(q, type), { q: 'ann', type: 'all' });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.hasNextPage).toBe(true);
    await act(async () => { await result.current.fetchNextPage(); });
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.hasNextPage).toBe(false);
    expect(seen[1]?.get('cursor')).toBe('next');
    rerender({ q: 'ann', type: 'customers' });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(seen.at(-1)?.get('type')).toBe('customers');
  });

  it('is disabled for whitespace-only queries', () => {
    const { result } = renderWithClient(({ q }: { q: string }) => useSearchResults(q), { q: '  ' });
    expect(result.current.fetchStatus).toBe('idle');
    expect(result.current.items).toEqual([]);
  });
});
