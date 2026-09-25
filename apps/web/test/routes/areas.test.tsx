import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { resolveArea } from '../../src/routes/area';
import { AreaRoutes } from '../../src/routes/index';
import { lightTheme } from '../../src/theme/theme';
import { API, errorResponse } from '../msw/handlers';
import { expectNoAxeViolations, server } from '../setup';

import type { CustomerMe } from '../../src/api/generated/model';

describe('resolveArea', () => {
  it.each([
    ['console.localhost', '/', 'console'],
    ['console.replyx.app', '/desk', 'console'],
    ['acme.localhost', '/desk', 'workspace'],
    ['acme.replyx.app', '/desk/admin/users', 'workspace'],
    ['acme.localhost', '/', 'customer'],
    ['acme.localhost', '/desktop', 'customer'],
    ['consoles.replyx.app', '/', 'customer'],
  ])('%s%s → %s', (hostname, pathname, area) => {
    expect(resolveArea(hostname, pathname)).toBe(area);
  });
});

// The first import of a lazy area is transformed on demand; allow for a cold, busy runner.
const LAZY = { timeout: 10_000 };

const customerMe: CustomerMe = { id: 'c1', name: 'Cam Customer', email: 'cam@example.test', hasPassword: false };

/** The areas render data-bearing pages, so they need the app's query client (routes/index.tsx). */
function renderAt(hostname: string, path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider theme={lightTheme}>
        <CssBaseline />
        <MemoryRouter initialEntries={[path]}>
          <AreaRoutes hostname={hostname} />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe('AreaRoutes', () => {
  it('shows the customer area on a tenant host', async () => {
    server.use(http.get(`${API}/customer/me`, () => HttpResponse.json(customerMe)));
    const { container } = renderAt('acme.localhost', '/');
    expect(await screen.findByRole('heading', { level: 1, name: 'Support' }, LAZY)).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('shows the customer sign-in flow when nobody is signed in', async () => {
    server.use(
      http.get(`${API}/customer/me`, () => errorResponse(401, 'UNAUTHENTICATED', 'Sign in to continue')),
      http.get(`${API}/customer/branding`, () => errorResponse(404, 'NOT_FOUND', 'Not found')),
    );
    const { container } = renderAt('acme.localhost', '/');
    expect(await screen.findByRole('heading', { level: 1, name: /sign in|get help/i }, LAZY)).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('shows the workspace under /desk', async () => {
    renderAt('acme.localhost', '/desk');
    expect(await screen.findByRole('heading', { level: 1, name: 'Inbox' }, LAZY)).toBeInTheDocument();
  });

  it('shows the console on the console host, whatever the path', async () => {
    renderAt('console.localhost', '/desk');
    expect(await screen.findByRole('heading', { name: 'Page not found' }, LAZY)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Inbox' })).not.toBeInTheDocument();
  });

  it('answers unknown paths inside an area with a not-found page', async () => {
    const { container } = renderAt('acme.localhost', '/desk/nowhere');
    expect(await screen.findByRole('heading', { name: 'Page not found' }, LAZY)).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});
