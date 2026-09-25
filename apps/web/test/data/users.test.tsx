import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { useUsers } from '../../src/data/users';
import { API, errorResponse } from '../msw/handlers';
import { server } from '../setup';

import type { User } from '../../src/api/generated/model';

/**
 * Unit tests for `useUsers` (T070): cursor pagination via `fetchNextPage`, and a permission
 * failure surfaces as a mapped `UiError`.
 */

function renderWithClient<T>(hook: () => T) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, ...renderHook(hook, { wrapper }) };
}

function makeUser(id: string): User {
  return { id, email: `${id}@example.com`, name: id, kind: 'staff', status: 'active', roles: [] };
}

describe('useUsers', () => {
  it('paginates through cursor pages', async () => {
    server.use(
      http.get(`${API}/users`, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        if (cursor === null) {
          return HttpResponse.json({ items: [makeUser('a'), makeUser('b')], nextCursor: 'page2' });
        }
        expect(cursor).toBe('page2');
        return HttpResponse.json({ items: [makeUser('c')], nextCursor: null });
      }),
    );
    const { result } = renderWithClient(() => useUsers({}));

    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
    expect(result.current.data?.pages[0]?.items.map((u) => u.id)).toEqual(['a', 'b']);
    expect(result.current.hasNextPage).toBe(true);

    await result.current.fetchNextPage();

    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    expect(result.current.data?.pages[1]?.items.map((u) => u.id)).toEqual(['c']);
    expect(result.current.hasNextPage).toBe(false);
  });

  it('maps a permission failure to a UiError', async () => {
    server.use(
      http.get(`${API}/users`, () => errorResponse(403, 'PERMISSION_DENIED', 'Missing user.view')),
    );
    const { result } = renderWithClient(() => useUsers({}));

    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.error).toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});
