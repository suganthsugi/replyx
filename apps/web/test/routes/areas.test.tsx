import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { resolveArea } from '../../src/routes/area';
import { AreaRoutes } from '../../src/routes/index';
import { lightTheme } from '../../src/theme/theme';
import { expectNoAxeViolations } from '../setup';

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

function renderAt(hostname: string, path: string) {
  return render(
    <ThemeProvider theme={lightTheme}>
      <CssBaseline />
      <MemoryRouter initialEntries={[path]}>
        <AreaRoutes hostname={hostname} />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe('AreaRoutes', () => {
  it('shows the customer area on a tenant host', async () => {
    const { container } = renderAt('acme.localhost', '/');
    expect(await screen.findByRole('heading', { level: 1, name: 'Support' }, LAZY)).toBeInTheDocument();
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
