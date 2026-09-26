import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { useTicketHistory, useUpdateTicket } from '../../src/data/tickets';
import { API } from '../msw/handlers';
import { server } from '../setup';

import type { Ticket } from '../../src/api/generated/model';

/**
 * `useTicketHistory` must refetch after `useUpdateTicket` succeeds (US6/T157): the History tab
 * showed "No history yet" forever because nothing invalidated `ticketKeys.history(id)` after an
 * owner/priority/state change.
 */

function renderWithClient<T>(hook: () => T) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, ...renderHook(hook, { wrapper }) };
}

function makeTicket(id: string, overrides: Partial<Ticket> = {}): Ticket {
  return {
    id,
    number: 1,
    title: 'Cannot log in',
    state: 'open',
    priority: 'high',
    waitingOn: 'support',
    group: { id: 'g1', name: 'Support' },
    owner: null,
    customer: { id: 'c1', name: 'Ada Lovelace' },
    tags: [],
    sla: { status: 'none' },
    lastCustomerMessageAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    pendingUntil: null,
    autoCloseAt: null,
    resolvedAt: null,
    closedAt: null,
    lastAgentReplyAt: null,
    origin: 'staff_started',
    mergedInto: null,
    links: [],
    csat: null,
    allowedActions: [],
    ...overrides,
  };
}

describe('useTicketHistory + useUpdateTicket', () => {
  it('refetches history after a successful update', async () => {
    const ticketId = 't1';
    let historyCalls = 0;
    server.use(
      http.get(`${API}/tickets/${ticketId}/history`, () => {
        historyCalls += 1;
        return HttpResponse.json({ items: [], nextCursor: null });
      }),
      http.patch(`${API}/tickets/${ticketId}`, () => HttpResponse.json(makeTicket(ticketId, { priority: 'urgent' }))),
    );

    const { result } = renderWithClient(() => ({
      history: useTicketHistory(ticketId),
      update: useUpdateTicket(),
    }));

    await waitFor(() => expect(historyCalls).toBe(1));
    expect(result.current.history.items).toEqual([]);

    await result.current.update.mutateAsync({ id: ticketId, priority: 'urgent' });

    await waitFor(() => expect(historyCalls).toBe(2));
  });
});
