import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import SupportSessionPage from '../../src/pages/console/SupportSessionPage';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import type { SupportSession } from '../../src/api/generated/model';

/**
 * Opening a read-only support session for one tenant from the console (T086): the operator has
 * to ask for access when it has not been granted, and the token is shown once, with the host to
 * open it on.
 */

function renderAt(path: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/tenants/:id/support" element={<SupportSessionPage />} />
    </Routes>,
    { route: path },
  );
}

describe('SupportSessionPage', () => {
  it('explains an ungranted workspace instead of a generic error', async () => {
    server.use(
      http.post(`${API}/platform/tenants/:id/support-session`, () =>
        errorResponse(404, 'SUPPORT_ACCESS_NOT_GRANTED', 'Support access has not been granted'),
      ),
    );
    const { container } = renderAt('/tenants/t1/support');

    await userEvent.click(await screen.findByRole('button', { name: 'Open a support session' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This workspace has not granted support access. An admin there has to grant it first.',
    );
    await expectNoAxeViolations(container);
  });

  it('shows the host link and the token once the session opens', async () => {
    const session: SupportSession = {
      tenantHost: 'acme.replyx.app',
      token: 'sess-token-abc123',
      expiresAt: '2026-09-25T12:00:00.000Z',
    };
    server.use(http.post(`${API}/platform/tenants/:id/support-session`, () => HttpResponse.json<SupportSession>(session)));
    const { container } = renderAt('/tenants/t1/support');

    await userEvent.click(await screen.findByRole('button', { name: 'Open a support session' }));

    const link = await screen.findByRole('link', { name: 'acme.replyx.app' });
    expect(link).toHaveAttribute('href', 'https://acme.replyx.app/desk');
    expect(screen.getByText('sess-token-abc123')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Session open until'));

    await expectNoAxeViolations(container);
  });

  it('sends an operator back to the tenant list when there is no tenant in the address', async () => {
    const { container } = renderWithProviders(<SupportSessionPage />, { route: '/' });

    expect(await screen.findByRole('heading', { level: 1, name: 'No tenant in this address' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to tenants' })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});
