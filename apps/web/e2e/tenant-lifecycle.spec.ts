import { expect, test } from './fixtures';
import { linkPath, uniqueEmail, waitForMessage } from './mailpit';

import type { Browser, Page } from '@playwright/test';

/**
 * Tenant lifecycle end to end (T089) against the dev stack: an operator creates a tenant on the
 * console host, its first admin accepts the emailed invitation, and a customer signs in to its
 * chat. Suspending the tenant ends both open sessions over the socket (FR-004): the admin lands
 * on sign-in and the chat shows the unavailable page without a reload. Reactivating restores
 * access with the admin's account intact.
 *
 * Every run creates its own tenant, so suspending it never touches the seeded `acme` the other
 * specs use.
 */

const PORT = 5173;
const CONSOLE = `http://console.localhost:${PORT}`;
const OPERATOR_EMAIL = process.env.OPERATOR_BOOTSTRAP_EMAIL ?? 'operator@replyx.test';
const OPERATOR_PASSWORD = process.env.OPERATOR_BOOTSTRAP_PASSWORD ?? 'operator-password';
const ADMIN_PASSWORD = 'e2e-admin-password-1';

function uniqueSlug(): string {
  return `e2e-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

async function newPage(browser: Browser | null): Promise<Page> {
  if (browser === null) throw new Error('no browser');
  const context = await browser.newContext();
  return context.newPage();
}

test('an operator creates, suspends and reactivates a tenant', async ({ page, request, browser, axe }) => {
  // Three sessions and two emails: longer than the default 30 s on a busy runner.
  test.setTimeout(90_000);
  const slug = uniqueSlug();
  const tenant = `http://${slug}.localhost:${PORT}`;
  const adminEmail = uniqueEmail('e2e-admin');
  const customerEmail = uniqueEmail('e2e-customer');

  // The operator: the console shows its sign-in form until there is a session.
  await page.goto(`${CONSOLE}/`);
  await expect(page.getByRole('heading', { level: 1, name: 'Platform console' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Email' }).fill(OPERATOR_EMAIL);
  await page.getByLabel('Password *').fill(OPERATOR_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tenants' })).toBeVisible();
  await axe.check();

  await page.getByRole('button', { name: 'Create a tenant' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a tenant' });
  await dialog.getByRole('textbox', { name: 'Workspace name' }).fill(`E2E ${slug}`);
  await dialog.getByRole('textbox', { name: 'Address' }).fill(slug);
  await dialog.getByRole('textbox', { name: "First admin's email" }).fill(adminEmail);
  // Submitted from the keyboard, as in the sign-in spec: on the phone viewport a click on the
  // footer button lands on the dialog container.
  await dialog.getByRole('textbox', { name: "First admin's email" }).press('Enter');
  await expect(dialog).toBeHidden();

  await page.getByRole('textbox', { name: 'Search' }).fill(slug);
  const row = page.getByRole('row').filter({ hasText: slug });
  await expect(row.getByText('Active')).toBeVisible();

  // The first admin accepts the invitation on the new tenant's host and stays on the desk,
  // where the workspace opens its socket.
  const invitation = await waitForMessage(request, adminEmail, 'invited');
  const admin = await newPage(browser);
  await admin.goto(`${tenant}${linkPath(invitation, '/desk/accept-invitation')}`);
  await admin.getByRole('textbox', { name: 'Name' }).fill('E2E Admin');
  await admin.getByLabel('Password *').fill(ADMIN_PASSWORD);
  await admin.getByRole('button', { name: 'Accept and continue' }).click();
  await expect(admin).toHaveURL(/\/desk$/);

  // A customer signs in to the tenant's chat with an emailed link.
  const customer = await newPage(browser);
  await customer.goto(`${tenant}/`);
  await customer.getByRole('textbox', { name: 'Email' }).fill(customerEmail);
  await customer.getByRole('textbox', { name: 'Name' }).fill('E2E Customer');
  await customer.getByRole('button', { name: 'Send sign-in link' }).click();
  const signInMail = await waitForMessage(request, customerEmail, 'sign-in link');
  await customer.goto(`${tenant}${linkPath(signInMail, '/sign-in/redeem')}`);
  await customer.getByRole('button', { name: 'Continue' }).click();
  await expect(customer.getByRole('heading', { level: 1, name: 'Support' })).toBeVisible();

  // Suspend while both are connected.
  await row.getByRole('button', { name: 'Suspend' }).click();
  const confirm = page.getByRole('dialog', { name: 'Suspend tenant' });
  await confirm.getByRole('button', { name: 'Suspend' }).press('Enter');
  await expect(row.getByText('Suspended')).toBeVisible();

  await expect(admin).toHaveURL(/\/desk\/sign-in$/);
  await expect(customer.getByRole('heading', { level: 1, name: 'Support is unavailable' })).toBeVisible();
  await axe.check();

  // Signing in is refused while suspended.
  await admin.getByRole('textbox', { name: 'Email' }).fill(adminEmail);
  await admin.getByLabel('Password *').fill(ADMIN_PASSWORD);
  await admin.getByRole('button', { name: 'Sign in' }).click();
  // (The same words are in the toast that announced the suspension: look inside the form.)
  await expect(admin.getByRole('form', { name: 'Sign in' }).getByText('This workspace is currently unavailable.')).toBeVisible();

  // Reactivate: the admin signs in with the same account, and the chat is reachable again.
  await row.getByRole('button', { name: 'Reactivate' }).click();
  await page.getByRole('dialog', { name: 'Reactivate tenant' }).getByRole('button', { name: 'Reactivate' }).press('Enter');
  await expect(row.getByText('Active')).toBeVisible();

  await admin.getByRole('button', { name: 'Sign in' }).click();
  await expect(admin).toHaveURL(/\/desk$/);

  // Suspension signed the customer out too; the chat is back at its sign-in.
  await customer.reload();
  await expect(customer.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();

  await admin.context().close();
  await customer.context().close();
});
