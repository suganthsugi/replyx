import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import UsersPage from '../../src/pages/admin/users/UsersPage';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import type { ListRoles200, ListUsers200, Role, User } from '../../src/api/generated/model';

/**
 * The admin user directory (T071): the four states every data-bearing screen owes the user
 * (loading, empty, error, denied), and the destructive actions behind a confirmation.
 */

const agentRole: Role = {
  id: 'r1',
  name: 'Agent',
  system: 'agent',
  permissions: [],
  groupAccess: [],
  userCount: 1,
};

const ada: User = {
  id: 'u1',
  email: 'ada@example.test',
  name: 'Ada Admin',
  kind: 'staff',
  status: 'active',
  locked: false,
  roles: [{ id: 'r1', name: 'Agent' }],
  lastSignInAt: null,
};

const locked: User = { ...ada, id: 'u2', email: 'lou@example.test', name: 'Lou Locked', locked: true };

const roleHandler = http.get(`${API}/roles`, () => HttpResponse.json<ListRoles200>({ items: [agentRole] }));

function usersHandler(items: User[]) {
  return http.get(`${API}/users`, () => HttpResponse.json<ListUsers200>({ items, nextCursor: null }));
}

describe('UsersPage', () => {
  it('lists users with status, roles and a locked flag, and is free of axe violations', async () => {
    server.use(roleHandler, usersHandler([ada, locked]));
    const { container } = renderWithProviders(<UsersPage />);

    const table = await screen.findByRole('table', { name: 'Users' });
    const rows = await within(table).findAllByRole('row');
    expect(within(rows[1] as HTMLElement).getByText('Ada Admin')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('Agent')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('Never')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText('Locked')).toBeInTheDocument();

    await expectNoAxeViolations(container);
  });

  it('shows a loading status, then the empty state when nobody matches', async () => {
    server.use(roleHandler, usersHandler([]));
    renderWithProviders(<UsersPage />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(await screen.findByText('No users match these filters')).toBeInTheDocument();
  });

  it.each([
    ['a server error', 500, 'INTERNAL', 'Something went wrong on our side. Try again in a moment.'],
    ['no permission', 403, 'PERMISSION_DENIED', 'You do not have permission to do this'],
  ])('shows an error with a retry for %s', async (_name, status, code, message) => {
    server.use(roleHandler, http.get(`${API}/users`, () => errorResponse(status, code, 'You do not have permission to do this')));
    renderWithProviders(<UsersPage />);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText("Couldn't load users")).toBeInTheDocument();
    expect(within(alert).getByText(message)).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('invites a user once a role is chosen', async () => {
    let invited: unknown;
    server.use(
      roleHandler,
      usersHandler([ada]),
      http.post(`${API}/users`, async ({ request }) => {
        invited = await request.json();
        return HttpResponse.json<User>({ ...ada, id: 'u3', email: 'new@example.test', status: 'invited' }, { status: 201 });
      }),
    );
    renderWithProviders(<UsersPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Invite a user' }));
    const dialog = await screen.findByRole('dialog', { name: 'Invite a user' });
    await expectNoAxeViolations(dialog);

    const send = within(dialog).getByRole('button', { name: 'Send invitation' });
    expect(send).toBeDisabled();

    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Email' }), 'new@example.test');
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Roles' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Agent' }));
    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(send).toBeEnabled());
    await userEvent.click(send);

    await waitFor(() => expect(invited).toEqual({ email: 'new@example.test', roleIds: ['r1'] }));
  });

  it('erases a user only after ERASE is typed', async () => {
    let erased: string | undefined;
    server.use(
      roleHandler,
      usersHandler([ada]),
      http.post(`${API}/users/:id/erase`, ({ params }) => {
        erased = params.id as string;
        return new HttpResponse(null, { status: 202 });
      }),
    );
    renderWithProviders(<UsersPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Erase' }));
    const dialog = await screen.findByRole('dialog', { name: 'Erase user' });
    const confirm = within(dialog).getByRole('button', { name: 'Erase' });
    expect(confirm).toBeDisabled();

    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Type ERASE to confirm' }), 'ERASE');
    await waitFor(() => expect(confirm).toBeEnabled());
    await userEvent.click(confirm);

    await waitFor(() => expect(erased).toBe('u1'));
  });

  it('keeps the confirmation open and shows the reason when deleting is refused', async () => {
    server.use(
      roleHandler,
      usersHandler([ada]),
      http.delete(`${API}/users/:id`, () => errorResponse(409, 'USER_HAS_HISTORY', 'This user has messages or history.')),
    );
    renderWithProviders(<UsersPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete user' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(await within(dialog).findByText('This user has messages or history.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Delete user' })).toBeInTheDocument();
  });
});
