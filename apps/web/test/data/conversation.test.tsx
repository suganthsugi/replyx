import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { conversationKeys, useConversation, useSendMessage } from '../../src/data/conversation';
import { API } from '../msw/handlers';
import { server } from '../setup';

import type { ConversationMessage, GetConversation200, SendCustomerMessageBody } from '../../src/api/generated/model';

/**
 * Regression for T157/T158, customer path: `POST /customer/messages` can resolve before the
 * conversation query has loaded (or while its cached snapshot predates the send). The sent
 * message must stay visible, exactly once, whether the thread then loads without it (stale
 * snapshot, patched in place) or with it (server already has it, deduped by `clientMessageId`,
 * the same value the API echoes back).
 */

function renderWithClient<T>(hook: () => T) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, ...renderHook(hook, { wrapper }) };
}

function makeMessage(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: 'm1',
    from: { kind: 'me' },
    body: 'On it',
    attachments: [],
    clientMessageId: null,
    delivery: 'sent',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeThread(items: ConversationMessage[]): GetConversation200 {
  return {
    items: items.map((message) => ({ type: 'message' as const, message })),
    olderCursor: null,
    status: { code: 'idle', text: 'Idle' },
    streamSeq: 1,
  };
}

describe('useSendMessage / useConversation race', () => {
  it('keeps a sent message visible exactly once while the thread is still loading, and after it loads with or without it', async () => {
    let resolveThread: ((value: GetConversation200) => void) | undefined;
    let threadCalls = 0;
    // The API echoes back the request's `clientMessageId` (idempotent send): capture it from the
    // POST body so the "thread catches up" response can carry the same value.
    let sentClientMessageId: string | null | undefined;

    server.use(
      http.get(`${API}/customer/conversation`, () => {
        threadCalls += 1;
        if (threadCalls === 1) {
          // The thread query never resolves until the test says so: simulates the POST winning
          // the race against the initial load.
          return new Promise((resolve) => {
            resolveThread = (value) => resolve(HttpResponse.json(value));
          });
        }
        // A later call (a refetch): the thread has since caught up and includes the sent message.
        return HttpResponse.json(makeThread([makeMessage({ clientMessageId: sentClientMessageId ?? null })]));
      }),
      http.post(`${API}/customer/messages`, async ({ request }) => {
        const body = (await request.json()) as SendCustomerMessageBody;
        sentClientMessageId = body.clientMessageId;
        return HttpResponse.json(makeMessage({ clientMessageId: body.clientMessageId }));
      }),
    );

    const { result, queryClient } = renderWithClient(() => ({
      conversation: useConversation(),
      send: useSendMessage(),
    }));

    expect(result.current.conversation.isPending).toBe(true);

    await result.current.send.send('On it');

    // The POST resolved while the thread is still loading: the message must show up anyway.
    await waitFor(() => {
      const bodies = result.current.conversation.items.filter((item) => item.kind === 'message' && item.body === 'On it');
      expect(bodies).toHaveLength(1);
    });
    expect(result.current.conversation.isPending).toBe(true);

    // The thread loads without the message (a stale snapshot from before the send): still shown
    // exactly once, from the outbox.
    resolveThread?.(makeThread([]));
    await waitFor(() => expect(result.current.conversation.isPending).toBe(false));
    expect(result.current.conversation.items.filter((item) => item.kind === 'message' && item.body === 'On it')).toHaveLength(1);

    // The thread catches up and now includes the message itself: still shown exactly once, this
    // time from the fetched thread (the outbox entry is pruned, not just deduped in the render).
    await result.current.conversation.refetch();
    await waitFor(() =>
      expect(result.current.conversation.items.filter((item) => item.kind === 'message' && item.body === 'On it')).toHaveLength(1),
    );
    await waitFor(() => expect(queryClient.getQueryData(conversationKeys.outbox())).toEqual([]));
  });
});
