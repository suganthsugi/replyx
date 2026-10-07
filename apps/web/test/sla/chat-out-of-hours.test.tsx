import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { RealtimeProvider } from '../../src/data/realtime';
import ChatPage from '../../src/pages/customer/ChatPage';
import { conversationPage, FakeSocket, me, myMessage, thread } from '../chat/fixtures';
import { API, branding } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import type { Branding, ConversationMessage, SendCustomerMessageBody } from '../../src/api/generated/model';

function renderChat(overrides: Partial<Branding>) {
  server.use(http.get(`${API}/customer/conversation`, () => HttpResponse.json(conversationPage(thread))));
  const socket = new FakeSocket();
  const view = renderWithProviders(
    <RealtimeProvider namespace="/customer" userId={me.id} createSocket={() => socket}>
      <ChatPage me={me} branding={{ ...branding, tenantName: 'Acme', ...overrides }} />
    </RealtimeProvider>,
  );
  return { socket, ...view };
}

beforeEach(() => {
  sessionStorage.clear();
  server.use(http.post(`${API}/customer/messages/read`, () => new HttpResponse(null, { status: 204 })));
});

describe('ChatPage out-of-hours banner', () => {
  it('shows the message as a status region, with no axe violations', async () => {
    const { container } = renderChat({ outOfHoursMessage: 'We are closed until 9am.' });
    await screen.findByText('Checking with the warehouse now.');
    expect(screen.getByRole('status')).toHaveTextContent('We are closed until 9am.');
    await expectNoAxeViolations(container);
  });

  it.each([null, '', undefined])('shows no banner when the message is %j', async (message) => {
    renderChat({ outOfHoursMessage: message });
    await screen.findByText('Checking with the warehouse now.');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('still lets the customer send a message while the banner is up', async () => {
    let sent: SendCustomerMessageBody | undefined;
    server.use(
      http.post(`${API}/customer/messages`, async ({ request }) => {
        sent = (await request.json()) as SendCustomerMessageBody;
        return HttpResponse.json<ConversationMessage>({ ...myMessage('m9', sent.body, sent.clientMessageId, new Date().toISOString()), delivery: 'sent' }, { status: 201 });
      }),
    );
    const { socket } = renderChat({ outOfHoursMessage: 'We are closed until 9am.' });
    await screen.findByText('Checking with the warehouse now.');
    await waitFor(() => expect(socket.handlers.size).toBeGreaterThan(0));
    act(() => socket.open());
    const box = screen.getByRole('textbox', { name: 'Message' });
    expect(box).toBeEnabled();
    await userEvent.type(box, 'Anyone there?{Enter}');
    await waitFor(() => expect(sent?.body).toBe('Anyone there?'));
    expect(screen.getByRole('status')).toHaveTextContent('We are closed until 9am.');
  });
});
