import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { Route, Routes, useParams } from 'react-router';
import { describe, expect, it } from 'vitest';

import NotificationsPage from '../../src/pages/desk/notifications/NotificationsPage';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import { makeNotification, makeView, markNotificationsReadHandler, notificationsHandler, viewsHandler } from './fixtures';

/** Stands in for the inbox route the panel navigates to, so a test can see which ticket opened. */
function InboxProbe() {
  const params = useParams<{ viewId: string; ticketId: string }>();
  return <div>Opened {params.viewId}/{params.ticketId}</div>;
}

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/desk/notifications" element={<NotificationsPage />} />
      <Route path="/desk/inbox/:viewId/:ticketId" element={<InboxProbe />} />
    </Routes>,
    { route: '/desk/notifications' },
  );
}

/** The full notification history page (T169), reached from the panel's "View all". */
describe('NotificationsPage', () => {
  it('lists notifications, marks all read, and filters to unread only', async () => {
    server.use(
      viewsHandler([makeView({ id: 'view-1' })]),
      notificationsHandler([
        makeNotification({ id: 'n1', title: 'Assigned to you', read: false }),
        makeNotification({ id: 'n2', title: 'New reply', read: true }),
      ]),
      markNotificationsReadHandler(0),
    );
    const { container } = renderPage();

    expect(await screen.findByRole('heading', { name: 'Notifications', level: 1 })).toBeInTheDocument();
    expect(await screen.findByText('Assigned to you')).toBeInTheDocument();
    expect(screen.getByText('New reply')).toBeInTheDocument();
    await expectNoAxeViolations(container);

    await userEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    expect(container.ownerDocument.querySelector('[aria-live="polite"]')).toHaveTextContent('Marked all notifications as read');
  });

  it("opens a notification's ticket in the first visible view", async () => {
    server.use(
      viewsHandler([makeView({ id: 'view-9' })]),
      notificationsHandler([makeNotification({ id: 'n1', ticketId: 'ticket-3', read: true })]),
    );
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /Assigned to you/ }));
    await waitFor(() => expect(screen.getByText('Opened view-9/ticket-3')).toBeInTheDocument());
  });

  it('shows a retryable error when notifications fail to load', async () => {
    server.use(viewsHandler([]), http.get(`${API}/notifications`, () => errorResponse(500, 'INTERNAL')));
    renderPage();

    expect(await screen.findByText("Couldn't load notifications")).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    server.use(viewsHandler([]), notificationsHandler([]));
    renderPage();

    expect(await screen.findByText('No notifications yet')).toBeInTheDocument();
  });
});
