import { request as playwrightRequest } from '@playwright/test';

import { expect, test } from './fixtures';
import { linkPath, uniqueEmail, waitForMessage } from './mailpit';
import { API_ORIGIN, deskApiOf, SEED_PASSWORD, signInStaffUi, TENANT_HOST } from './staff-ui';

import type { APIRequestContext } from '@playwright/test';

/**
 * US12: an admin adds a business-hours calendar and an SLA policy in Admin, a customer's new
 * message becomes a ticket the policy covers, the desk shows its SLA badge with time left, and the
 * dashboard page renders. A `finally` deletes the policy and the calendar through the API.
 *
 * Two sign-ins: the admin through the desk UI and one customer sign-in link redeemed from Node.
 */

const ADMIN_EMAIL = 'admin@acme.test';

async function signInCustomer(request: APIRequestContext, email: string, name: string) {
  const api = await playwrightRequest.newContext({ baseURL: API_ORIGIN, extraHTTPHeaders: { Host: TENANT_HOST } });
  const requested = await api.post('/api/v1/customer/auth/sign-in-link', { data: { email, name } });
  expect(requested.status()).toBe(202);
  const token = new URLSearchParams(linkPath(await waitForMessage(request, email, 'sign-in link'), '/sign-in/redeem').split('?')[1]).get('token');
  if (token === null) throw new Error('No token in the sign-in link');
  const deadline = Date.now() + 70_000;
  for (;;) {
    const redeemed = await api.post('/api/v1/customer/auth/sign-in-link/redeem', { data: { token } });
    if (redeemed.ok()) break;
    const body = await redeemed.text();
    if (redeemed.status() !== 429 || Date.now() > deadline) throw new Error(`Redeem failed: ${redeemed.status()} ${body}`);
    const retryAfter = (JSON.parse(body) as { error?: { retryAfter?: number } }).error?.retryAfter ?? 5;
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000 + 250));
  }
  const { cookies } = await api.storageState();
  const csrf = cookies.find((cookie) => cookie.name === 'rx_csrf')?.value;
  if (csrf === undefined) throw new Error('Redeem set no rx_csrf cookie');
  const cookie = cookies.map((entry) => `${entry.name}=${entry.value}`).join('; ');
  return {
    send: async (body: string) => {
      const response = await api.post('/api/v1/customer/messages', {
        headers: { 'X-CSRF-Token': csrf, Cookie: cookie },
        data: { body, clientMessageId: crypto.randomUUID() },
      });
      if (!response.ok()) throw new Error(`Customer message failed: ${response.status()} ${await response.text()}`);
    },
    close: () => api.dispose(),
  };
}

test('an admin sets business hours and an SLA policy, a ticket shows its SLA badge, and the dashboard renders', async ({ page, request, axe }) => {
  test.setTimeout(240_000);

  const marker = `e2esla${Date.now().toString(36)}`;
  const calendarName = `e2e-hours-${marker}`;
  const policyName = `e2e-policy-${marker}`;

  await signInStaffUi(page, ADMIN_EMAIL, SEED_PASSWORD);
  const { api, csrf } = await deskApiOf(page);
  let customer: Awaited<ReturnType<typeof signInCustomer>> | undefined;

  try {
    // --- Business hours. --------------------------------------------------------------------
    await page.goto('/desk/admin/business-hours');
    await expect(page.getByRole('heading', { level: 1, name: 'Business hours' })).toBeVisible({ timeout: 30_000 });
    await axe.check();
    await page.getByRole('button', { name: 'Add calendar' }).first().click();
    const hoursDrawer = page.getByRole('dialog', { name: 'Add business hours' });
    await expect(hoursDrawer).toBeVisible();
    await hoursDrawer.getByRole('textbox', { name: /^Name/ }).fill(calendarName);
    await axe.check({ selector: 'form[aria-label="Add business hours"]' });
    // Enter submits the form: on a phone the weekly-hours rows cover the sticky Save button (see report).
    await hoursDrawer.getByRole('textbox', { name: /^Name/ }).press('Enter');
    await expect(hoursDrawer).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'Business-hours calendars' }).getByRole('listitem').filter({ hasText: calendarName })).toBeVisible();

    // --- An SLA policy that covers every ticket (no conditions) on that calendar. -------------
    await page.goto('/desk/admin/sla-policies');
    await expect(page.getByRole('heading', { level: 1, name: 'SLA policies' })).toBeVisible({ timeout: 30_000 });
    await axe.check();
    await page.getByRole('button', { name: 'Add policy' }).first().click();
    const policyDrawer = page.getByRole('dialog', { name: 'Add SLA policy' });
    await expect(policyDrawer).toBeVisible();
    await policyDrawer.getByRole('textbox', { name: /^Name/ }).fill(policyName);
    await policyDrawer.getByRole('combobox', { name: /^Calendar/ }).click();
    await page.getByRole('listbox').getByRole('option', { name: calendarName, exact: true }).click();
    await policyDrawer.getByRole('spinbutton', { name: /^First response target/ }).fill('480');
    await axe.check({ selector: 'form[aria-label="Add SLA policy"]' });
    await policyDrawer.getByRole('spinbutton', { name: /^First response target/ }).press('Enter');
    await expect(policyDrawer).toHaveCount(0);
    await expect(page.getByText(policyName).first()).toBeVisible();

    // --- A new customer ticket is covered, and the desk shows the badge. ----------------------
    customer = await signInCustomer(request, uniqueEmail('e2e-sla'), 'SLA Customer');
    await customer.send(`Question about ${marker}: how long will this take?`);
    await expect
      .poll(
        async () => {
          const response = await api.get('/api/v1/tickets?limit=50');
          const { items } = (await response.json()) as { items: { title: string; sla?: { status: string } }[] };
          return items.find((ticket) => ticket.title.includes(marker))?.sla?.status;
        },
        { timeout: 30_000, message: 'the ticket should be covered by the new policy' },
      )
      .toMatch(/^(ok|warning)$/);

    await page.goto('/desk/inbox');
    const row = page.getByRole('option', { name: new RegExp(marker) }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.locator('[data-sla-status]')).toContainText(/left/);
    await expect(row).toContainText(/First response due in/);
    await axe.check();

    // --- Dashboard. -------------------------------------------------------------------------
    await page.goto('/desk/dashboard');
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/^Updated /)).toBeVisible();
    await axe.check();
  } finally {
    // Leave no policy or calendar behind, even when the test stopped part-way.
    try {
      const policies = await api.get('/api/v1/sla-policies');
      if (policies.ok()) {
        const { items } = (await policies.json()) as { items: { id: string; name: string }[] };
        for (const item of items.filter((entry) => entry.name === policyName)) {
          await api.delete(`/api/v1/sla-policies/${item.id}`, { headers: { 'X-CSRF-Token': csrf } });
        }
      }
      const calendars = await api.get('/api/v1/business-hours');
      if (calendars.ok()) {
        const { items } = (await calendars.json()) as { items: { id: string; name: string }[] };
        for (const item of items.filter((entry) => entry.name === calendarName)) {
          await api.delete(`/api/v1/business-hours/${item.id}`, { headers: { 'X-CSRF-Token': csrf } });
        }
      }
    } catch {
      // Cleanup must not mask the test's own failure.
    }
    await customer?.close();
    await api.dispose();
  }
});
