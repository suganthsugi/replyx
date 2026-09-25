import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { useMe, useSignIn } from '../../src/data/auth';
import { API, errorResponse } from '../msw/handlers';
import { server } from '../setup';

import type { Me } from '../../src/api/generated/model';

/**
 * Unit tests for the staff auth hooks (T070): `useSignIn` sets the `/me` cache on success, and
 * failures come back as a mapped `UiError` rather than an `HttpError`.
 */

function renderWithClient<T>(hook: () => T) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, ...renderHook(hook, { wrapper }) };
}

const me: Me = {
  id: 'u1',
  email: 'ash@example.com',
  name: 'Ash',
  kind: 'staff',
  roles: [],
  permissions: [],
  groupAccess: [],
  accessVersion: 1,
};

describe('useSignIn', () => {
  it('sets the /me query data on success', async () => {
    server.use(
      http.post(`${API}/auth/sign-in`, () => HttpResponse.json(me)),
    );
    const { result, queryClient } = renderWithClient(() => useSignIn());

    await result.current.mutateAsync({ email: 'ash@example.com', password: 'password123' });

    expect(queryClient.getQueryData(['me'])).toEqual(me);
  });
});

describe('useMe', () => {
  it('maps a 401 to a UiError instead of retrying', async () => {
    server.use(
      http.get(`${API}/me`, () => errorResponse(401, 'UNAUTHENTICATED', 'Sign in to continue')),
    );
    const { result } = renderWithClient(() => useMe());

    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.error).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(result.current.isPending || result.current.isError).toBe(true);
  });

  it('resolves the current user on success', async () => {
    server.use(http.get(`${API}/me`, () => HttpResponse.json(me)));
    const { result } = renderWithClient(() => useMe());

    await waitFor(() => expect(result.current.data).toEqual(me));
  });
});
