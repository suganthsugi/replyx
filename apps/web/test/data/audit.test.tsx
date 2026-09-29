import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { useAuditLogs } from '../../src/data/audit';
import { API } from '../msw/handlers';
import { server } from '../setup';

import type { AuditLog, ErrorResponse } from '../../src/api/generated/model';

function entry(id: string): AuditLog {
  return {
    id,
    occurredAt: '2026-01-01T00:00:00.000Z',
    actor: { kind: 'user', id: 'u1', name: 'Ada' },
    action: 'settings.updated',
    resourceType: 'tenant',
    resourceId: null,
    details: {},
    ip: null,
  };
}

function renderWithClient<T>(hook: () => T) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  return renderHook(hook, { wrapper });
}

describe('useAuditLogs', () => {
  it('passes the filters and follows the cursor', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      http.get(`${API}/audit-logs`, ({ request }) => {
        const params = new URL(request.url).searchParams;
        seen.push(params);
        return HttpResponse.json(
          params.get('cursor') === null ? { items: [entry('a1')], nextCursor: 'c2' } : { items: [entry('a2')], nextCursor: null },
        );
      }),
    );

    const { result } = renderWithClient(() => useAuditLogs({ action: 'settings.updated', actorId: 'u1' }));
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
    expect(result.current.hasNextPage).toBe(true);
    expect(seen[0]?.get('action')).toBe('settings.updated');
    expect(seen[0]?.get('actorId')).toBe('u1');

    await result.current.fetchNextPage();
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    expect(seen[1]?.get('cursor')).toBe('c2');
    expect(result.current.hasNextPage).toBe(false);
  });

  it('maps errors', async () => {
    server.use(
      http.get(`${API}/audit-logs`, () =>
        HttpResponse.json<ErrorResponse>({ error: { code: 'FORBIDDEN', message: 'No' } }, { status: 403 }),
      ),
    );
    const { result } = renderWithClient(() => useAuditLogs({}));
    await waitFor(() => expect(result.current.error?.code).toBe('FORBIDDEN'));
  });
});
