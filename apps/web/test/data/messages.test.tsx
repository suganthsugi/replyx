import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { useSendTicketMessage, useTicketMessages } from '../../src/data/messages';
import { API } from '../msw/handlers';
import { server } from '../setup';

import type { Message } from '../../src/api/generated/model';

/**
 * Regression for T157/T158: `POST /tickets/:id/messages` can resolve before the list query has
 * loaded (or while its cached snapshot predates the send). The sent reply must stay visible,
 * exactly once, whether the list then loads without it (stale snapshot, patched in place) or with
 * it (server already has it, deduped by `clientMessageId`).
 */

function renderWithClient<T>(hook: () => T) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, ...renderHook(hook, { wrapper }) };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    ticketId: 't1',
    author: { id: 'u1', name: 'Ada', avatarUrl: null },
    authorKind: 'staff',
    visibility: 'public',
    body: 'On it',
    mentions: [],
    attachments: [],
    clientMessageId: 'client-1',
    deliveredAt: null,
    readAt: null,
    movedFromTicketId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('useSendTicketMessage / useTicketMessages race', () => {
  it('keeps a sent message visible exactly once while the list is still loading, and after it loads with or without it', async () => {
    const ticketId = 't1';
    let resolveList: ((value: { items: Message[]; nextCursor: null }) => void) | undefined;
    let listCalls = 0;

    server.use(
      http.get(`${API}/tickets/${ticketId}/messages`, () => {
        listCalls += 1;
        if (listCalls === 1) {
          // The list query never resolves until the test says so: simulates the POST winning the
          // race against the initial load.
          return new Promise((resolve) => {
            resolveList = (value) => resolve(HttpResponse.json(value));
          });
        }
        // Second call (a refetch): the list has since caught up and includes the sent message.
        return HttpResponse.json({ items: [makeMessage()], nextCursor: null });
      }),
      http.post(`${API}/tickets/${ticketId}/messages`, () => HttpResponse.json(makeMessage())),
    );

    const { result } = renderWithClient(() => ({
      messages: useTicketMessages(ticketId),
      send: useSendTicketMessage(ticketId),
    }));

    expect(result.current.messages.isPending).toBe(true);

    await result.current.send.send({ visibility: 'public', body: 'On it' });

    // The POST resolved while the list is still loading: the message must show up anyway.
    await waitFor(() => {
      const bodies = result.current.messages.items.filter((item) => item.body === 'On it');
      expect(bodies).toHaveLength(1);
    });
    expect(result.current.messages.isPending).toBe(true);

    // The list loads without the message (a stale snapshot from before the send): still shown
    // exactly once, from the outbox.
    resolveList?.({ items: [], nextCursor: null });
    await waitFor(() => expect(result.current.messages.isPending).toBe(false));
    expect(result.current.messages.items.filter((item) => item.body === 'On it')).toHaveLength(1);

    // The list catches up and now includes the message itself: still shown exactly once, this
    // time from the fetched list (the outbox entry is pruned).
    await result.current.messages.refetch();
    await waitFor(() => expect(result.current.messages.items.filter((item) => item.body === 'On it')).toHaveLength(1));
    expect(result.current.messages.items.find((item) => item.body === 'On it')?.id).toBe('m1');
  });
});
