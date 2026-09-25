import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import ConsoleSignInPage from '../../src/pages/console/ConsoleSignInPage';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import type { Operator } from '../../src/api/generated/model';

/**
 * Platform operator sign-in on the console host (T086): success, and the same error copy staff
 * sign-in owes the user for invalid credentials and a locked account.
 */

const operator: Operator = { id: 'op1', email: 'ops@replyx.app', name: 'Ops Person' };

async function signIn(email = 'ops@replyx.app', password = 'password-123456') {
  await userEvent.type(await screen.findByRole('textbox', { name: 'Email' }), email);
  await userEvent.type(screen.getByLabelText('Password *'), password);
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('ConsoleSignInPage', () => {
  it('signs an operator in and is free of axe violations', async () => {
    server.use(http.post(`${API}/platform/auth/sign-in`, () => HttpResponse.json<Operator>(operator)));
    const { container, queryClient } = renderWithProviders(<ConsoleSignInPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Platform console' })).toBeInTheDocument();
    await expectNoAxeViolations(container);

    await signIn();
    await waitFor(() => expect(queryClient.getQueryData(['operator'])).toEqual(operator));
  });

  it.each([
    ['401 INVALID_CREDENTIALS', 401, 'INVALID_CREDENTIALS', 'Wrong email or password.'],
    ['423 ACCOUNT_LOCKED', 423, 'ACCOUNT_LOCKED', /temporarily locked/],
  ])('shows the message for %s', async (_name, status, code, message) => {
    server.use(http.post(`${API}/platform/auth/sign-in`, () => errorResponse(status, code)));
    renderWithProviders(<ConsoleSignInPage />);

    await signIn();
    expect(await screen.findByText(message)).toBeInTheDocument();
  });
});
