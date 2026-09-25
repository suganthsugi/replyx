import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import ProfilePage from '../../src/pages/desk/me/ProfilePage';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import type { Me } from '../../src/api/generated/model';

/** The staff member's own profile (T071): name and availability, password, and sessions. */

const me: Me = {
  id: 'u1',
  email: 'ada@example.test',
  name: 'Ada Admin',
  kind: 'staff',
  availability: 'online',
  roles: [],
  permissions: [],
  groupAccess: [],
  accessVersion: 1,
};

const meHandler = http.get(`${API}/me`, () => HttpResponse.json<Me>(me));

describe('ProfilePage', () => {
  it('fills the form from /me and saves name and availability', async () => {
    let saved: unknown;
    server.use(
      meHandler,
      http.patch(`${API}/me`, async ({ request }) => {
        saved = await request.json();
        return HttpResponse.json<Me>({ ...me, name: 'Ada A.' });
      }),
    );
    const { container } = renderWithProviders(<ProfilePage />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Your profile' })).toBeInTheDocument();
    const nameField = screen.getByRole('textbox', { name: 'Name' });
    expect(nameField).toHaveValue('Ada Admin');
    await expectNoAxeViolations(container);

    await userEvent.clear(nameField);
    await userEvent.type(nameField, 'Ada A.');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(saved).toEqual({ name: 'Ada A.', availability: 'online' }));
    expect(container.ownerDocument.querySelector('[aria-live="polite"]')).toHaveTextContent('Profile updated');
  });

  it('changes the password and clears the fields', async () => {
    server.use(meHandler, http.put(`${API}/me/password`, () => new HttpResponse(null, { status: 204 })));
    renderWithProviders(<ProfilePage />);

    const current = await screen.findByLabelText('Current password *');
    const next = screen.getByLabelText('New password *');
    await userEvent.type(current, 'old-password-1');
    await userEvent.type(next, 'a-long-enough-password');
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));

    await waitFor(() => expect(current).toHaveValue(''));
    expect(next).toHaveValue('');
  });

  it('puts a wrong current password on its own field', async () => {
    server.use(
      meHandler,
      http.put(`${API}/me/password`, () =>
        HttpResponse.json(
          {
            error: {
              code: 'VALIDATION_FAILED',
              message: 'The request is invalid',
              details: [{ path: 'currentPassword', issue: 'incorrect' }],
            },
          },
          { status: 400 },
        ),
      ),
    );
    renderWithProviders(<ProfilePage />);

    const current = await screen.findByLabelText('Current password *');
    await userEvent.type(current, 'wrong');
    await userEvent.type(screen.getByLabelText('New password *'), 'a-long-enough-password');
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));

    await waitFor(() => expect(current).toHaveAttribute('aria-invalid', 'true'));
  });

  it('signs out of every session and returns to sign-in', async () => {
    let signedOutAll = false;
    server.use(
      meHandler,
      http.post(`${API}/auth/sign-out-all`, () => {
        signedOutAll = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderWithProviders(<ProfilePage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Sign out of all sessions' }));
    await waitFor(() => expect(signedOutAll).toBe(true));
  });

  it('shows a retryable error when /me fails', async () => {
    server.use(http.get(`${API}/me`, () => errorResponse(500, 'INTERNAL')));
    renderWithProviders(<ProfilePage />);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText("Couldn't load your profile")).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
