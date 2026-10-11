import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { applicationServerKey, DesktopNotificationsError, useEnableDesktopNotifications } from '../../src/data/notifications';
import NotificationDefaultsPage from '../../src/pages/admin/notifications/NotificationDefaultsPage';
import InboxPage from '../../src/pages/desk/inbox/InboxPage';
import NotificationPreferencesPage from '../../src/pages/desk/me/NotificationPreferencesPage';
import { makeView, meHandler, makeMe as makeDeskMe, ticketsHandler, viewsHandler } from '../desk/fixtures';
import { API } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';
import { makeMe } from '../sla/fixtures';

import type { NotificationDefaults, NotificationDefaultsInput, NotificationPreferences, NotificationPreferencesInput, PushSubscriptionInput } from '../../src/api/generated/model';

/**
 * US15 (T245, T246): the notification preferences page (master switch, event × channel grid,
 * desktop permission), the tenant defaults admin page, the desktop subscription hook and the
 * inbox's `?ticket=` link from push and email notifications.
 */

const FIND = { timeout: 10_000 };
const SLOW = 60_000;

const EVENTS = [
  'ticket.ungrouped_created',
  'ticket.arrived_in_group',
  'message.customer_on_my_ticket',
  'message.customer_on_unassigned',
  'ticket.assigned_to_me',
  'ticket.my_ticket_changed',
  'mention',
  'sla.warning',
  'sla.breached',
  'ticket.reminder_reached',
  'ai.paused',
] as const;

function resolvedEvents(): NotificationPreferences['events'] {
  return Object.fromEntries(EVENTS.map((event) => [event, { inApp: true, push: event === 'ticket.assigned_to_me', email: false }])) as NotificationPreferences['events'];
}

function seedPreferences(initial: NotificationPreferences = { enabled: true, events: resolvedEvents() }) {
  const puts: NotificationPreferencesInput[] = [];
  let current = initial;
  server.use(
    http.get(`${API}/notification-preferences`, () => HttpResponse.json<NotificationPreferences>(current)),
    http.put(`${API}/notification-preferences`, async ({ request }) => {
      const body = (await request.json()) as NotificationPreferencesInput;
      puts.push(body);
      current = { enabled: body.enabled, events: { ...current.events, ...(body.events as NotificationPreferences['events']) } };
      return HttpResponse.json<NotificationPreferences>(current);
    }),
  );
  return puts;
}

function seedDefaults(permissions: string[]) {
  const puts: NotificationDefaultsInput[] = [];
  let current: NotificationDefaults = { events: resolvedEvents() };
  server.use(
    http.get(`${API}/me`, () => HttpResponse.json(makeMe(permissions))),
    http.get(`${API}/notification-defaults`, () => HttpResponse.json<NotificationDefaults>(current)),
    http.put(`${API}/notification-defaults`, async ({ request }) => {
      const body = (await request.json()) as NotificationDefaultsInput;
      puts.push(body);
      current = { events: { ...current.events, ...(body.events as NotificationDefaults['events']) } };
      return HttpResponse.json<NotificationDefaults>(current);
    }),
  );
  return puts;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NotificationPreferencesPage', () => {
  it('shows the grid with a labelled checkbox per event and channel, free of axe violations', async () => {
    seedPreferences();
    const { container } = renderWithProviders(<NotificationPreferencesPage />);
    expect(await screen.findByRole('heading', { name: 'Notification preferences' }, FIND)).toBeInTheDocument();
    const grid = await screen.findByRole('table', { name: 'Notification channels per event' }, FIND);
    expect(within(grid).getByRole('checkbox', { name: 'Desktop for Assigned to me' })).toBeChecked();
    expect(within(grid).getByRole('checkbox', { name: 'Email for Assigned to me' })).not.toBeChecked();
    expect(within(grid).getByRole('checkbox', { name: 'In-app for SLA breached' })).toBeChecked();
    await expectNoAxeViolations(container);
  }, SLOW);

  it('saves every event with the changed toggle and the master switch', async () => {
    const puts = seedPreferences();
    renderWithProviders(<NotificationPreferencesPage />);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Email for Assigned to me' }, FIND));
    await userEvent.click(screen.getByRole('button', { name: 'Save preferences' }));
    await waitFor(() => expect(puts).toHaveLength(1), FIND);
    expect(puts[0]!.enabled).toBe(true);
    expect(Object.keys(puts[0]!.events)).toHaveLength(EVENTS.length);
    expect(puts[0]!.events['ticket.assigned_to_me']).toEqual({ inApp: true, push: true, email: true });
    expect(await screen.findByText('Notification preferences saved', undefined, FIND)).toBeInTheDocument();
  });

  it('turning the master switch off explains that the notification center still records everything', async () => {
    const puts = seedPreferences();
    renderWithProviders(<NotificationPreferencesPage />);
    await userEvent.click(await screen.findByRole('switch', { name: 'Desktop and email notifications' }, FIND));
    expect(screen.getByText(/Paused: no desktop notifications or emails\. Your notification center still lists everything/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save preferences' }));
    await waitFor(() => expect(puts[0]?.enabled).toBe(false), FIND);
  });

  it('says so when the browser has no desktop notification support (jsdom has no Push API)', async () => {
    seedPreferences();
    renderWithProviders(<NotificationPreferencesPage />);
    expect(await screen.findByText(/This browser doesn't support desktop notifications/, undefined, FIND)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn on desktop notifications' })).not.toBeInTheDocument();
  });

  it('shows the error state with Retry', async () => {
    server.use(http.get(`${API}/notification-preferences`, () => HttpResponse.json({ error: { code: 'INTERNAL', message: 'Boom' } }, { status: 500 })));
    renderWithProviders(<NotificationPreferencesPage />);
    expect(await screen.findByText("Couldn't load your notification preferences", undefined, FIND)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('NotificationDefaultsPage', () => {
  it('lets an editor change a default and sends only the changed event', async () => {
    const puts = seedDefaults(['tenant_settings.view', 'tenant_settings.edit']);
    const { container } = renderWithProviders(<NotificationDefaultsPage />);
    const save = await screen.findByRole('button', { name: 'Save defaults' }, FIND);
    expect(save).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Email for Mentioned' }));
    await userEvent.click(save);
    await waitFor(() => expect(puts).toHaveLength(1), FIND);
    expect(puts[0]).toEqual({ events: { mention: { inApp: true, push: false, email: true } } });
    await expectNoAxeViolations(container);
  }, SLOW);

  it('is read-only without tenant_settings.edit', async () => {
    seedDefaults(['tenant_settings.view']);
    renderWithProviders(<NotificationDefaultsPage />);
    expect(await screen.findByText('You can view the defaults but not change them.', undefined, FIND)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Email for Mentioned' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save defaults' })).not.toBeInTheDocument();
  });
});

describe('desktop notification subscription (T246)', () => {
  function EnableButton({ onError }: { onError: (error: unknown) => void }) {
    const enable = useEnableDesktopNotifications();
    return (
      <button type="button" onClick={() => void enable.mutateAsync().catch(onError)}>
        Enable
      </button>
    );
  }

  function stubBrowser(permission: NotificationPermission) {
    const subscription = {
      toJSON: () => ({ endpoint: 'https://push.example.com/send/abc', keys: { p256dh: 'p256', auth: 'authkey' } }),
    };
    const subscribe = vi.fn().mockResolvedValue(subscription);
    const registration = { pushManager: { getSubscription: vi.fn().mockResolvedValue(null), subscribe } };
    vi.stubGlobal('PushManager', class {});
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: vi.fn().mockResolvedValue(permission) });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { register: vi.fn().mockResolvedValue(registration), ready: Promise.resolve(registration) },
    });
    return { subscribe };
  }

  it('registers the subscription with the server key once the user allows notifications', async () => {
    const { subscribe } = stubBrowser('granted');
    const posted: PushSubscriptionInput[] = [];
    server.use(
      http.get(`${API}/notification-preferences/push-key`, () => HttpResponse.json({ publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U' })),
      http.post(`${API}/notification-preferences/push-subscriptions`, async ({ request }) => {
        posted.push((await request.json()) as PushSubscriptionInput);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const onError = vi.fn();
    renderWithProviders(<EnableButton onError={onError} />);
    await userEvent.click(screen.getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(posted).toEqual([{ endpoint: 'https://push.example.com/send/abc', keys: { p256dh: 'p256', auth: 'authkey' } }]), FIND);
    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(onError).not.toHaveBeenCalled();
  });

  it('stops with a plain reason when the server has no push key or the user blocks notifications', async () => {
    stubBrowser('denied');
    let publicKey: string | null = null;
    server.use(http.get(`${API}/notification-preferences/push-key`, () => HttpResponse.json({ publicKey })));
    const onError = vi.fn();
    renderWithProviders(<EnableButton onError={onError} />);
    await userEvent.click(screen.getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1), FIND);
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(DesktopNotificationsError);
    expect((onError.mock.calls[0]![0] as DesktopNotificationsError).reason).toBe('not-configured');

    publicKey = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
    await userEvent.click(screen.getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(2), FIND);
    expect((onError.mock.calls[1]![0] as DesktopNotificationsError).reason).toBe('denied');
  });

  it('decodes a URL-safe base64 key to bytes', () => {
    expect([...applicationServerKey('AQID-_8')]).toEqual([1, 2, 3, 251, 255]);
  });
});

describe('inbox links from push and email', () => {
  function LocationProbe() {
    return <p data-testid="location">{useLocation().pathname}</p>;
  }

  it('opens /desk/inbox?ticket= in the first view', async () => {
    server.use(meHandler(makeDeskMe()), viewsHandler([makeView({ id: 'view-1', name: 'My open tickets' })]), ticketsHandler([]));
    renderWithProviders(
      <Routes>
        <Route path="/desk/inbox/:viewId?/:ticketId?" element={<><InboxPage /><LocationProbe /></>} />
      </Routes>,
      { route: '/desk/inbox?ticket=ticket-42' },
    );
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/desk/inbox/view-1/ticket-42'), FIND);
  });
});
