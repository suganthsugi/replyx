import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { NotificationCenter } from '../../src/components/shell/NotificationCenter';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import { makeNotification, markNotificationsReadHandler, notificationsHandler } from './fixtures';

/**
 * The workspace notification center (T169): the bell button's unread badge, the panel's list,
 * mark-read actions and the "View all" link. New arrivals are covered by
 * `test/data/notifications.test.tsx` (`useNotificationArrivals`); this only checks the panel
 * announces what the trigger passes it.
 */
describe('NotificationCenter', () => {
  it('shows the unread count on the bell, opens the panel and lists notifications', async () => {
    server.use(
      notificationsHandler([
        makeNotification({ id: 'n1', title: 'Assigned to you', read: false }),
        makeNotification({ id: 'n2', title: 'New reply', read: true, count: 3, summary: null }),
      ]),
    );
    const { container } = renderWithProviders(<NotificationCenter onOpenTicket={vi.fn()} />);

    const bell = await screen.findByRole('button', { name: 'Notifications, 1 unread' });
    await userEvent.click(bell);

    const dialog = await screen.findByRole('dialog', { name: 'Notifications' });
    expect(within(dialog).getByText('Assigned to you')).toBeInTheDocument();
    expect(within(dialog).getByText('3 messages')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('marks a notification read, announces it, and opens its ticket', async () => {
    server.use(notificationsHandler([makeNotification({ id: 'n1', ticketId: 'ticket-7', read: false })]), markNotificationsReadHandler(0));
    const onOpenTicket = vi.fn();
    const { container } = renderWithProviders(<NotificationCenter onOpenTicket={onOpenTicket} />);

    await userEvent.click(await screen.findByRole('button', { name: /Notifications/ }));
    await userEvent.click(await screen.findByRole('button', { name: /Assigned to you/ }));

    await waitFor(() => expect(onOpenTicket).toHaveBeenCalledWith('ticket-7'));
    expect(container.ownerDocument.querySelector('[aria-live="polite"]')).toHaveTextContent('Marked "Assigned to you" as read');
  });

  it('opens AI settings from an AI pause notification, which has no ticket', async () => {
    server.use(
      notificationsHandler([makeNotification({ id: 'n9', eventType: 'ai.paused', title: 'AI paused: the AI provider key was not accepted', ticketId: null, read: false })]),
      markNotificationsReadHandler(0),
    );
    const onOpenTicket = vi.fn();
    renderWithProviders(
      <Routes>
        <Route path="/desk" element={<NotificationCenter onOpenTicket={onOpenTicket} />} />
        <Route path="/desk/admin/ai" element={<p>AI settings page</p>} />
      </Routes>,
      { route: '/desk' },
    );

    await userEvent.click(await screen.findByRole('button', { name: /Notifications/ }));
    await userEvent.click(await screen.findByRole('button', { name: /AI paused/ }));
    expect(await screen.findByText('AI settings page')).toBeInTheDocument();
    expect(onOpenTicket).not.toHaveBeenCalled();
  });

  it('closes on Escape', async () => {
    server.use(notificationsHandler([makeNotification()]));
    renderWithProviders(<NotificationCenter onOpenTicket={vi.fn()} />);

    await userEvent.click(await screen.findByRole('button', { name: /Notifications/ }));
    await screen.findByRole('dialog', { name: 'Notifications' });
    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Notifications' })).not.toBeInTheDocument());
  });

  it('shows an empty state with no notifications', async () => {
    server.use(notificationsHandler([]));
    renderWithProviders(<NotificationCenter onOpenTicket={vi.fn()} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Notifications' }));
    expect(await screen.findByText('No notifications yet')).toBeInTheDocument();
  });
});
