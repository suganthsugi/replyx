import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import WebhooksPage from '../../src/pages/admin/integrations/WebhooksPage';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import type { ErrorResponse, ListWebhookDeliveries200, ListWebhooks200, Me, Webhook, WebhookDelivery, WebhookInput, WebhookWithSecret } from '../../src/api/generated/model';

const FIND = { timeout: 10_000 };
const SLOW = 60_000;

const ALL = ['webhook.view', 'webhook.create', 'webhook.edit', 'webhook.delete'];
const SECRET = 'whsec_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';

const me = (permissions: string[]): Me => ({
  id: 'u1',
  email: 'ada@acme.test',
  name: 'Ada',
  kind: 'staff',
  roles: [],
  permissions,
  groupAccess: [],
  accessVersion: 1,
});

function makeWebhook(overrides: Partial<Webhook> = {}): Webhook {
  return {
    id: 'hook-1',
    url: 'https://hooks.acme.test/replyx',
    events: ['ticket.created', 'message.created'],
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastDeliveryStatus: 'succeeded',
    ...overrides,
  };
}

function makeDelivery(overrides: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    id: 'd-1',
    eventId: '0192f3c4-0000-7000-8000-000000000001',
    eventType: 'ticket.created',
    attempt: 1,
    status: 'succeeded',
    responseCode: 200,
    durationMs: 120,
    error: null,
    nextAttemptAt: null,
    attemptedAt: '2026-01-02T10:00:00.000Z',
    createdAt: '2026-01-02T10:00:00.000Z',
    ...overrides,
  };
}

function seed(initial: Webhook[], permissions = ALL) {
  const state = { webhooks: [...initial], created: [] as WebhookInput[], updated: [] as WebhookInput[], deleted: [] as string[], rotated: [] as string[], cursors: [] as (string | null)[] };
  server.use(
    http.get(`${API}/me`, () => HttpResponse.json(me(permissions))),
    http.get(`${API}/webhooks`, () => HttpResponse.json<ListWebhooks200>({ items: state.webhooks })),
    http.post(`${API}/webhooks`, async ({ request }) => {
      const body = (await request.json()) as WebhookInput;
      state.created.push(body);
      const created = makeWebhook({ ...body, id: `hook-${state.webhooks.length + 1}`, lastDeliveryStatus: null });
      state.webhooks = [...state.webhooks, created];
      return HttpResponse.json<WebhookWithSecret>({ ...created, secret: SECRET }, { status: 201 });
    }),
    http.put(`${API}/webhooks/:id`, async ({ request, params }) => {
      const body = (await request.json()) as WebhookInput;
      state.updated.push(body);
      state.webhooks = state.webhooks.map((hook) => (hook.id === params.id ? { ...hook, ...body } : hook));
      return HttpResponse.json<Webhook>(state.webhooks.find((hook) => hook.id === params.id) ?? state.webhooks[0]!);
    }),
    http.delete(`${API}/webhooks/:id`, ({ params }) => {
      state.deleted.push(params.id as string);
      state.webhooks = state.webhooks.filter((hook) => hook.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(`${API}/webhooks/:id/rotate-secret`, ({ params }) => {
      state.rotated.push(params.id as string);
      return HttpResponse.json({ secret: `${SECRET}-new` });
    }),
    http.get(`${API}/webhooks/:id/deliveries`, ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor');
      state.cursors.push(cursor);
      if (cursor === null) {
        return HttpResponse.json<ListWebhookDeliveries200>({
          items: [
            makeDelivery({ id: 'd-3', attempt: 3 }),
            makeDelivery({ id: 'd-2', attempt: 2, status: 'failed', responseCode: 503, error: 'HTTP 503', nextAttemptAt: '2026-01-02T10:05:00.000Z' }),
          ],
          nextCursor: 'page-2',
        });
      }
      return HttpResponse.json<ListWebhookDeliveries200>({
        items: [makeDelivery({ id: 'd-1', attempt: 1, status: 'failed', responseCode: null, durationMs: 10_000, error: 'No response within 10 s' })],
        nextCursor: null,
      });
    }),
  );
  return state;
}

describe('WebhooksPage', () => {
  it('lists endpoints with events and last delivery, and is free of axe violations', async () => {
    seed([makeWebhook(), makeWebhook({ id: 'hook-2', url: 'https://ops.acme.test/in', events: ['ticket.closed'], enabled: false, lastDeliveryStatus: 'gave_up' })]);
    const { container } = renderWithProviders(<WebhooksPage />);
    expect(await screen.findByText('https://hooks.acme.test/replyx', undefined, FIND)).toBeInTheDocument();
    expect(screen.getByText('Ticket created, Message added')).toBeInTheDocument();
    expect(screen.getByText('Last delivery: Delivered')).toBeInTheDocument();
    expect(screen.getByText('Last delivery: Gave up')).toBeInTheDocument();
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Send events to https://ops.acme.test/in' })).not.toBeChecked();
    await expectNoAxeViolations(container);
  });

  it('shows the empty state with an Add action, and the error state', async () => {
    seed([]);
    const { unmount } = renderWithProviders(<WebhooksPage />);
    expect(await screen.findByText('No webhook endpoints yet', undefined, FIND)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add endpoint' }).length).toBeGreaterThan(0);
    unmount();

    server.use(http.get(`${API}/webhooks`, () => errorResponse(500, 'INTERNAL', 'Boom')));
    renderWithProviders(<WebhooksPage />);
    expect(await screen.findByText("Couldn't load webhooks", undefined, FIND)).toBeInTheDocument();
  });

  it('hides write controls for a viewer but keeps the history', async () => {
    seed([makeWebhook()], ['webhook.view']);
    renderWithProviders(<WebhooksPage />);
    await screen.findByText('https://hooks.acme.test/replyx', undefined, FIND);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Send events to https://hooks.acme.test/replyx' })).toBeDisabled());
    expect(screen.queryByRole('button', { name: 'Add endpoint' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(Edit|Delete|New secret for) / })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delivery history for https://hooks.acme.test/replyx' })).toBeInTheDocument();
  });

  it(
    'adds an endpoint and shows its secret once',
    async () => {
      const state = seed([]);
      const writeText = vi.fn(() => Promise.resolve());
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      renderWithProviders(<WebhooksPage />);
      await userEvent.click((await screen.findAllByRole('button', { name: 'Add endpoint' }, FIND))[0]!);
      const dialog = await screen.findByRole('dialog', { name: 'Add endpoint' }, FIND);
      const url = within(dialog).getByRole('textbox', { name: /^Endpoint URL/ });
      await userEvent.clear(url);
      await userEvent.type(url, 'https://hooks.acme.test/new');
      await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Ticket closed' }));
      await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Ticket created' }));
      await userEvent.click(within(dialog).getByRole('button', { name: 'Add endpoint' }));

      await waitFor(() => expect(state.created).toEqual([{ url: 'https://hooks.acme.test/new', events: ['ticket.closed'], enabled: true }]));
      const secretDialog = await screen.findByRole('dialog', { name: 'Signing secret' }, FIND);
      expect(within(secretDialog).getByRole('textbox', { name: 'Secret' })).toHaveValue(SECRET);
      expect(within(secretDialog).getByText(/shown only once/)).toBeInTheDocument();
      await userEvent.click(within(secretDialog).getByRole('button', { name: 'Copy' }));
      expect(writeText).toHaveBeenCalledWith(SECRET);
      await userEvent.click(within(secretDialog).getByRole('button', { name: 'Done' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Signing secret' })).not.toBeInTheDocument());
      expect(screen.queryByDisplayValue(SECRET)).not.toBeInTheDocument();
      expect(await screen.findByText('https://hooks.acme.test/new', undefined, FIND)).toBeInTheDocument();
    },
    SLOW,
  );

  it(
    'puts the API refusal of a private address on the URL field, and needs an event',
    async () => {
      seed([]);
      server.use(
        http.post(`${API}/webhooks`, () =>
          HttpResponse.json<ErrorResponse>({ error: { code: 'VALIDATION_FAILED', message: 'Invalid', details: [{ path: 'url', issue: 'private_address' }] } }, { status: 400 }),
        ),
      );
      renderWithProviders(<WebhooksPage />);
      await userEvent.click((await screen.findAllByRole('button', { name: 'Add endpoint' }, FIND))[0]!);
      const dialog = await screen.findByRole('dialog', { name: 'Add endpoint' }, FIND);
      await userEvent.type(within(dialog).getByRole('textbox', { name: /^Endpoint URL/ }), '10.0.0.5/hook');

      await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Ticket created' }));
      expect(within(dialog).getByText('Choose at least one event.')).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Add endpoint' })).toBeDisabled();
      await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Ticket updated' }));

      await userEvent.click(within(dialog).getByRole('button', { name: 'Add endpoint' }));
      expect(await within(dialog).findByText('This address points to a private network and can’t be used', undefined, FIND)).toBeInTheDocument();
      expect(within(dialog).getByRole('textbox', { name: /^Endpoint URL/ })).toHaveAttribute('aria-invalid', 'true');
    },
    SLOW,
  );

  it(
    'switches an endpoint off with its full definition, rotates its secret and deletes it',
    async () => {
      const state = seed([makeWebhook()]);
      renderWithProviders(<WebhooksPage />);
      await userEvent.click(await screen.findByRole('switch', { name: 'Send events to https://hooks.acme.test/replyx' }, FIND));
      await waitFor(() => expect(state.updated).toEqual([{ url: 'https://hooks.acme.test/replyx', events: ['ticket.created', 'message.created'], enabled: false }]));

      await userEvent.click(screen.getByRole('button', { name: 'New secret for https://hooks.acme.test/replyx' }));
      const confirm = await screen.findByRole('dialog', { name: 'Replace the signing secret' }, FIND);
      await userEvent.click(within(confirm).getByRole('button', { name: 'Replace secret' }));
      const secretDialog = await screen.findByRole('dialog', { name: 'Signing secret' }, FIND);
      expect(within(secretDialog).getByRole('textbox', { name: 'Secret' })).toHaveValue(`${SECRET}-new`);
      expect(state.rotated).toEqual(['hook-1']);
      await userEvent.click(within(secretDialog).getByRole('button', { name: 'Done' }));

      await userEvent.click(screen.getByRole('button', { name: 'Delete https://hooks.acme.test/replyx' }));
      const deleteDialog = await screen.findByRole('dialog', { name: 'Delete endpoint' }, FIND);
      await userEvent.click(within(deleteDialog).getByRole('button', { name: 'Delete endpoint' }));
      await waitFor(() => expect(state.deleted).toEqual(['hook-1']));
      expect(await screen.findByText('No webhook endpoints yet', undefined, FIND)).toBeInTheDocument();
    },
    SLOW,
  );

  it(
    'shows the delivery history newest first and loads older attempts',
    async () => {
      const state = seed([makeWebhook()]);
      const { baseElement } = renderWithProviders(<WebhooksPage />);
      await userEvent.click(await screen.findByRole('button', { name: 'Delivery history for https://hooks.acme.test/replyx' }, FIND));
      const drawer = await screen.findByRole('dialog', { name: 'Delivery history' }, FIND);
      const list = await within(drawer).findByRole('list', { name: 'Delivery attempts' }, FIND);
      const items = within(list).getAllByRole('listitem');
      expect(items).toHaveLength(2);
      expect(within(items[0]!).getByText('Delivered')).toBeInTheDocument();
      expect(within(items[0]!).getByText('Attempt 3 of 8')).toBeInTheDocument();
      expect(within(items[1]!).getByText('Failed, will retry')).toBeInTheDocument();
      expect(within(items[1]!).getByText(/HTTP 503/)).toBeInTheDocument();
      expect(within(items[1]!).getByText(/^Next attempt/)).toBeInTheDocument();

      await userEvent.click(within(drawer).getByRole('button', { name: 'Load older attempts' }));
      await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(3));
      expect(within(list).getByText('No response within 10 s')).toBeInTheDocument();
      expect(state.cursors).toEqual([null, 'page-2']);
      expect(within(drawer).queryByRole('button', { name: 'Load older attempts' })).not.toBeInTheDocument();
      await expectNoAxeViolations(baseElement);
    },
    SLOW,
  );
});
