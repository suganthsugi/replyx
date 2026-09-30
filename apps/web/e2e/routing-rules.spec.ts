import { request as playwrightRequest } from '@playwright/test';

import { expect, test } from './fixtures';
import { linkPath, uniqueEmail, waitForMessage } from './mailpit';
import { API_ORIGIN, deskApiOf, SEED_PASSWORD, signInStaffUi, TENANT_HOST } from './staff-ui';

import type { APIRequestContext } from '@playwright/test';

/**
 * US11: an admin writes a routing rule in Admin > Routing rules, tries a message against it in
 * the Test panel, and a customer's first message containing the phrase lands in Billing with the
 * rule's priority. The rule is deleted through the UI at the end; a `finally` deletes it through the
 * API if the test stops part-way, so no enabled rule is left behind.
 *
 * Two sign-ins: the admin through the desk UI and one customer sign-in link redeemed from Node.
 */

const ADMIN_EMAIL = 'admin@acme.test';
const GROUP = 'Billing';

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

test('an admin routes a customer message to Billing with a rule, tries it first, then deletes the rule', async ({ page, request, axe }) => {
  test.setTimeout(240_000);

  const marker = `e2eroute${Date.now().toString(36)}`;
  const ruleName = `e2e-route-${marker}`;

  await signInStaffUi(page, ADMIN_EMAIL, SEED_PASSWORD);
  const { api, csrf } = await deskApiOf(page);
  let customer: Awaited<ReturnType<typeof signInCustomer>> | undefined;

  try {
    const groupsResponse = await api.get('/api/v1/groups/destinations');
    const { items: groups } = (await groupsResponse.json()) as { items: { id: string; name: string }[] };
    const billing = groups.find((group) => group.name === GROUP);
    if (billing === undefined) throw new Error('The seed needs an active Billing group');

    // --- Create the rule in the UI. ---------------------------------------------------------
    await page.goto('/desk/admin/routing');
    await expect(page.getByRole('heading', { level: 1, name: 'Routing rules' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Try a message' })).toBeVisible();
    await axe.check();

    await page.getByRole('button', { name: 'Add rule' }).first().click();
    const drawer = page.getByRole('dialog', { name: 'Add routing rule' });
    await expect(drawer).toBeVisible();
    await drawer.getByRole('textbox', { name: /^Name/ }).fill(ruleName);
    await drawer.getByRole('combobox', { name: 'First message contains any of' }).fill(marker);
    await page.keyboard.press('Enter');
    await drawer.getByRole('combobox', { name: /Assign to group/ }).click();
    await page.getByRole('listbox').getByRole('option', { name: GROUP, exact: true }).click();
    await drawer.getByRole('combobox', { name: 'Set priority' }).click();
    await page.getByRole('listbox').getByRole('option', { name: 'High', exact: true }).click();
    await axe.check({ selector: 'form[aria-label="Add routing rule"]' });
    await drawer.getByRole('button', { name: 'Add rule' }).click();
    await expect(drawer).toHaveCount(0);

    const rules = page.getByRole('list', { name: 'Routing rules, in evaluation order' });
    const row = rules.getByRole('listitem').filter({ hasText: ruleName });
    await expect(row).toBeVisible();
    await expect(row).toContainText(`Message contains any of "${marker}"`);
    await expect(row).toContainText(`Assign to ${GROUP}, priority High`);

    // --- Try a message in the Test panel. ---------------------------------------------------
    const panel = page.getByRole('region', { name: 'Try a message' });
    await panel.getByRole('textbox', { name: /^Message/ }).fill(`Hello, about ${marker} please`);
    await panel.getByRole('button', { name: 'Run' }).click();
    const result = panel.getByRole('group', { name: 'Test result' });
    await expect(result).toContainText(`${ruleName} -> ${GROUP} (high)`);

    await panel.getByRole('textbox', { name: /^Message/ }).fill('Nothing in here matches any rule zzqq');
    await panel.getByRole('button', { name: 'Run' }).click();
    await expect(result).toContainText('No rule matches');

    // --- A customer's first message is routed by it. ----------------------------------------
    customer = await signInCustomer(request, uniqueEmail('e2e-routing'), 'Routing Customer');
    await customer.send(`Question about ${marker}: can you help?`);
    await expect
      .poll(
        async () => {
          const response = await api.get(`/api/v1/tickets?groupId=${billing.id}&limit=50`);
          const { items } = (await response.json()) as { items: { title: string; priority: string }[] };
          return items.find((ticket) => ticket.title.includes(marker))?.priority;
        },
        { timeout: 30_000, message: 'the routed ticket should appear in Billing with priority high' },
      )
      .toBe('high');

    // --- Delete the rule in the UI. ---------------------------------------------------------
    await row.getByRole('button', { name: `Delete ${ruleName}` }).click();
    const confirm = page.getByRole('dialog', { name: `Delete ${ruleName}` });
    await confirm.getByRole('button', { name: 'Delete rule' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(rules.getByRole('listitem').filter({ hasText: ruleName })).toHaveCount(0);
  } finally {
    // Leave no rule behind, even when the test stopped part-way.
    try {
      const list = await api.get('/api/v1/routing-rules');
      if (list.ok()) {
        const { items } = (await list.json()) as { items: { id: string; name: string }[] };
        for (const rule of items.filter((item) => item.name === ruleName)) {
          await api.delete(`/api/v1/routing-rules/${rule.id}`, { headers: { 'X-CSRF-Token': csrf } });
        }
      }
    } catch {
      // Cleanup must not mask the test's own failure.
    }
    await customer?.close();
    await api.dispose();
  }
});
