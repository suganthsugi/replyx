import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import AdminLayout, { visibleSections } from '../../src/pages/admin/AdminLayout';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import type { Me } from '../../src/api/generated/model';

/**
 * The admin shell (T100, FR-071): only sections the user may open are listed, `/desk/admin`
 * opens the first of them, and a section without permission is not found.
 */

function meWith(permissions: string[]): Me {
  return {
    id: 'u1',
    email: 'ada@acme.test',
    name: 'Ada Admin',
    kind: 'staff',
    roles: [],
    permissions,
    groupAccess: [],
    accessVersion: 1,
  };
}

function renderAdmin(route: string, permissions: string[]) {
  server.use(http.get(`${API}/me`, () => HttpResponse.json(meWith(permissions))));
  return renderWithProviders(
    <Routes>
      <Route path="/desk/admin" element={<AdminLayout />}>
        <Route path="users" element={<p>Users page</p>} />
        <Route path="roles" element={<p>Roles page</p>} />
        <Route path="groups" element={<p>Groups page</p>} />
        <Route path="support-access" element={<p>Support access page</p>} />
      </Route>
      <Route path="/desk/sign-in" element={<p>Sign-in page</p>} />
    </Routes>,
    { route },
  );
}

const railLinks = async () =>
  within(await screen.findByRole('navigation', { name: 'Administration' }))
    .getAllByRole('link')
    .map((link) => link.textContent);

describe('AdminLayout', () => {
  it('lists every section for a full admin and is free of axe violations', async () => {
    const { container } = renderAdmin('/desk/admin/roles', ['user.view', 'role.view', 'group.view', 'support_access.view']);
    expect(await railLinks()).toEqual(['Users', 'Roles', 'Groups', 'Support access']);
    expect(screen.getByText('Roles page')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Roles' })).toHaveAttribute('aria-current', 'page');
    await expectNoAxeViolations(container);
  });

  it('hides sections without permission', async () => {
    renderAdmin('/desk/admin/groups', ['group.view', 'ticket.view']);
    expect(await railLinks()).toEqual(['Groups']);
    expect(screen.getByText('Groups page')).toBeInTheDocument();
  });

  it('opens the first allowed section from /desk/admin', async () => {
    renderAdmin('/desk/admin', ['role.view', 'group.view']);
    expect(await screen.findByText('Roles page')).toBeInTheDocument();
  });

  it('answers a section without permission as not found, keeping the rail', async () => {
    renderAdmin('/desk/admin/users', ['role.view']);
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.queryByText('Users page')).not.toBeInTheDocument();
    expect(await railLinks()).toEqual(['Roles']);
  });

  it('explains when the user has no admin permission at all', async () => {
    renderAdmin('/desk/admin', ['ticket.view']);
    expect(await screen.findByRole('heading', { name: 'No admin sections' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Administration' })).not.toBeInTheDocument();
  });

  it('sends a signed-out visitor to sign-in', async () => {
    server.use(http.get(`${API}/me`, () => errorResponse(401, 'UNAUTHENTICATED')));
    renderWithProviders(
      <Routes>
        <Route path="/desk/admin/*" element={<AdminLayout />} />
        <Route path="/desk/sign-in" element={<p>Sign-in page</p>} />
      </Routes>,
      { route: '/desk/admin/roles' },
    );
    expect(await screen.findByText('Sign-in page')).toBeInTheDocument();
  });

  it('visibleSections keeps the section order', () => {
    expect(visibleSections(['support_access.view', 'user.view']).map((s) => s.path)).toEqual(['users', 'support-access']);
  });
});
