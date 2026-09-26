import { QueryClient } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RealtimeClient, type Envelope, type RealtimeSocket } from '../../src/data/socket';
import { ticketKeys, useTicketListEvents, type TicketSummary } from '../../src/data/tickets';

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

function setup() {
  const socket = new FakeSocket();
  const queryClient = new QueryClient();
  const client = new RealtimeClient({ namespace: '/', userId: 'u1', queryClient, createSocket: () => socket });
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
