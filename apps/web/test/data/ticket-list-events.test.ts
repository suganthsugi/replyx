import { QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { RealtimeClient, type Envelope, type RealtimeSocket } from '../../src/data/socket';
import { ticketKeys, useTicketListEvents, useTicketRemovedFromView, type TicketSummary } from '../../src/data/tickets';
import { API } from '../msw/handlers';
import { server } from '../setup';

/**
 * Regression: the server's `ticket.created` payload is `{ ticket: TicketSummaryDto }`
 * (apps/api/src/platform-kernel/outbox/event-types.ts), not a bare `TicketSummary`. Unwrapping it
 * wrong inserts `{ ticket }` into the cached list, which crashes `TicketRow` on `ticket.customer`.
 */

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

const envelope = (data: unknown): Envelope => ({
  id: 'evt-1',
  seq: 1,
  stream: 'tickets',
  type: 'ticket.created',
  occurredAt: '2026-09-27T10:00:00.000Z',
  actor: { kind: 'system' },
  data,
});

function makeTicketSummary(overrides: Partial<TicketSummary> = {}): TicketSummary {
  return {
    id: 't1',
    number: 1,
    title: 'Cannot sign in',
    state: 'open',
    priority: 'normal',
    waitingOn: 'support',
    group: null,
    owner: null,
    customer: { id: 'c1', name: 'Ada Lovelace', avatarUrl: null },
    tags: [],
    sla: null,
    lastCustomerMessageAt: null,
    createdAt: '2026-09-27T09:00:00.000Z',
    updatedAt: '2026-09-27T09:00:00.000Z',
    ...overrides,
  } as TicketSummary;
}

// One userId per test: cursors persist in sessionStorage per user (see notifications.test.tsx).
let nextUserId = 0;

function setup() {
  const socket = new FakeSocket();
  const queryClient = new QueryClient();
  const client = new RealtimeClient({ namespace: '/', userId: `u${(nextUserId += 1)}`, queryClient, createSocket: () => socket });
  return { socket, queryClient, client };
}

describe('useTicketListEvents', () => {
  it('unwraps the server ticket.created payload and adds a well-formed ticket to a cached list', () => {
    const { socket, queryClient, client } = setup();
    const filters = {};
    queryClient.setQueryData(ticketKeys.list(filters), {
      pages: [{ items: [], nextCursor: null }],
      pageParams: [undefined],
    });

    renderHook(() => useTicketListEvents(client));

    const ticket = makeTicketSummary();
    socket.fire('event', envelope({ ticket }));

    const cached = queryClient.getQueryData(ticketKeys.list(filters)) as {
      pages: { items: TicketSummary[] }[];
    };
    expect(cached.pages[0]?.items).toEqual([ticket]);
  });

  it('ignores a malformed ticket.created payload instead of corrupting the list', () => {
    const { socket, queryClient, client } = setup();
    const filters = {};
    queryClient.setQueryData(ticketKeys.list(filters), {
      pages: [{ items: [], nextCursor: null }],
      pageParams: [undefined],
    });

    renderHook(() => useTicketListEvents(client));

    // A payload that isn't the `{ ticket }` shape (e.g. the old, wrong unwrap).
    socket.fire('event', envelope(makeTicketSummary()));

    const cached = queryClient.getQueryData(ticketKeys.list(filters)) as {
      pages: { items: TicketSummary[] }[];
    };
    expect(cached.pages[0]?.items).toEqual([]);
  });
});

const removedEnvelope = (id: string, reason: 'moved' | 'deleted' | 'merged'): Envelope => ({
  id: `evt-removed-${id}-${reason}`,
  seq: 2,
  stream: 'tickets',
  type: 'ticket.removed_from_view',
  occurredAt: '2026-09-27T10:01:00.000Z',
  actor: { kind: 'user', id: 'someone' },
  data: { ticketId: id, reason },
});

describe('ticket.removed_from_view', () => {
  function seed(queryClient: QueryClient) {
    queryClient.setQueryData(ticketKeys.list({}), { pages: [{ items: [makeTicketSummary()], nextCursor: null }], pageParams: [undefined] });
  }
  const cachedItems = (queryClient: QueryClient) =>
    (queryClient.getQueryData(ticketKeys.list({})) as { pages: { items: TicketSummary[] }[] }).pages[0]?.items;

  it('drops a deleted ticket from cached lists', () => {
    const { socket, queryClient, client } = setup();
    seed(queryClient);
    renderHook(() => useTicketListEvents(client));

    socket.fire('event', removedEnvelope('t1', 'deleted'));

    expect(cachedItems(queryClient)).toEqual([]);
  });

  it('refetches lists for a moved ticket instead of dropping it (the viewer may see the new group too)', () => {
    const { socket, queryClient, client } = setup();
    seed(queryClient);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    renderHook(() => useTicketListEvents(client));

    socket.fire('event', removedEnvelope('t1', 'moved'));

    expect(cachedItems(queryClient)).toHaveLength(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: [...ticketKeys.all, 'list'] });
  });

  it('closes an open ticket on a move only when the ticket is no longer visible', async () => {
    const { socket, client } = setup();
    const onRemoved = vi.fn();
    renderHook(() => useTicketRemovedFromView(client, onRemoved));

    server.use(http.get(`${API}/tickets/t1`, () => HttpResponse.json({ ...makeTicketSummary(), links: [], allowedActions: [] })));
    socket.fire('event', removedEnvelope('t1', 'moved'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onRemoved).not.toHaveBeenCalled();

    server.use(
      http.get(`${API}/tickets/t2`, () => HttpResponse.json({ error: { code: 'TICKET_NOT_FOUND', message: 'Ticket not found' } }, { status: 404 })),
    );
    socket.fire('event', removedEnvelope('t2', 'moved'));
    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith({ ticketId: 't2', reason: 'moved' }));
  });
});
