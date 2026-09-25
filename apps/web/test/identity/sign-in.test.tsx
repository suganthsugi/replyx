import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import AcceptInvitationPage from '../../src/pages/desk/auth/AcceptInvitationPage';
import SignInPage from '../../src/pages/desk/auth/SignInPage';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import type { GetInvitation200, Me } from '../../src/api/generated/model';

/**
 * Staff sign-in and invitation acceptance (T071). Every failure the API can return on sign-in has
 * its own message, mapped from the error code rather than the status (data-hooks rule 3).
 */

const me: Me = {
  id: 'u1',
  email: 'ada@example.test',
  name: 'Ada Admin',
  kind: 'staff',
  roles: [],
  permissions: [],
  groupAccess: [],
  accessVersion: 1,
};

async function signIn(email = 'ada@example.test', password = 'password-123456') {
  await userEvent.type(await screen.findByRole('textbox', { name: 'Email' }), email);
  await userEvent.type(screen.getByLabelText('Password *'), password);
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('SignInPage', () => {
  it('signs in and is free of axe violations', async () => {
    server.use(http.post(`${API}/auth/sign-in`, () => HttpResponse.json<Me>(me)));
    const { container, queryClient } = renderWithProviders(<SignInPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    await expectNoAxeViolations(container);

    await signIn();
    await waitFor(() => expect(queryClient.getQueryData(['me'])).toEqual(me));
  });

  it.each([
    ['401 INVALID_CREDENTIALS', 401, 'INVALID_CREDENTIALS', 'Wrong email or password.'],
    ['423 ACCOUNT_LOCKED', 423, 'ACCOUNT_LOCKED', /temporarily locked/],
    ['503 TENANT_SUSPENDED', 503, 'TENANT_SUSPENDED', 'This workspace is currently unavailable.'],
  ])('shows the message for %s', async (_name, status, code, message) => {
    server.use(http.post(`${API}/auth/sign-in`, () => errorResponse(status, code)));
    renderWithProviders(<SignInPage />);

    await signIn();
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('shows how long to wait on 429 RATE_LIMITED', async () => {
    server.use(
      http.post(`${API}/auth/sign-in`, () =>
        HttpResponse.json({ error: { code: 'RATE_LIMITED', message: 'Too many requests', retryAfter: 90 } }, { status: 429 }),
      ),
    );
    renderWithProviders(<SignInPage />);

    await signIn();
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again in 2 minutes.');
  });
});

describe('AcceptInvitationPage', () => {
  const invitation: GetInvitation200 = { email: 'new@example.test', tenantName: 'Acme' };

  it('accepts an invitation with a name and password', async () => {
    server.use(
      http.get(`${API}/invitations/tok`, () => HttpResponse.json<GetInvitation200>(invitation)),
      http.post(`${API}/invitations/tok/accept`, () => HttpResponse.json<Me>(me)),
    );
    const { container, queryClient } = renderWithProviders(<AcceptInvitationPage />, { route: '/?token=tok' });

    expect(await screen.findByRole('heading', { level: 1, name: 'Join Acme' })).toBeInTheDocument();
    await expectNoAxeViolations(container);

    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'New Person');
    await userEvent.type(screen.getByLabelText('Password *'), 'a-long-enough-password');
    await userEvent.click(screen.getByRole('button', { name: 'Accept and continue' }));

    await waitFor(() => expect(queryClient.getQueryData(['me'])).toEqual(me));
  });

  it('puts a server validation issue on the password field', async () => {
    server.use(
      http.get(`${API}/invitations/tok`, () => HttpResponse.json<GetInvitation200>(invitation)),
      http.post(`${API}/invitations/tok/accept`, () =>
        HttpResponse.json(
          { error: { code: 'VALIDATION_FAILED', message: 'The request is invalid', details: [{ path: 'password', issue: 'too_short' }] } },
          { status: 400 },
        ),
      ),
    );
    renderWithProviders(<AcceptInvitationPage />, { route: '/?token=tok' });

    await userEvent.type(await screen.findByRole('textbox', { name: 'Name' }), 'New Person');
    const password = screen.getByLabelText('Password *');
    await userEvent.type(password, 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Accept and continue' }));

    await waitFor(() => expect(password).toHaveAttribute('aria-invalid', 'true'));
  });

  it('explains an expired or unknown invitation instead of showing the form', async () => {
    server.use(http.get(`${API}/invitations/gone`, () => errorResponse(404, 'INVITATION_NOT_FOUND', 'Invitation not found')));
    const { container } = renderWithProviders(<AcceptInvitationPage />, { route: '/?token=gone' });

    expect(await screen.findByText('This invitation is no longer valid')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept and continue' })).not.toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('explains a link with no token at all', async () => {
    renderWithProviders(<AcceptInvitationPage />, { route: '/' });
    expect(await screen.findByText('This invitation link is incomplete')).toBeInTheDocument();
  });
});
