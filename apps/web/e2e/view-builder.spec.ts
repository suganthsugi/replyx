import { expect, test } from './fixtures';
import { deskApiOf, SEED_PASSWORD, signInStaffUi } from './staff-ui';

import type { APIRequestContext, Page } from '@playwright/test';

/**
 * T212 (spec US10, SC-015): an admin builds and shares a three-condition view in under a minute
 * (from choosing "New view" to seeing the saved view selected on the rail). The view is shared with
 * the Support Agent role; the agent, who can only access Support, sees it on their rail with only
 * the Support ticket, never the Billing one. Also covers the drawer's keyboard behaviour (Escape on
 * a changed form asks before discarding) and an axe check of the open drawer.
 *
 * Two sign-ins in all (admin, agent), each through the desk UI. Tickets are created through the API
 * as the admin, so the outcome is deterministic.
 */

const ADMIN_EMAIL = 'admin@acme.test';
const AGENT_EMAIL = 'agent@acme.test';
const CUSTOMER_EMAIL = 'customer@acme.test';
const AGENT_ROLE = 'Support Agent';
const SC_015_MS = 60_000;

async function json<T>(response: Awaited<ReturnType<APIRequestContext['get']>>, what: string): Promise<T> {
  if (!response.ok()) throw new Error(`${what} failed: ${response.status()} ${await response.text()}`);
  return (await response.json()) as T;
}

async function createTicket(api: APIRequestContext, csrf: string, customerId: string, groupId: string, title: string): Promise<void> {
  await json(
    await api.post('/api/v1/tickets', {
      headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': crypto.randomUUID() },
      data: { customerId, groupId, title, priority: 'urgent', message: { body: `Opened for the view builder check: ${title}` } },
    }),
    `Create ticket "${title}"`,
  );
}

/** Sets one condition row (1-based) to `field`, `operator` and its `values`. */
async function setCondition(page: Page, number: number, field: string, operator: string, values: string[]) {
  const row = page.getByRole('dialog').first().getByRole('group', { name: `Condition ${number}`, exact: true });
  await row.getByRole('combobox', { name: 'Field' }).click();
  await page.getByRole('listbox').getByRole('option', { name: field, exact: true }).click();
  await row.getByRole('combobox', { name: 'Operator' }).click();
  await page.getByRole('listbox').getByRole('option', { name: operator, exact: true }).click();
  for (const value of values) {
    await row.getByRole('combobox', { name: 'Value' }).click();
    await page.getByRole('listbox').getByRole('option', { name: value, exact: true }).click();
  }
  // The multi-select popup stays open after a pick.
  await page.keyboard.press('Escape');
}

test('an admin builds and shares a three-condition view in under a minute, and the agent sees only their groups', async ({ browser, axe }) => {
  test.setTimeout(240_000);

  const marker = Date.now().toString(36);
  const viewName = `Urgent unowned ${marker}`;
  const supportTitle = `View check support ${marker}`;
  const billingTitle = `View check billing ${marker}`;

  const adminContext = await browser.newContext();
  const agentContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  const agentPage = await agentContext.newPage();

  await signInStaffUi(adminPage, ADMIN_EMAIL, SEED_PASSWORD);
  const { api: adminApi, csrf } = await deskApiOf(adminPage);
  // The agent signs in first and stays on the inbox, so the new view reaches their rail live.
  await signInStaffUi(agentPage, AGENT_EMAIL, SEED_PASSWORD);
  const { api: agentApi } = await deskApiOf(agentPage);

  try {
    // --- Deterministic data: an urgent, unowned ticket in Support and one in Billing. ----------
    const { items: groups } = await json<{ items: { id: string; name: string }[] }>(await adminApi.get('/api/v1/groups'), 'List groups');
    const support = groups.find((group) => group.name === 'Support');
    const billing = groups.find((group) => group.name === 'Billing');
    if (support === undefined || billing === undefined) throw new Error('The seed needs Support and Billing groups');
    const { items: customers } = await json<{ items: { id: string }[] }>(
      await adminApi.get(`/api/v1/users?kind=customer&q=${encodeURIComponent(CUSTOMER_EMAIL)}`),
      'Find the seeded customer',
    );
    const customer = customers[0];
    if (customer === undefined) throw new Error(`No customer ${CUSTOMER_EMAIL} in the seed`);
    await createTicket(adminApi, csrf, customer.id, support.id, supportTitle);
    await createTicket(adminApi, csrf, customer.id, billing.id, billingTitle);

    // --- Keyboard: Escape on a changed form asks before discarding. -----------------------------
    const rail = adminPage.getByRole('navigation', { name: 'Views' });
    await rail.getByRole('button', { name: 'New view' }).click();
    const drawer = adminPage.getByRole('dialog').filter({ has: adminPage.getByRole('form', { name: 'New view' }) });
    await expect(drawer).toBeVisible();
    const nameField = drawer.getByRole('textbox', { name: 'Name' });
    await expect(nameField).toBeFocused();
    await axe.check({ selector: 'form[aria-label="New view"]', page: adminPage });

    await nameField.fill('Scratch view');
    await adminPage.keyboard.press('Escape');
    const discard = adminPage.getByRole('dialog', { name: 'Discard your changes?' });
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: 'Keep editing' }).click();
    await expect(discard).toHaveCount(0);
    await expect(nameField).toHaveValue('Scratch view');
    await adminPage.keyboard.press('Escape');
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: 'Discard changes' }).click();
    await expect(adminPage.getByRole('form', { name: 'New view' })).toHaveCount(0);

    // --- SC-015: New view -> three conditions -> share -> save, timed. --------------------------
    const started = Date.now();
    await rail.getByRole('button', { name: 'New view' }).click();
    await expect(nameField).toBeFocused();
    await nameField.fill(viewName);

    // Condition 1 already reads "State is not Closed"; add the other two.
    await expect(drawer.getByRole('group', { name: 'Condition 1', exact: true })).toBeVisible();
    await drawer.getByRole('button', { name: 'Add condition' }).click();
    await setCondition(adminPage, 2, 'Priority', 'is', ['Urgent']);
    await drawer.getByRole('button', { name: 'Add condition' }).click();
    await setCondition(adminPage, 3, 'Owner', 'is', ['Unassigned']);

    await drawer.getByRole('radio', { name: 'Specific roles' }).check();
    await drawer.getByRole('combobox', { name: 'Roles' }).click();
    await adminPage.getByRole('listbox').getByRole('option', { name: AGENT_ROLE, exact: true }).click();
    await adminPage.keyboard.press('Escape');

    // The preview counts what the admin can see: at least the two tickets made above.
    const preview = drawer.getByText(/^\d+ tickets? match(es)? now$/);
    await expect(preview).toBeVisible({ timeout: 20_000 });
    expect(Number(/^(\d+)/.exec((await preview.textContent()) ?? '')?.[1])).toBeGreaterThanOrEqual(2);

    await drawer.getByRole('button', { name: 'Create view' }).click();
    const createdView = rail.getByRole('button', { name: new RegExp(`^${viewName}`) });
    await expect(createdView).toHaveAttribute('aria-current', 'page', { timeout: 20_000 });
    const elapsed = Date.now() - started;
    expect(elapsed, `Building and sharing took ${elapsed} ms`).toBeLessThan(SC_015_MS);
    await expect(adminPage.getByRole('form', { name: 'New view' })).toHaveCount(0);
    // The creator sees their own role-shared view, and its list loads (their own Support ticket is in it).
    await expect(adminPage.getByRole('option', { name: new RegExp(supportTitle) })).toBeVisible({ timeout: 20_000 });
    await expect(adminPage.getByText('View not found')).toHaveCount(0);

    // --- The agent sees the view, with only the tickets in their groups. ------------------------
    const agentView = agentPage.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: new RegExp(`^${viewName}`) });
    // Arrives live; a reload is the fallback if the hint is missed.
    try {
      await expect(agentView).toBeVisible({ timeout: 15_000 });
    } catch {
      await agentPage.reload();
      await expect(agentView).toBeVisible({ timeout: 20_000 });
    }
    await agentView.click();
    await expect(agentView).toHaveAttribute('aria-current', 'page');
    await expect(agentPage.getByRole('option', { name: new RegExp(supportTitle) })).toBeVisible({ timeout: 20_000 });
    await expect(agentPage.getByRole('option', { name: new RegExp(billingTitle) })).toHaveCount(0);

    // The API agrees: the shared view never reveals a ticket in a group the agent cannot access.
    const views = await json<{ items: { id: string; name: string }[] }>(await agentApi.get('/api/v1/views'), 'List views as agent');
    const shared = views.items.find((view) => view.name === viewName);
    if (shared === undefined) throw new Error('The shared view is not in the agent view list');
    const tickets = await json<{ items: { title: string }[] }>(await agentApi.get(`/api/v1/tickets?viewId=${shared.id}&limit=100`), 'List view tickets as agent');
    const titles = tickets.items.map((ticket) => ticket.title);
    expect(titles).toContain(supportTitle);
    expect(titles).not.toContain(billingTitle);
  } finally {
    await Promise.all([adminApi.dispose(), agentApi.dispose()]);
    await Promise.all([adminContext.close(), agentContext.close()]);
  }
});
