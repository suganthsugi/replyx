import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { resolveArea } from '../../src/routes/area';
import { AreaRoutes } from '../../src/routes/index';
import { API, branding, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import type { Branding } from '../../src/api/generated/model';

/**
 * A suspended workspace shows only that support can't be reached (T087, FR-004) — never why, and
 * never any internal concept — and CustomerArea reaches that page from branding's `available`
 * flag before it even looks at whether a customer is signed in.
 */

describe('UnavailablePage', () => {
  it('shows the suspended message on a tenant host and is free of axe violations, with no internal detail', async () => {
    expect(resolveArea('acme.localhost', '/')).toBe('customer');
    server.use(http.get(`${API}/customer/branding`, () => HttpResponse.json<Branding>({ ...branding, available: false })));

    const { container } = renderWithProviders(<AreaRoutes hostname="acme.localhost" />, { route: '/' });

    expect(await screen.findByRole('heading', { level: 1, name: 'Support is unavailable' }, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.queryByText(/suspend/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/ticket/i)).not.toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('shows the sign-in flow instead when the workspace is available', async () => {
    server.use(
      http.get(`${API}/customer/branding`, () => HttpResponse.json<Branding>(branding)),
      http.get(`${API}/customer/me`, () => errorResponse(401, 'UNAUTHENTICATED', 'Sign in to continue')),
    );
    renderWithProviders(<AreaRoutes hostname="acme.localhost" />, { route: '/' });

    expect(await screen.findByRole('heading', { level: 1, name: /sign in|get help/i }, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Support is unavailable' })).not.toBeInTheDocument();
  });
});
