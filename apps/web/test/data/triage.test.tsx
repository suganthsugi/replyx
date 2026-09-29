import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { ticketKeys } from '../../src/data/tickets';
import { useTriageTicket } from '../../src/data/triage';
import { viewCountKeys } from '../../src/data/view-counts';
import { API, errorResponse } from '../msw/handlers';
import { server } from '../setup';

import type { Ticket, TicketSummary } from '../../src/api/generated/model';

/**
 * `useTriageTicket` (US5, T178): sets the group (and optionally owner/priority/tags) of an
 * ungrouped ticket in one step, then reconciles the ticket detail cache, every cached list and the
 * view counts depending on whether the caller can still see the ticket afterward.
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

function makeSummary(id: string): TicketSummary {
  return {
    id,
    number: 1,
    title: 'Ungrouped ticket',
    state: 'open',
    priority: 'high',
    waitingOn: 'support',
    group: null,
    owner: null,
    customer: { id: 'c1', name: 'Ada Lovelace' },
    tags: [],
    sla: { status: 'none' },
    lastCustomerMessageAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('useTriageTicket', () => {
  it('writes the returned ticket into the detail cache and refreshes lists and counts when still visible', async () => {
    const ticketId = 't1';
    server.use(
      http.post(`${API}/tickets/${ticketId}/triage`, () =>
        HttpResponse.json({ visibleToCaller: true, ticket: makeTicket(ticketId, { group: { id: 'g2', name: 'Billing' } }) }),
      ),
    );

    const { result, queryClient } = renderWithClient(() => useTriageTicket(ticketId));
    queryClient.setQueryData(ticketKeys.list({}), { pages: [{ items: [makeSummary(ticketId)], nextCursor: null }], pageParams: [undefined] });

    const response = await result.current.mutateAsync({ groupId: 'g2' });

    expect(response.visibleToCaller).toBe(true);
    await waitFor(() => {
      const cached = queryClient.getQueryData<Ticket>(ticketKeys.detail(ticketId));
      expect(cached?.group?.id).toBe('g2');
    });
  });

  it('removes the ticket from every cached list and drops its detail cache when no longer visible', async () => {
    const ticketId = 't2';
    server.use(http.post(`${API}/tickets/${ticketId}/triage`, () => HttpResponse.json({ visibleToCaller: false })));

    const { result, queryClient } = renderWithClient(() => useTriageTicket(ticketId));
    queryClient.setQueryData(ticketKeys.list({}), { pages: [{ items: [makeSummary(ticketId)], nextCursor: null }], pageParams: [undefined] });
    queryClient.setQueryData(ticketKeys.detail(ticketId), makeTicket(ticketId));

    const response = await result.current.mutateAsync({ groupId: 'g3' });

    expect(response.visibleToCaller).toBe(false);
    const cachedList = queryClient.getQueryData<{ pages: Array<{ items: TicketSummary[] }> }>(ticketKeys.list({}));
    expect(cachedList?.pages[0]?.items).toEqual([]);
    expect(queryClient.getQueryData(ticketKeys.detail(ticketId))).toBeUndefined();
  });

  it('maps ALREADY_TRIAGED to a friendly message and refetches the ticket', async () => {
    const ticketId = 't3';
    let getCalls = 0;
    server.use(
      http.post(`${API}/tickets/${ticketId}/triage`, () => errorResponse(409, 'ALREADY_TRIAGED', 'Already triaged')),
      http.get(`${API}/tickets/${ticketId}`, () => {
        getCalls += 1;
        return HttpResponse.json(makeTicket(ticketId, { group: { id: 'g4', name: 'Other' } }));
      }),
    );

    const { result } = renderWithClient(() => useTriageTicket(ticketId));

    await expect(result.current.mutateAsync({ groupId: 'g2' })).rejects.toBeTruthy();

    await waitFor(() => expect(result.current.error?.code).toBe('ALREADY_TRIAGED'));
    expect(result.current.error?.message).toBe('Someone else already triaged this ticket.');
    await waitFor(() => expect(getCalls).toBe(1));
  });

  it('treats a 404 as a lost race into an invisible group: resolves alreadyTriaged and drops the ticket', async () => {
    const ticketId = 't6';
    server.use(http.post(`${API}/tickets/${ticketId}/triage`, () => errorResponse(404, 'TICKET_NOT_FOUND', 'Ticket not found')));

    const { result, queryClient } = renderWithClient(() => useTriageTicket(ticketId));
    queryClient.setQueryData(ticketKeys.list({}), { pages: [{ items: [makeSummary(ticketId)], nextCursor: null }], pageParams: [undefined] });
    queryClient.setQueryData(ticketKeys.detail(ticketId), makeTicket(ticketId));

    await expect(result.current.mutateAsync({ groupId: 'g2' })).resolves.toEqual({ visibleToCaller: false, alreadyTriaged: true });

    await waitFor(() => expect(queryClient.getQueryData(ticketKeys.detail(ticketId))).toBeUndefined());
    const cachedList = queryClient.getQueryData<{ pages: Array<{ items: TicketSummary[] }> }>(ticketKeys.list({}));
    expect(cachedList?.pages[0]?.items).toEqual([]);
    expect(result.current.error).toBeUndefined();
  });

  it('survives a failed refetch after ALREADY_TRIAGED', async () => {
    const ticketId = 't7';
    server.use(
      http.post(`${API}/tickets/${ticketId}/triage`, () => errorResponse(409, 'ALREADY_TRIAGED', 'Already triaged')),
      http.get(`${API}/tickets/${ticketId}`, () => errorResponse(404, 'TICKET_NOT_FOUND', 'Ticket not found')),
    );

    const { result } = renderWithClient(() => useTriageTicket(ticketId));
    await expect(result.current.mutateAsync({ groupId: 'g2' })).rejects.toBeTruthy();
    await waitFor(() => expect(result.current.error?.code).toBe('ALREADY_TRIAGED'));
  });

  it('maps GROUP_INACTIVE and OWNER_NOT_ELIGIBLE to friendly messages', async () => {
    const ticketId = 't4';
    server.use(http.post(`${API}/tickets/${ticketId}/triage`, () => errorResponse(409, 'GROUP_INACTIVE', 'inactive')));
    const { result } = renderWithClient(() => useTriageTicket(ticketId));
    await expect(result.current.mutateAsync({ groupId: 'g2' })).rejects.toBeTruthy();
    await waitFor(() => expect(result.current.error?.message).toBe('That group is no longer active. Pick another destination.'));
  });

  it('refreshes view counts after a successful triage', async () => {
    const ticketId = 't5';
    server.use(
      http.post(`${API}/tickets/${ticketId}/triage`, () => HttpResponse.json({ visibleToCaller: true, ticket: makeTicket(ticketId) })),
    );
    const { result, queryClient } = renderWithClient(() => useTriageTicket(ticketId));
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    await result.current.mutateAsync({ groupId: 'g2' });

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: viewCountKeys.all }));
  });
});
