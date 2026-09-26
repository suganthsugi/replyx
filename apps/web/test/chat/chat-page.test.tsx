import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { RealtimeProvider } from '../../src/data/realtime';
import ChatPage from '../../src/pages/customer/ChatPage';
import { API, branding } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import { conversationEvent, conversationPage, FakeSocket, me, myMessage, supportMessage, thread } from './fixtures';

import type { ConversationMessage, ErrorResponse, SendCustomerMessageBody, ThreadItem } from '../../src/api/generated/model';

const polite = () => document.querySelector('[aria-live="polite"]');

function renderChat(items: ThreadItem[] = thread) {
  server.use(http.get(`${API}/customer/conversation`, () => HttpResponse.json(conversationPage(items))));
  const socket = new FakeSocket();
  const createSocket = () => socket;
  const view = renderWithProviders(
    <RealtimeProvider namespace="/customer" userId={me.id} createSocket={createSocket}>
      <ChatPage me={me} branding={{ ...branding, tenantName: 'Acme' }} />
    </RealtimeProvider>,
  );
  return { socket, ...view };
}

async function connected(socket: FakeSocket) {
  await waitFor(() => expect(socket.handlers.size).toBeGreaterThan(0));
  act(() => socket.open());
}

beforeEach(() => {
  sessionStorage.clear();
  server.use(http.post(`${API}/customer/messages/read`, () => new HttpResponse(null, { status: 204 })));
});

describe('ChatPage', () => {
  it('shows the conversation with no ticket concepts, even when the API leaks them', async () => {
    const { container } = renderChat();
    expect(await screen.findByText('Checking with the warehouse now.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Acme Support' })).toBeInTheDocument();
    expect(screen.getByText(/Glad we could help/)).toBeInTheDocument();

    const text = container.textContent ?? '';
    expect(text).not.toMatch(/ticket/i);
    for (const leaked of ['1001', '#1001', 'pending', 'Billing Escalations', 'Olga Owner', 'urgent', 'breached', 'SLA', 'refund abuse', 'Internal note']) {
      expect(text).not.toContain(leaked);
    }
    await expectNoAxeViolations(container);
  });

  it('greets a customer with no messages yet', async () => {
    const { container } = renderChat([]);
    expect(await screen.findByRole('heading', { name: 'Hi there, how can we help?' })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('marks the newest support reply read', async () => {
    const reads: unknown[] = [];
    server.use(
      http.post(`${API}/customer/messages/read`, async ({ request }) => {
        reads.push(await request.json());
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderChat();
    await waitFor(() => expect(reads).toEqual([{ upToMessageId: 'm4' }]));
  });

  it('sends optimistically with a clientMessageId and signals typing', async () => {
    const bodies: SendCustomerMessageBody[] = [];
    server.use(
      http.post(`${API}/customer/messages`, async ({ request }) => {
        const body = (await request.json()) as SendCustomerMessageBody;
        bodies.push(body);
        return HttpResponse.json<ConversationMessage>({ ...myMessage('m9', body.body, body.clientMessageId, new Date().toISOString()), delivery: 'sent' }, { status: 201 });
      }),
    );
    const { socket } = renderChat();
    await screen.findByText('Checking with the warehouse now.');
    await connected(socket);

    await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), 'Where is my parcel?{Enter}');

    const conversation = screen.getByRole('region', { name: 'Conversation' });
    const bubble = await within(conversation).findByText('Where is my parcel?');
    await waitFor(() => expect(bubble.closest('li')).toHaveTextContent('Sent'));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.clientMessageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(socket.emitted).toContainEqual(['customer.typing', { state: 'start' }]);
    expect(socket.emitted).toContainEqual(['customer.typing', { state: 'stop' }]);
  });

  it('keeps a rate-limited message with a countdown and retries it with the same clientMessageId', async () => {
    const ids: string[] = [];
    server.use(
      http.post<never, SendCustomerMessageBody, ConversationMessage | ErrorResponse>(`${API}/customer/messages`, async ({ request }) => {
        const body = (await request.json());
        ids.push(body.clientMessageId);
        if (ids.length === 1) {
          return HttpResponse.json<ErrorResponse>(
            { error: { code: 'RATE_LIMITED', message: "You're sending messages a bit fast. Please wait a moment.", retryAfter: 20 } },
            { status: 429 },
          );
        }
        return HttpResponse.json<ConversationMessage>({ ...myMessage('m10', body.body, body.clientMessageId, new Date().toISOString()), delivery: 'sent' }, { status: 201 });
      }),
    );
    renderChat();
    await screen.findByText('Checking with the warehouse now.');

    await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), 'Hello?{Enter}');
    expect(await screen.findByText(/Not sent/)).toBeInTheDocument();
    expect(screen.getByText(/You can send again in 20 seconds/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText(/Not sent/)).not.toBeInTheDocument());
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
  });

  it('shows support replies, typing and delivery live from the conversation stream', async () => {
    const { socket } = renderChat();
    await screen.findByText('Checking with the warehouse now.');
    await connected(socket);

    act(() => socket.fire('ephemeral', { type: 'conversation.typing', stream: 'conversation', data: { name: 'Ann Agent', avatarUrl: null, state: 'start' } }));
    const conversation = screen.getByRole('region', { name: 'Conversation' });
    expect(within(conversation).getByText('Ann Agent is typing')).toBeInTheDocument();

    act(() => socket.fire('event', conversationEvent('conversation.message', supportMessage('m5', 'It ships today.', new Date().toISOString()))));
    expect(await within(conversation).findByText('It ships today.')).toBeInTheDocument();
    expect(within(conversation).queryByText('Ann Agent is typing')).not.toBeInTheDocument();
    expect(polite()).toHaveTextContent('Ann Agent says: It ships today.');

    act(() => socket.fire('event', conversationEvent('conversation.status', { code: 'answered', text: 'Support has replied' })));
    act(() => socket.fire('event', conversationEvent('conversation.delivery', { messageId: 'm3', delivery: 'read' })));
    expect(screen.getByText('My new order has not shipped.').closest('li')).toHaveTextContent('Read');
  });

  it('warns while reconnecting', async () => {
    const { socket } = renderChat();
    await screen.findByText('Checking with the warehouse now.');
    await connected(socket);
    act(() => socket.drop());
    expect(screen.getByText(/Messages you send will reach us once you're back online/)).toBeInTheDocument();
    act(() => socket.open());
    expect(screen.queryByText(/Messages you send will reach us/)).not.toBeInTheDocument();
  });

  it('opens the profile sheet from the header', async () => {
    renderChat();
    await userEvent.click(await screen.findByRole('button', { name: 'Your profile' }));
    const sheet = await screen.findByRole('dialog', { name: 'Your profile' });
    expect(within(sheet).getByRole('textbox', { name: 'Name' })).toHaveValue('Cam Customer');
    expect(within(sheet).getByRole('button', { name: 'Sign out everywhere' })).toBeInTheDocument();
    await expectNoAxeViolations(sheet);
  });
});
