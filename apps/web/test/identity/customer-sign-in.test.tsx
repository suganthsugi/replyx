import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import RedeemLinkPage from '../../src/pages/customer/auth/RedeemLinkPage';
import { SignInFlow } from '../../src/pages/customer/auth/SignInFlow';
import ForgotPasswordPage from '../../src/pages/desk/auth/ForgotPasswordPage';
import ResetPasswordPage from '../../src/pages/desk/auth/ResetPasswordPage';
import { API, errorResponse } from '../msw/handlers';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations, server } from '../setup';

import type { CustomerMe } from '../../src/api/generated/model';

/**
 * The link-first customer sign-in flow and the staff password-reset pages (T071). The customer
 * path never says whether an account exists, so the tests assert the steps, not the outcome.
 */

const customer: CustomerMe = { id: 'c1', name: 'Cam Customer', email: 'cam@example.test', hasPassword: false };

describe('SignInFlow', () => {
  it('asks for an email, then tells the customer to check it, and can resend', async () => {
    let requests = 0;
    server.use(
      http.post(`${API}/customer/auth/sign-in-link`, () => {
        requests += 1;
        return new HttpResponse(null, { status: 202 });
      }),
    );
    const { container } = renderWithProviders(<SignInFlow />);

    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    await expectNoAxeViolations(container);

    await userEvent.type(screen.getByRole('textbox', { name: 'Email' }), 'cam@example.test');
    await userEvent.type(screen.getByRole('textbox', { name: /Name/ }), 'Cam');
    await userEvent.click(screen.getByRole('button', { name: 'Send sign-in link' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Check your email' })).toBeInTheDocument();
    expect(screen.getByText('cam@example.test')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Resend the link' }));
    await waitFor(() => expect(requests).toBe(2));
    expect(await screen.findByText('Sent again — check your inbox.')).toBeInTheDocument();
    expect(container.ownerDocument.querySelector('[aria-live="polite"]')).toHaveTextContent('A new sign-in link is on its way.');
  });

  it('goes back to the email step from "check your email"', async () => {
    server.use(http.post(`${API}/customer/auth/sign-in-link`, () => new HttpResponse(null, { status: 202 })));
    renderWithProviders(<SignInFlow />);

    await userEvent.type(screen.getByRole('textbox', { name: 'Email' }), 'cam@example.test');
    await userEvent.click(screen.getByRole('button', { name: 'Send sign-in link' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Use a different email' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
  });

  it('offers the password form and reports a wrong password', async () => {
    server.use(http.post(`${API}/customer/auth/sign-in`, () => errorResponse(401, 'INVALID_CREDENTIALS')));
    const { container } = renderWithProviders(<SignInFlow />);

    await userEvent.click(screen.getByRole('button', { name: 'Sign in with a password instead' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in with your password' })).toBeInTheDocument();
    await expectNoAxeViolations(container);

    await userEvent.type(screen.getByRole('textbox', { name: 'Email' }), 'cam@example.test');
    await userEvent.type(screen.getByLabelText('Password *'), 'not-the-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong email or password.');

    await userEvent.click(screen.getByRole('button', { name: 'Use a sign-in link instead' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('RedeemLinkPage', () => {
  it('redeems the link and caches the customer', async () => {
    server.use(http.post(`${API}/customer/auth/sign-in-link/redeem`, () => HttpResponse.json<CustomerMe>(customer)));
    const { container, queryClient } = renderWithProviders(<RedeemLinkPage />, { route: '/?token=tok' });

    expect(screen.getByRole('heading', { level: 1, name: 'Finish signing in' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Keep me signed in on this device' })).toBeChecked();
    await expectNoAxeViolations(container);

    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(queryClient.getQueryData(['customerMe'])).toEqual(customer));
  });

  it('says a used or expired link is no longer valid', async () => {
    server.use(http.post(`${API}/customer/auth/sign-in-link/redeem`, () => errorResponse(400, 'LINK_INVALID_OR_EXPIRED')));
    renderWithProviders(<RedeemLinkPage />, { route: '/?token=used' });

    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This link is no longer valid. Request a new one.');
  });

  it('explains a link with no token', async () => {
    const { container } = renderWithProviders(<RedeemLinkPage />, { route: '/' });
    expect(screen.getByText('This sign-in link is incomplete')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});

describe('ForgotPasswordPage', () => {
  it('confirms the request without saying whether the account exists', async () => {
    server.use(http.post(`${API}/auth/password-reset`, () => new HttpResponse(null, { status: 202 })));
    const { container } = renderWithProviders(<ForgotPasswordPage />);

    await expectNoAxeViolations(container);
    await userEvent.type(screen.getByRole('textbox', { name: 'Email' }), 'ada@example.test');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('If an account exists for ada@example.test');
    expect(screen.queryByRole('button', { name: 'Send reset link' })).not.toBeInTheDocument();
  });
});

describe('ResetPasswordPage', () => {
  it('sets a new password and then points back to sign-in', async () => {
    server.use(http.post(`${API}/auth/password-reset/confirm`, () => new HttpResponse(null, { status: 204 })));
    const { container } = renderWithProviders(<ResetPasswordPage />, { route: '/?token=tok' });

    await expectNoAxeViolations(container);
    await userEvent.type(screen.getByLabelText('New password *'), 'a-long-enough-password');
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Password updated' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toBeInTheDocument();
  });

  it('says an expired reset link needs replacing', async () => {
    server.use(http.post(`${API}/auth/password-reset/confirm`, () => errorResponse(400, 'LINK_INVALID_OR_EXPIRED')));
    renderWithProviders(<ResetPasswordPage />, { route: '/?token=gone' });

    await userEvent.type(screen.getByLabelText('New password *'), 'a-long-enough-password');
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This link is no longer valid. Request a new one.');
  });

  it('explains a link with no token', async () => {
    const { container } = renderWithProviders(<ResetPasswordPage />, { route: '/' });
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('This reset link is incomplete')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});
