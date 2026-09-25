import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import SupportAccessPage from '../../src/pages/admin/support-access/SupportAccessPage';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import type { SupportAccessGrant } from '../../src/api/generated/model';

/**
 * A tenant admin's control over platform support access (T087): the active/revoked/expired
 * states, granting with a duration and optional reason, and revoking behind confirmation.
 */

const active: SupportAccessGrant = {
  id: 'g1',
  reason: 'Investigating a billing issue',
  startsAt: '2026-09-20T00:00:00.000Z',
  expiresAt: '2026-09-21T00:00:00.000Z',
  active: true,
  grantedBy: { id: 'u1', name: 'Ada Admin' },
};

const revoked: SupportAccessGrant = {
  id: 'g2',
  startsAt: '2026-09-10T00:00:00.000Z',
  expiresAt: '2026-09-11T00:00:00.000Z',
  revokedAt: '2026-09-10T12:00:00.000Z',
  active: false,
  grantedBy: { id: 'u1', name: 'Ada Admin' },
};

const expired: SupportAccessGrant = {
  id: 'g3',
  startsAt: '2026-08-01T00:00:00.000Z',
  expiresAt: '2026-08-02T00:00:00.000Z',
  active: false,
  grantedBy: { id: 'u1', name: 'Ada Admin' },
};

function grantsHandler(items: SupportAccessGrant[]) {
  return http.get(`${API}/support-access`, () => HttpResponse.json<SupportAccessGrant[]>(items));
}

describe('SupportAccessPage', () => {
  it('lists grants with Active, Revoked and Expired statuses, and is free of axe violations', async () => {
    server.use(grantsHandler([active, revoked, expired]));
    const { container } = renderWithProviders(<SupportAccessPage />);

    const table = await screen.findByRole('table', { name: 'Support access grants' });
    const rows = await within(table).findAllByRole('row');
    expect(within(rows[1] as HTMLElement).getByText('Active')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText('Revoked')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
    expect(within(rows[3] as HTMLElement).getByText('Expired')).toBeInTheDocument();

    await expectNoAxeViolations(container);
  });

  it('shows a loading status, then the empty state when nobody has access', async () => {
    server.use(grantsHandler([]));
    renderWithProviders(<SupportAccessPage />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(await screen.findByText('Nobody has support access')).toBeInTheDocument();
  });

  it('shows an error with a retry', async () => {
    server.use(http.get(`${API}/support-access`, () => errorResponse(500, 'INTERNAL', 'Something went wrong')));
    renderWithProviders(<SupportAccessPage />);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText("Couldn't load support access")).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('grants access with a chosen duration and reason', async () => {
    let granted: unknown;
    server.use(
      grantsHandler([]),
      http.post(`${API}/support-access`, async ({ request }) => {
        granted = await request.json();
        return HttpResponse.json<SupportAccessGrant>(active, { status: 201 });
      }),
    );
    renderWithProviders(<SupportAccessPage />);
    await screen.findByText('Nobody has support access');

    await userEvent.click(screen.getByRole('combobox', { name: 'For how long' }));
    await userEvent.click(await screen.findByRole('option', { name: '1 day' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Reason' }), 'Investigating a billing issue');
    await userEvent.click(screen.getByRole('button', { name: 'Grant access' }));

    await waitFor(() => expect(granted).toEqual({ durationHours: 24, reason: 'Investigating a billing issue' }));
  });

  it('revokes access after confirmation', async () => {
    let revokedId: string | undefined;
    server.use(
      grantsHandler([active]),
      http.post(`${API}/support-access/:id/revoke`, ({ params }) => {
        revokedId = params.id as string;
        return HttpResponse.json<SupportAccessGrant>({ ...active, active: false, revokedAt: '2026-09-25T00:00:00.000Z' });
      }),
    );
    renderWithProviders(<SupportAccessPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revoke support access' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));

    await waitFor(() => expect(revokedId).toBe('g1'));
  });
});
