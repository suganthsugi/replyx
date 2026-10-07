import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import AdminLayout from '../../src/pages/admin/AdminLayout';
import DeskLayout from '../../src/pages/desk/DeskLayout';
import { API } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { server } from '../setup';

import { makeMe } from './fixtures';

const FIND = { timeout: 10_000 };

function renderAdmin(permissions: string[]) {
  server.use(http.get(`${API}/me`, () => HttpResponse.json(makeMe(permissions))));
  return renderWithProviders(
    <Routes>
      <Route path="/desk/admin" element={<AdminLayout />}>
        <Route path="sla-policies" element={<p>SLA page</p>} />
        <Route path="business-hours" element={<p>Hours page</p>} />
        <Route path="users" element={<p>Users page</p>} />
      </Route>
    </Routes>,
    { route: '/desk/admin/sla-policies' },
  );
}

const adminLinks = async () =>
  within(await screen.findByRole('navigation', { name: 'Administration' }, FIND))
    .getAllByRole('link')
    .map((link) => link.textContent);

describe('AdminLayout SLA sections', () => {
  it('lists SLA policies and Business hours for sla_policy.view, in that order after the other sections', async () => {
    renderAdmin(['user.view', 'sla_policy.view']);
    expect(await adminLinks()).toEqual(['Users', 'SLA policies', 'Business hours']);
    expect(screen.getByText('SLA page')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'SLA policies' })).toHaveAttribute('aria-current', 'page');
  });

  it('lists neither without sla_policy.view', async () => {
    renderAdmin(['user.view', 'sla_policy.create']);
    expect(await adminLinks()).toEqual(['Users']);
  });

  it('does not open an SLA page the person cannot see', async () => {
    renderAdmin(['user.view']);
    await adminLinks();
    expect(screen.queryByText('SLA page')).not.toBeInTheDocument();
  });
});

describe('DeskLayout header navigation', () => {
  function renderDesk(permissions: string[]) {
    server.use(http.get(`${API}/me`, () => HttpResponse.json(makeMe(permissions))));
    return renderWithProviders(
      <Routes>
        <Route path="/desk" element={<DeskLayout />}>
          <Route path="inbox" element={<p>Inbox page</p>} />
          <Route path="dashboard" element={<p>Dashboard page</p>} />
        </Route>
      </Routes>,
      { route: '/desk/inbox' },
    );
  }

  const links = async () =>
    within(await screen.findByRole('navigation', { name: 'Workspace' }, FIND))
      .getAllByRole('link')
      .map((link) => link.textContent);

  it('shows Dashboard only to people with dashboard.view', async () => {
    renderDesk(['ticket.view', 'dashboard.view']);
    await waitForMe();
    expect(await links()).toEqual(['Inbox', 'Dashboard']);
  });

  it('keeps Dashboard out of the header without dashboard.view', async () => {
    renderDesk(['ticket.view']);
    await waitForMe();
    expect(await links()).toEqual(['Inbox']);
    expect(screen.queryByRole('link', { name: 'Dashboard' })).not.toBeInTheDocument();
  });
});

/** The header links render before `/me` answers; the profile button appears once the permissions are known. */
async function waitForMe() {
  await screen.findByRole('button', { name: 'Your profile, Ada' }, FIND);
}
