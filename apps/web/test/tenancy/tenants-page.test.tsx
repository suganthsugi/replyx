import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import TenantsPage from '../../src/pages/console/TenantsPage';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import type { ListTenants200, Tenant } from '../../src/api/generated/model';

/**
 * The platform console's tenant list (T086): status and support-access indicators, filters, the
 * create dialog, suspend/reactivate behind confirmation, and the sign-in door for an operator
 * without a session (UNAUTHENTICATED renders ConsoleSignInPage rather than an error).
 */

const active: Tenant = {
  id: 't1',
  name: 'Acme',
  slug: 'acme',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  activeSupportGrantUntil: '2026-09-30T00:00:00.000Z',
  stats: { staffUsers: 3, customers: 20 },
};

const suspended: Tenant = {
  id: 't2',
  name: 'Widgets Co',
  slug: 'widgets',
  status: 'suspended',
  createdAt: '2026-01-02T00:00:00.000Z',
  activeSupportGrantUntil: null,
  stats: { staffUsers: 1, customers: 0 },
};

function tenantsHandler(items: Tenant[], nextCursor: string | null = null) {
  return http.get(`${API}/platform/tenants`, () => HttpResponse.json<ListTenants200>({ items, nextCursor }));
}

describe('TenantsPage', () => {
  it('lists tenants with status and support access, and is free of axe violations', async () => {
    server.use(tenantsHandler([active, suspended]));
    const { container } = renderWithProviders(<TenantsPage />);

    const table = await screen.findByRole('table', { name: 'Tenants' });
    const rows = await within(table).findAllByRole('row');
    expect(within(rows[1] as HTMLElement).getByText('Acme')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('Active')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText(/Until/)).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText('Widgets Co')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText('Suspended')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText('Not granted')).toBeInTheDocument();

    await expectNoAxeViolations(container);
  });

  it('filters by search text and status', async () => {
    let lastUrl: string | undefined;
    server.use(
      http.get(`${API}/platform/tenants`, ({ request }) => {
        lastUrl = request.url;
        return HttpResponse.json<ListTenants200>({ items: [active], nextCursor: null });
      }),
    );
    renderWithProviders(<TenantsPage />);
    await screen.findByRole('table', { name: 'Tenants' });

    await userEvent.type(screen.getByRole('textbox', { name: 'Search' }), 'acme');
    await waitFor(() => expect(lastUrl).toContain('q=acme'));

    await userEvent.click(screen.getByRole('combobox', { name: 'Status' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Suspended' }));
    await waitFor(() => expect(lastUrl).toContain('status=suspended'));
  });

  it('shows a loading status, then the empty state when nobody matches', async () => {
    server.use(tenantsHandler([]));
    renderWithProviders(<TenantsPage />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(await screen.findByText('No tenants match these filters')).toBeInTheDocument();
  });

  it('shows an error with a retry', async () => {
    server.use(http.get(`${API}/platform/tenants`, () => errorResponse(500, 'INTERNAL', 'Something went wrong')));
    renderWithProviders(<TenantsPage />);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText("Couldn't load tenants")).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('shows the sign-in form instead of an error when nobody is signed in', async () => {
    server.use(http.get(`${API}/platform/tenants`, () => errorResponse(401, 'UNAUTHENTICATED', 'Sign in to continue')));
    renderWithProviders(<TenantsPage />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Platform console' })).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Tenants' })).not.toBeInTheDocument();
  });

  it('loads more tenants on demand', async () => {
    let calls = 0;
    server.use(
      http.get(`${API}/platform/tenants`, ({ request }) => {
        calls += 1;
        const cursor = new URL(request.url).searchParams.get('cursor');
        return HttpResponse.json<ListTenants200>(
          cursor === null ? { items: [active], nextCursor: 'page2' } : { items: [suspended], nextCursor: null },
        );
      }),
    );
    renderWithProviders(<TenantsPage />);

    await screen.findByText('Acme');
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));

    await screen.findByText('Widgets Co');
    expect(calls).toBe(2);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('creates a tenant from the dialog', async () => {
    let created: unknown;
    server.use(
      tenantsHandler([active]),
      http.post(`${API}/platform/tenants`, async ({ request }) => {
        created = await request.json();
        return HttpResponse.json<Tenant>(
          { id: 't3', name: 'New Co', slug: 'new-co', status: 'active', createdAt: '2026-09-25T00:00:00.000Z' },
          { status: 201 },
        );
      }),
    );
    renderWithProviders(<TenantsPage />);
    await screen.findByText('Acme');

    await userEvent.click(screen.getByRole('button', { name: 'Create a tenant' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create a tenant' });
    await expectNoAxeViolations(dialog);

    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Workspace name' }), 'New Co');
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Address' }), 'new-co');
    await userEvent.type(within(dialog).getByRole('textbox', { name: "First admin's email" }), 'admin@new-co.test');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create and invite' }));

    await waitFor(() => expect(created).toEqual({ name: 'New Co', slug: 'new-co', adminEmail: 'admin@new-co.test' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create a tenant' })).not.toBeInTheDocument());
  });

  it('suspends a tenant after confirmation', async () => {
    let suspendedId: string | undefined;
    server.use(
      tenantsHandler([active]),
      http.post(`${API}/platform/tenants/:id/suspend`, ({ params }) => {
        suspendedId = params.id as string;
        return HttpResponse.json<Tenant>({ ...active, status: 'suspended' });
      }),
    );
    renderWithProviders(<TenantsPage />);
    await screen.findByText('Acme');

    await userEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    const dialog = await screen.findByRole('dialog', { name: 'Suspend tenant' });
    expect(within(dialog).getByText(/signed out and unreachable/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Suspend' }));

    await waitFor(() => expect(suspendedId).toBe('t1'));
  });

  it('reactivates a suspended tenant after confirmation', async () => {
    let reactivatedId: string | undefined;
    server.use(
      tenantsHandler([suspended]),
      http.post(`${API}/platform/tenants/:id/reactivate`, ({ params }) => {
        reactivatedId = params.id as string;
        return HttpResponse.json<Tenant>({ ...suspended, status: 'active' });
      }),
    );
    renderWithProviders(<TenantsPage />);
    await screen.findByText('Widgets Co');

    await userEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reactivate tenant' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reactivate' }));

    await waitFor(() => expect(reactivatedId).toBe('t2'));
  });
});
