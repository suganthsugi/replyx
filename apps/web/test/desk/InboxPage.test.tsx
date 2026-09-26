import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import InboxPage from '../../src/pages/desk/inbox/InboxPage';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import { makeMe, makeTicketSummary, makeView, meHandler, ticketsHandler, viewsHandler } from './fixtures';

import type { ListTickets200 } from '../../src/api/generated/model';

/**
 * The inbox's ticket-list pane (T156, US6): loading, error and empty states for the active
 * view's tickets, and the row landmark once a page of tickets is in.
 */

function renderInbox(route = '/inbox/view-1') {
  server.use(meHandler(makeMe()));
  return renderWithProviders(
    <Routes>
      <Route path="/inbox/:viewId?/:ticketId?" element={<InboxPage />} />
    </Routes>,
    { route },
  );
}

describe('InboxPage ticket list', () => {
  it('shows a loading skeleton, then the tickets for the active view', async () => {
    server.use(viewsHandler([makeView({ id: 'view-1', name: 'My open tickets' })]));
    server.use(
      http.get(`${API}/tickets`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return HttpResponse.json<ListTickets200>({ items: [makeTicketSummary()], nextCursor: null });
      }),
    );
    renderInbox();
    expect(await screen.findByText('Loading tickets')).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: /Cannot reset my password/ }, { timeout: 3000 })).toBeInTheDocument();
  });

  it('shows a retryable error when the tickets fail to load', async () => {
    server.use(
      viewsHandler([makeView({ id: 'view-1', name: 'My open tickets' })]),
      http.get(`${API}/tickets`, () => errorResponse(500, 'INTERNAL')),
    );
    renderInbox();
    expect(await screen.findByRole('heading', { name: "Couldn't load tickets" })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('shows the "all caught up" empty state for a view with no tickets', async () => {
    server.use(viewsHandler([makeView({ id: 'view-1', name: 'My open tickets' })]), ticketsHandler([]));
    renderInbox();
    expect(await screen.findByRole('heading', { name: 'All caught up' })).toBeInTheDocument();
  });

  it('is free of axe violations while showing the ticket list', async () => {
    server.use(viewsHandler([makeView({ id: 'view-1', name: 'My open tickets' })]), ticketsHandler([makeTicketSummary()]));
    const { container } = renderInbox();
    await screen.findByRole('option', { name: /Cannot reset my password/ });
    await expectNoAxeViolations(container);
  });
});
