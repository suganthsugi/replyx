import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import GroupsPage from '../../src/pages/admin/groups/GroupsPage';
import RoleEditorPage from '../../src/pages/admin/roles/RoleEditorPage';
import RolesPage from '../../src/pages/admin/roles/RolesPage';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import type { Group, Me, Permission, Role, RoleInput } from '../../src/api/generated/model';

/**
 * The role and group pages (T098): listing, the editor's confirmation before owners are
 * unassigned (FR-026), Admin read-only (FR-019), and the "move tickets first" error (FR-030).
 */

const ALL = ['role.view', 'role.create', 'role.edit', 'role.delete', 'group.view', 'group.create', 'group.edit', 'group.delete'];

const me: Me = { id: 'u1', email: 'ada@acme.test', name: 'Ada', kind: 'staff', roles: [], permissions: ALL, groupAccess: [], accessVersion: 1 };

const permissions: Permission[] = [
  { key: 'ticket.view', resource: 'ticket', action: 'view', module: 'tickets', description: 'View tickets', groupScoped: true },
  { key: 'ticket.edit', resource: 'ticket', action: 'edit', module: 'tickets', description: 'Edit tickets', groupScoped: true },
];

const groups: Group[] = [
  { id: 'g-support', name: 'Support', status: 'active', openTicketCount: 3 },
  { id: 'g-billing', name: 'Billing', status: 'inactive', openTicketCount: 0 },
];

const supportAgent: Role = {
  id: 'r-custom',
  name: 'Support Agent',
  system: null,
  permissions: ['ticket.edit', 'ticket.view'],
  groupAccess: [{ groupId: 'g-support', view: true, create: false, edit: true, delete: false }],
  userCount: 2,
};

const admin: Role = {
  id: 'r-admin',
  name: 'Admin',
  system: 'admin',
  permissions: ['ticket.edit', 'ticket.view'],
  groupAccess: [{ groupId: null, view: true, create: true, edit: true, delete: true }],
  userCount: 1,
};

function common() {
  server.use(
    http.get(`${API}/me`, () => HttpResponse.json(me)),
    http.get(`${API}/permissions`, () => HttpResponse.json({ items: permissions })),
    http.get(`${API}/groups`, () => HttpResponse.json({ items: groups })),
    http.get(`${API}/roles`, () => HttpResponse.json({ items: [admin, supportAgent] })),
    http.get(`${API}/roles/:id`, ({ params }) =>
      params.id === admin.id ? HttpResponse.json(admin) : params.id === supportAgent.id ? HttpResponse.json(supportAgent) : errorResponse(404, 'ROLE_NOT_FOUND', 'Role not found'),
    ),
  );
}

function renderEditor(id: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/desk/admin/roles/:id" element={<RoleEditorPage />} />
    </Routes>,
    { route: `/desk/admin/roles/${id}` },
  );
}

describe('RolesPage', () => {
  it('lists roles with their type and user count; only custom roles can be deleted', async () => {
    common();
    const { container } = renderWithProviders(<RolesPage />);
    const table = await screen.findByRole('table', { name: 'Roles' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(within(rows[0] as HTMLElement).getByText('System · Admin')).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByRole('button', { name: 'Delete Support Agent' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New role' })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});

describe('RoleEditorPage', () => {
  it('asks before saving an edit that takes Edit away from a group, then sends the new matrix', async () => {
    common();
    let sent: RoleInput | undefined;
    server.use(
      http.put(`${API}/roles/:id`, async ({ request }) => {
        sent = (await request.json()) as RoleInput;
        return HttpResponse.json({ ...supportAgent, ...sent });
      }),
    );
    const user = userEvent.setup();
    renderEditor(supportAgent.id);

    await user.click(await screen.findByRole('checkbox', { name: 'Edit tickets in Support' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    const dialog = await screen.findByRole('dialog', { name: 'Remove Edit access?' });
    expect(within(dialog).getByText(/lose Edit on Support/)).toBeInTheDocument();
    expect(sent).toBeUndefined();
    await user.click(within(dialog).getByRole('button', { name: 'Save and unassign' }));

    await waitFor(() => expect(sent).toBeDefined());
    expect(sent).toEqual({
      name: 'Support Agent',
      permissions: ['ticket.edit', 'ticket.view'],
      groupAccess: [{ groupId: 'g-support', view: true, create: false, edit: false, delete: false }],
    });
    expect(await screen.findAllByText('Role saved')).not.toHaveLength(0);
  });

  it('saves without asking when no group loses Edit, and shows a taken name on the field', async () => {
    common();
    server.use(http.put(`${API}/roles/:id`, () => errorResponse(409, 'ROLE_NAME_TAKEN', 'A role with this name already exists')));
    const user = userEvent.setup();
    renderEditor(supportAgent.id);

    await user.click(await screen.findByRole('checkbox', { name: 'View tickets in Ungrouped' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('A role with this name already exists')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows Admin read-only with every permission granted', async () => {
    common();
    const { container } = renderEditor(admin.id);
    expect(await screen.findByText(/Admin always has every permission/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Edit tickets' })).toBeChecked();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('says so when the role does not exist', async () => {
    common();
    renderEditor('r-missing');
    expect(await screen.findByRole('heading', { name: 'Role not found' })).toBeInTheDocument();
  });
});

describe('GroupsPage', () => {
  it('shows status and open tickets, and the API refusal when a group still has tickets', async () => {
    common();
    server.use(
      http.delete(`${API}/groups/:id`, () =>
        errorResponse(409, 'GROUP_HAS_TICKETS', 'Move this group’s tickets to another group or to Ungrouped first'),
      ),
    );
    const user = userEvent.setup();
    const { container } = renderWithProviders(<GroupsPage />);
    const table = await screen.findByRole('table', { name: 'Groups' });
    expect(within(table).getByText('Inactive')).toBeInTheDocument();
    await expectNoAxeViolations(container);

    await user.click(screen.getByRole('button', { name: 'Delete Support' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Support' });
    expect(within(dialog).getByText(/still has tickets/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete group' }));
    expect(await within(dialog).findByText(/Move this group’s tickets/)).toBeInTheDocument();
  });

  it('creates a group from the dialog', async () => {
    common();
    let created: unknown;
    server.use(
      http.post(`${API}/groups`, async ({ request }) => {
        created = await request.json();
        return HttpResponse.json({ id: 'g-new', name: 'Returns', status: 'active', openTicketCount: 0 }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<GroupsPage />);
    await user.click(await screen.findByRole('button', { name: 'New group' }));
    const dialog = await screen.findByRole('dialog', { name: 'New group' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Returns');
    await user.click(within(dialog).getByRole('button', { name: 'Create group' }));
    await waitFor(() => expect(created).toEqual({ name: 'Returns' }));
    expect(await screen.findAllByText(/Returns created/)).not.toHaveLength(0);
  });
});
