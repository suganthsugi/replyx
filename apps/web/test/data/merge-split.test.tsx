import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { groupKeys } from '../../src/data/groups';
import { ticketActionMessage, useBulkUpdateTickets, useMergeTicket, useSplitTicket } from '../../src/data/merge-split';
import { useAvailabilityUpdates } from '../../src/data/presence';
import { RealtimeClient, type RealtimeSocket } from '../../src/data/socket';
import { ticketKeys } from '../../src/data/tickets';
import { API, errorResponse } from '../msw/handlers';
import { server } from '../setup';

import type { BulkUpdateTickets200, BulkUpdateTicketsBody, EligibleOwner, MergeTicketBody, SplitTicketBody, Ticket } from '../../src/api/generated/model';

function renderWithClient<T>(hook: () => T, queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  return { queryClient, ...renderHook(hook, { wrapper }) };
}

describe('useMergeTicket', () => {
  it('posts the target, stores the returned target ticket and invalidates the source', async () => {
    let sent: MergeTicketBody | undefined;
    server.use(
      http.post<never, MergeTicketBody, Ticket>(`${API}/tickets/src/merge`, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({ id: 'tgt' } as Ticket);
      }),
    );
    const { result, queryClient } = renderWithClient(() => useMergeTicket('src'));
    queryClient.setQueryData(ticketKeys.detail('src'), { id: 'src' });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    await act(() => result.current.mutateAsync('tgt'));
    expect(sent).toEqual({ targetTicketId: 'tgt' });
    expect(queryClient.getQueryData(ticketKeys.detail('tgt'))).toEqual({ id: 'tgt' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ticketKeys.detail('src') });
  });

  it('maps DIFFERENT_CUSTOMER to a readable message', async () => {
    server.use(http.post(`${API}/tickets/src/merge`, () => errorResponse(409, 'DIFFERENT_CUSTOMER')));
    const { result } = renderWithClient(() => useMergeTicket('src'));
    await act(async () => {
      await expect(result.current.mutateAsync('tgt')).rejects.toBeDefined();
    });
    await waitFor(() => expect(result.current.error?.message).toBe('Only tickets from the same customer can be merged.'));
  });
});

describe('useSplitTicket', () => {
  it('sends a trimmed title only when one is given', async () => {
    const bodies: SplitTicketBody[] = [];
    server.use(
      http.post<never, SplitTicketBody, Ticket>(`${API}/tickets/src/split`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ id: 'new' } as Ticket, { status: 201 });
      }),
    );
    const { result, queryClient } = renderWithClient(() => useSplitTicket('src'));
    await act(() => result.current.mutateAsync({ messageId: 'm1', title: '  New issue  ' }));
    await act(() => result.current.mutateAsync({ messageId: 'm2', title: '   ' }));
    expect(bodies).toEqual([{ messageId: 'm1', title: 'New issue' }, { messageId: 'm2' }]);
    expect(queryClient.getQueryData(ticketKeys.detail('new'))).toEqual({ id: 'new' });
  });
});

describe('useBulkUpdateTickets', () => {
  it('returns the per-ticket results, including refusals', async () => {
    let sent: BulkUpdateTicketsBody | undefined;
    server.use(
      http.post<never, BulkUpdateTicketsBody, BulkUpdateTickets200>(`${API}/tickets/bulk`, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({ results: [{ ticketId: 'a', ok: true }, { ticketId: 'b', ok: false, errorCode: 'PERMISSION_DENIED' }] });
      }),
    );
    const { result } = renderWithClient(() => useBulkUpdateTickets());
    let results: Awaited<ReturnType<typeof result.current.mutateAsync>> = [];
    await act(async () => {
      results = await result.current.mutateAsync(['a', 'b'], { priority: 'high' });
    });
    expect(sent).toEqual({ ticketIds: ['a', 'b'], changes: { priority: 'high' } });
    expect(results).toEqual([{ ticketId: 'a', ok: true }, { ticketId: 'b', ok: false, errorCode: 'PERMISSION_DENIED' }]);
    expect(ticketActionMessage('PERMISSION_DENIED')).toMatch(/permission/);
    expect(ticketActionMessage('SOMETHING_ELSE')).toBe('This ticket could not be updated.');
  });
});

class FakeSocket implements RealtimeSocket {
  connected = false;
  handlers = new Map<string, ((...args: never[]) => void)[]>();
  disconnect = vi.fn();

  on(event: string, listener: (...args: never[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
  }
  emit() {}
  timeout() {
    return { emitWithAck: () => Promise.resolve({ ok: true, upToSeq: 0, resyncRequired: [] }) };
  }
  connect() {}
  fire(event: string, payload?: unknown) {
    for (const handler of this.handlers.get(event) ?? []) (handler as (p: unknown) => void)(payload);
  }
}

describe('useAvailabilityUpdates', () => {
  it('updates the user in every cached eligible-owner list', () => {
    const socket = new FakeSocket();
    const queryClient = new QueryClient();
    const client = new RealtimeClient({ namespace: '/', userId: 'me-availability', queryClient, createSocket: () => socket });
    const owner = (id: string, availability: EligibleOwner['availability']) => ({ id, name: id, avatarUrl: null, availability, openTicketCount: 0 }) as EligibleOwner;
    queryClient.setQueryData(groupKeys.eligibleOwners('g1'), { items: [owner('u1', 'online'), owner('u2', 'online')] });
    queryClient.setQueryData(groupKeys.eligibleOwners('g2'), { items: [owner('u3', 'online')] });

    renderWithClient(() => useAvailabilityUpdates(client), queryClient);
    act(() => socket.fire('ephemeral', { type: 'availability.changed', stream: 'tickets', data: { userId: 'u1', availability: 'away' } }));

    const g1 = queryClient.getQueryData<{ items: EligibleOwner[] }>(groupKeys.eligibleOwners('g1'));
    expect(g1?.items.map((o) => o.availability)).toEqual(['away', 'online']);
    expect(queryClient.getQueryData<{ items: EligibleOwner[] }>(groupKeys.eligibleOwners('g2'))?.items[0]?.availability).toBe('online');
  });
});
