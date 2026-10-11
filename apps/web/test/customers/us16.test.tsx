import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';

import { RealtimeProvider } from '../../src/data/realtime';
import ChatPage from '../../src/pages/customer/ChatPage';
import CustomerProfilePage from '../../src/pages/desk/customers/CustomerProfilePage';
import { conversationEvent, conversationPage, FakeSocket, me, thread } from '../chat/fixtures';
import { makeCustomerProfile, makeTicketSummary } from '../desk/fixtures';
import { API, branding } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import type { CustomerHistoryMessage, GetConversation200, ListCustomerMessages200, RateConversationBody } from '../../src/api/generated/model';

/**
 * US16 (T251, T252): the skippable rating prompt in the customer chat (offered from
 * `pendingRating`, refreshed after `conversation.resolved`) and the full customer profile page
 * with satisfaction and the paged message history.
 */

const FIND = { timeout: 10_000 };
const RATING_ID = '0b5f7c1e-4d2a-8c3b-9e1f-112233445566';

function renderChat(firstPage: GetConversation200) {
  let page = firstPage;
  const puts: { id: string; body: RateConversationBody }[] = [];
  server.use(
    http.get(`${API}/customer/conversation`, () => HttpResponse.json(page)),
    http.put(`${API}/customer/ratings/:id`, async ({ request, params }) => {
      puts.push({ id: params['id'] as string, body: (await request.json()) as RateConversationBody });
      page = { ...page, pendingRating: null };
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const socket = new FakeSocket();
  const view = renderWithProviders(
    <RealtimeProvider namespace="/customer" userId={me.id} createSocket={() => socket}>
      <ChatPage me={me} branding={{ ...branding, tenantName: 'Acme' }} />
    </RealtimeProvider>,
  );
  return { socket, puts, setPage: (next: GetConversation200) => (page = next), ...view };
}

beforeEach(() => {
  sessionStorage.clear();
  server.use(http.post(`${API}/customer/messages/read`, () => new HttpResponse(null, { status: 204 })));
});

describe('RatingPrompt in the customer chat', () => {
  it('rates with a score and a comment, then thanks the customer; no ticket wording, no axe violations', async () => {
    const { puts, container } = renderChat(conversationPage(thread, { pendingRating: { ratingId: RATING_ID } }));
    const prompt = await screen.findByRole('form', { name: 'How did we do?' }, FIND);
    expect(within(prompt).queryByText(/ticket/i)).not.toBeInTheDocument();
    await expectNoAxeViolations(container);

    expect(within(prompt).getByRole('button', { name: 'Send rating' })).toBeDisabled();
    await userEvent.click(within(prompt).getByRole('radio', { name: '4 · Good' }));
    expect(within(prompt).getByRole('radio', { name: '4 · Good' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.type(within(prompt).getByRole('textbox', { name: 'Anything to add? (optional)' }), 'Thanks!');
    await userEvent.click(within(prompt).getByRole('button', { name: 'Send rating' }));

    await waitFor(() => expect(puts).toEqual([{ id: RATING_ID, body: { score: 4, comment: 'Thanks!' } }]), FIND);
    await waitFor(() => expect(screen.queryByRole('form', { name: 'How did we do?' })).not.toBeInTheDocument());
    expect(await screen.findByText('Thanks for your feedback', undefined, FIND)).toBeInTheDocument();
  });

  it('Skip sends a skip and hides the prompt', async () => {
    const { puts } = renderChat(conversationPage(thread, { pendingRating: { ratingId: RATING_ID } }));
    const prompt = await screen.findByRole('form', { name: 'How did we do?' }, FIND);
    await userEvent.click(within(prompt).getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(puts).toEqual([{ id: RATING_ID, body: { skip: true } }]), FIND);
    await waitFor(() => expect(screen.queryByRole('form', { name: 'How did we do?' })).not.toBeInTheDocument());
  });

  it('shows no prompt without an offer, and offers one live after support resolves the conversation', async () => {
    const { socket, setPage } = renderChat(conversationPage(thread, { pendingRating: null }));
    await screen.findByText('Checking with the warehouse now.', undefined, FIND);
    expect(screen.queryByRole('form', { name: 'How did we do?' })).not.toBeInTheDocument();

    await waitFor(() => expect(socket.handlers.size).toBeGreaterThan(0));
    act(() => socket.open());
    setPage(conversationPage(thread, { pendingRating: { ratingId: RATING_ID } }));
    act(() => socket.fire('event', conversationEvent('conversation.resolved', { id: 'resolved-1', text: 'Marked as resolved', createdAt: new Date().toISOString() })));
    expect(await screen.findByRole('form', { name: 'How did we do?' }, FIND)).toBeInTheDocument();
  });

  it('keeps the prompt and says what went wrong when saving fails', async () => {
    renderChat(conversationPage(thread, { pendingRating: { ratingId: RATING_ID } }));
    server.use(http.put(`${API}/customer/ratings/:id`, () => HttpResponse.json({ error: { code: 'INTERNAL', message: 'Boom' } }, { status: 500 })));
    const prompt = await screen.findByRole('form', { name: 'How did we do?' }, FIND);
    await userEvent.click(within(prompt).getByRole('radio', { name: '5 · Great' }));
    await userEvent.click(within(prompt).getByRole('button', { name: 'Send rating' }));
    expect(await within(prompt).findByRole('alert', undefined, FIND)).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'How did we do?' })).toBeInTheDocument();
  });
});

function historyMessage(overrides: Partial<CustomerHistoryMessage>): CustomerHistoryMessage {
  return {
    id: 'msg-1',
    ticketId: 'ticket-1',
    ticketNumber: 1001,
    author: null,
    authorKind: 'customer',
    visibility: 'public',
    body: 'Hello',
    mentions: [],
    attachments: [],
    clientMessageId: null,
    deliveredAt: null,
    readAt: null,
    movedFromTicketId: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('CustomerProfilePage', () => {
  function renderProfile(pages: ListCustomerMessages200[]) {
    server.use(
      http.get(`${API}/customers/:id`, () =>
        HttpResponse.json(
          makeCustomerProfile({
            phone: '+44 20 7946 0000',
            company: 'Acme Ltd',
            tags: [{ id: 'tag-1', name: 'vip' }],
            satisfaction: { average: 4.5, responses: 2 },
            openTickets: [makeTicketSummary({ id: 'ticket-2', number: 1002, title: 'Refund request' })],
          }),
        ),
      ),
      http.get(`${API}/customers/:id/messages`, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        return HttpResponse.json(cursor === null ? pages[0] : pages[1]);
      }),
    );
    return renderWithProviders(
      <Routes>
        <Route path="/desk/customers/:id" element={<CustomerProfilePage />} />
      </Routes>,
      { route: '/desk/customers/customer-1' },
    );
  }

  it('shows contact details, tags, satisfaction, tickets and the history with internal notes marked; no axe violations', async () => {
    const { container } = renderProfile([
      {
        items: [
          historyMessage({ id: 'm2', body: 'A note for the team', authorKind: 'staff', visibility: 'internal', author: { id: 'a1', name: 'Ada Agent', avatarUrl: null } }),
          historyMessage({ id: 'm1', body: 'Where is my refund?' }),
        ],
        nextCursor: null,
      },
    ]);
    expect(await screen.findByRole('heading', { name: 'Cara Customer', level: 1 }, FIND)).toBeInTheDocument();
    expect(screen.getByText('+44 20 7946 0000')).toBeInTheDocument();
    expect(screen.getByText('Acme Ltd')).toBeInTheDocument();
    expect(screen.getByText('vip')).toBeInTheDocument();
    expect(screen.getByText('4.5 / 5')).toBeInTheDocument();
    expect(screen.getByText('2 ratings')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Open tickets (1)' })).toBeInTheDocument();
    const history = screen.getByRole('region', { name: 'Conversation history' });
    expect(await within(history).findByText('Where is my refund?', undefined, FIND)).toBeInTheDocument();
    expect(within(history).getByText('Internal note')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('loads older messages on demand', async () => {
    renderProfile([
      { items: [historyMessage({ id: 'm3', body: 'Newest message' })], nextCursor: 'cursor-2' },
      { items: [historyMessage({ id: 'm1', body: 'Oldest message' })], nextCursor: null },
    ]);
    await screen.findByText('Newest message', undefined, FIND);
    await userEvent.click(screen.getByRole('button', { name: 'Load older messages' }));
    expect(await screen.findByText('Oldest message', undefined, FIND)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load older messages' })).not.toBeInTheDocument();
  });
});
