import { expect, test } from './fixtures';
import { linkPath, uniqueEmail, waitForMessage } from './mailpit';

import type { Page } from '@playwright/test';

/**
 * Sign-in end to end (T072) against the dev stack seeded by `pnpm --filter api seed:dev`:
 *
 * 1. an admin invites an agent, who accepts through the emailed link, signs in and signs out
 *    everywhere, and
 * 2. a customer signs in with an emailed link.
 *
 * Both follow the real email, so the whole path (invitation token, cookies, CSRF) is exercised.
 */

const SEED_PASSWORD = 'password-123456';
const NEW_PASSWORD = 'e2e-agent-password-1';

async function signInAsAdmin(page: Page) {
  await page.goto('/desk/sign-in');
  await page.getByRole('textbox', { name: 'Email' }).fill('admin@acme.test');
  await page.getByLabel('Password *').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/desk$/);
}

test('an invited agent accepts, signs in and signs out everywhere', async ({ page, request, axe }) => {
  const email = uniqueEmail('e2e-agent');
  await signInAsAdmin(page);

  await page.goto('/desk/admin/users');
  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
  await axe.check();

  await page.getByRole('button', { name: 'Invite a user' }).click();
  const dialog = page.getByRole('dialog', { name: 'Invite a user' });
  await dialog.getByRole('textbox', { name: 'Email' }).fill(email);
  await dialog.getByRole('textbox', { name: 'Name' }).fill('E2E Agent');
  await dialog.getByRole('combobox', { name: 'Roles' }).click();
  // The Select's own invisible backdrop sits over the list on the phone viewport, so the click
  // has to be forced; the option itself is visible and enabled.
  const roleList = page.getByRole('listbox');
  const agentOption = roleList.getByRole('option', { name: 'Agent', exact: true });
  await agentOption.scrollIntoViewIfNeeded();
  await agentOption.click({ force: true });
  // The menu stays open for further choices; close it (and wait) or its backdrop swallows the
  // next click.
  await roleList.press('Escape');
  await expect(roleList).toBeHidden();
  await expect(dialog.getByRole('button', { name: 'Send invitation' })).toBeEnabled();
  // Submitted from the keyboard: on the phone viewport the dialog sits over a horizontally
  // scrollable page, and a click on the footer button lands on the dialog container instead.
  await dialog.getByRole('textbox', { name: 'Email' }).press('Enter');

  await expect(page.getByRole('cell', { name: email })).toBeVisible();

  // Accept through the emailed link, in a session of their own.
  const invitation = await waitForMessage(request, email, 'invited');
  const context = await page.context().browser()?.newContext();
  if (context === undefined) throw new Error('no browser context');
  const invitee = await context.newPage();
  await invitee.goto(new URL(linkPath(invitation, '/desk/accept-invitation'), page.url()).toString());

  await expect(invitee.getByRole('heading', { level: 1, name: /Join/ })).toBeVisible();
  await invitee.getByRole('textbox', { name: 'Name' }).fill('E2E Agent');
  await invitee.getByLabel('Password *').fill(NEW_PASSWORD);
  await invitee.getByRole('button', { name: 'Accept and continue' }).click();
  await expect(invitee).toHaveURL(/\/desk$/);

  // Signing out everywhere ends this session too, so the profile stops loading and the app
  // returns to sign-in. (Sign-ins are rate-limited per IP, and both projects share one, so the
  // suite signs in as few times as it can.)
  await invitee.goto('/desk/me');
  await expect(invitee.getByRole('heading', { level: 1, name: 'Your profile' })).toBeVisible();
  await invitee.getByRole('button', { name: 'Sign out of all sessions' }).click();
  await expect(invitee).toHaveURL(/\/desk\/sign-in$/);

  await invitee.goto('/desk/me');
  await expect(invitee.getByRole('heading', { level: 1, name: 'Your profile' })).toBeHidden();

  await context.close();
});

test('a customer signs in with an emailed link', async ({ page, request, axe }) => {
  // A new address every run: self-registration is on, so the link creates the customer, and two
  // tests never supersede each other's link for one account.
  const email = uniqueEmail('e2e-customer');

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await axe.check();

  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByRole('textbox', { name: 'Name' }).fill('E2E Customer');
  await page.getByRole('button', { name: 'Send sign-in link' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Check your email' })).toBeVisible();

  const mail = await waitForMessage(request, email, 'sign-in link');
  await page.goto(linkPath(mail, '/sign-in/redeem'));
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Support' })).toBeVisible();
  await axe.check();
});
