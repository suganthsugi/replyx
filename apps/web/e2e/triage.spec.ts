import { request as playwrightRequest } from '@playwright/test';

import { expect, test } from './fixtures';
import { linkPath, uniqueEmail, waitForMessage } from './mailpit';
import { API_ORIGIN, deskApiOf, SEED_PASSWORD, signInStaffUi, TENANT_HOST } from './staff-ui';

import type { APIRequestContext, Page } from '@playwright/test';

/**
 * T179 (spec US5, SC-005): a manager triages an ungrouped ticket to Support in <= 3 actions from
 * Needs Triage; the ticket leaves Needs Triage and appears in Support's "Unassigned & Open" for the
 * agent, who is notified. The manager has view+edit on Ungrouped only (no Support access), so once
 * the ticket lands in Support their own focus pane closes (`visibleToCaller: false`). A second,
 * keyboard-only ticket covers the `G` -> pick group with arrows+Enter -> `Enter` to assign shortcut
 * (no mouse) with the same two sessions, to stay inside the suite's shared sign-in budget.
 *
 * Three sign-ins in all: manager and agent through the desk UI (reused for both tickets), and two
 * customer sign-in links redeemed from Node (one ticket per scenario).
 */

const MANAGER_EMAIL = 'manager@acme.test';
const AGENT_EMAIL = 'agent@acme.test';
const NEEDS_TRIAGE = 'Needs Triage';
const UNASSIGNED_OPEN = 'Unassigned & Open';
const SUPPORT_GROUP = 'Support';

interface Customer {
  api: APIRequestContext;
  send(body: string): Promise<void>;
  close(): Promise<void>;
}

/** A new customer signed in by email link from Node, sending messages through the customer API
 * (matches no routing rule, so the message's ticket lands in Needs Triage / Ungrouped). */
async function signInCustomer(request: APIRequestContext, email: string, name: string): Promise<Customer> {
  const api = await playwrightRequest.newContext({ baseURL: API_ORIGIN, extraHTTPHeaders: { Host: TENANT_HOST } });
  const requested = await api.post('/api/v1/customer/auth/sign-in-link', { data: { email, name } });
  expect(requested.status()).toBe(202);
  const token = new URLSearchParams(linkPath(await waitForMessage(request, email, 'sign-in link'), '/sign-in/redeem').split('?')[1]).get('token');
  if (token === null) throw new Error('No token in the sign-in link');
  // Redeeming shares the suite's per-IP sign-in budget: wait out a limit instead of failing.
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
    api,
    send: async (body) => {
      const response = await api.post('/api/v1/customer/messages', {
        headers: { 'X-CSRF-Token': csrf, Cookie: cookie },
        data: { body, clientMessageId: crypto.randomUUID() },
      });
      if (!response.ok()) throw new Error(`Customer message failed: ${response.status()} ${await response.text()}`);
    },
    close: () => api.dispose(),
  };
}

/** Polls `read` until it returns a value (not undefined), or fails after `timeoutMs`. */
async function eventually<T>(read: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Nothing after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function openView(page: Page, view: string) {
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: new RegExp(`^${view}`) }).click();
}

/** The ungrouped ticket a customer's first message created, found through `api` (the caller's own
 * session), matched by the unique marker in its title. */
async function findUngroupedTicket(api: APIRequestContext, marker: string): Promise<{ id: string; number: number }> {
  return eventually(async () => {
    const response = await api.get('/api/v1/tickets?groupId=ungrouped&limit=50');
    const { items } = (await response.json()) as { items: { id: string; number: number; title: string }[] };
    return items.find((candidate) => candidate.title.includes(marker));
  });
}

test('a manager triages an ungrouped ticket to Support in three actions, and the agent is notified', async ({ browser, request }) => {
  test.setTimeout(240_000);

  const managerContext = await browser.newContext();
  const agentContext = await browser.newContext();
  const managerPage = await managerContext.newPage();
  const agentPage = await agentContext.newPage();
  await signInStaffUi(managerPage, MANAGER_EMAIL, SEED_PASSWORD);
  await signInStaffUi(agentPage, AGENT_EMAIL, SEED_PASSWORD);
  const { api: managerApi } = await deskApiOf(managerPage);
  const { api: agentApi } = await deskApiOf(agentPage);

  try {
    // --- Scenario 1: mouse, Group combobox + Assign button. ---------------------------------
    const marker1 = `triage-mouse-${Date.now().toString(36)}`;
    const question1 = `Triage check ${marker1}: my order status`;
    const customer1 = await signInCustomer(request, uniqueEmail('e2e-triage-mouse'), 'Triage Mouse Customer');
    await customer1.send(question1);
    const ticket1 = await findUngroupedTicket(managerApi, marker1);

    await openView(managerPage, NEEDS_TRIAGE);
    const row1 = managerPage.getByRole('option', { name: new RegExp(marker1) });
    await expect(row1).toBeVisible({ timeout: 20_000 });
    // Action 1: open the ticket.
    await row1.click();
    await expect(managerPage.getByRole('heading', { level: 2, name: question1 })).toBeVisible({ timeout: 60_000 });

    const triage1 = managerPage.getByRole('region', { name: 'Triage' });
    // Action 2: pick the destination group.
    await triage1.getByRole('combobox', { name: 'Group' }).click();
    await managerPage.getByRole('listbox').getByRole('option', { name: SUPPORT_GROUP, exact: true }).click();
    // Action 3: assign.
    await triage1.getByRole('button', { name: 'Assign' }).click();

    await expect(managerPage.locator('[aria-live="polite"]')).toContainText(`Ticket sent to ${SUPPORT_GROUP}`);
    // The manager has no access to Support: their own focus closes and the ticket drops out of
    // their Needs Triage list without a page reload.
    await expect(managerPage.getByRole('heading', { level: 2, name: question1 })).toHaveCount(0);
    await expect(managerPage.getByRole('option', { name: new RegExp(marker1) })).toHaveCount(0);

    // The agent sees it, without a mouse click here either: it arrives live in Support's queue.
    await openView(agentPage, UNASSIGNED_OPEN);
    await expect(agentPage.getByRole('option', { name: new RegExp(marker1) })).toBeVisible({ timeout: 20_000 });

    // The agent is notified: badge and a "moved to Support" entry.
    await expect(agentPage.getByRole('button', { name: /^Notifications, \d+ unread$/ })).toBeVisible({ timeout: 20_000 });
    await agentPage.getByRole('button', { name: /^Notifications, \d+ unread$/ }).click();
    const panel = agentPage.getByRole('dialog', { name: 'Notifications' });
    await expect(
      panel.getByRole('listitem').filter({ hasText: `#${ticket1.number} moved to ${SUPPORT_GROUP}` }),
    ).toBeVisible();
    await agentPage.keyboard.press('Escape');

    // --- Scenario 2: keyboard-only (G -> arrows -> Enter to pick -> Enter to assign). --------
    const marker2 = `triage-kbd-${Date.now().toString(36)}`;
    const question2 = `Triage check ${marker2}: a refund request`;
    const customer2 = await signInCustomer(request, uniqueEmail('e2e-triage-kbd'), 'Triage Keyboard Customer');
    await customer2.send(question2);
    const ticket2 = await findUngroupedTicket(managerApi, marker2);

    // The seed must carry an active Support group for the keyboard pick below.
    const groupsResponse = await managerApi.get('/api/v1/groups/destinations');
    if (!groupsResponse.ok()) throw new Error(`GET /groups/destinations as manager failed: ${groupsResponse.status()} ${await groupsResponse.text()}`);
    const { items: activeGroups } = (await groupsResponse.json()) as { items: { name: string }[] };
    if (!activeGroups.some((group) => group.name === SUPPORT_GROUP)) throw new Error('No active Support group in the seed');

    await openView(managerPage, NEEDS_TRIAGE);
    const row2 = managerPage.getByRole('option', { name: new RegExp(marker2) });
    await expect(row2).toBeVisible({ timeout: 20_000 });
    // Focuses the row and opens it with Enter, not a click, as `TicketList`'s own keyboard support.
    await row2.focus();
    await managerPage.keyboard.press('Enter');
    await expect(managerPage.getByRole('heading', { level: 2, name: question2 })).toBeVisible({ timeout: 60_000 });

    // `G` focuses Group (not while typing in a field, so this only works with focus elsewhere).
    await managerPage.locator('body').click({ position: { x: 4, y: 4 } });
    await managerPage.keyboard.press('g');
    const groupField2 = managerPage.getByRole('combobox', { name: 'Group' });
    await expect(groupField2).toBeFocused();
    // Opens the popup and highlights the first option, then walks down to Support.
    // The first ArrowDown only opens the popup; keep going until Support is the highlighted option.
    await managerPage.keyboard.press('ArrowDown');
    const supportOption = managerPage.getByRole('listbox').getByRole('option', { name: SUPPORT_GROUP, exact: true });
    await expect(supportOption).toBeVisible();
    for (let step = 0; step <= activeGroups.length && !(await supportOption.evaluate((el) => el.classList.contains('Mui-focused'))); step += 1) {
      await managerPage.keyboard.press('ArrowDown');
    }
    // Selects the highlighted option: the listbox closes, but the same Enter keydown doesn't also
    // trigger Assign (TriageBar only treats Enter as Assign once the listbox has already closed).
    await managerPage.keyboard.press('Enter');
    await expect(groupField2).toHaveValue(SUPPORT_GROUP);
    // A second, separate Enter on the now-idle field assigns.
    await managerPage.keyboard.press('Enter');

    await expect(managerPage.locator('[aria-live="polite"]')).toContainText(`Ticket sent to ${SUPPORT_GROUP}`);
    await expect(managerPage.getByRole('heading', { level: 2, name: question2 })).toHaveCount(0);
    await expect(managerPage.getByRole('option', { name: new RegExp(marker2) })).toHaveCount(0);

    await openView(agentPage, UNASSIGNED_OPEN);
    await expect(agentPage.getByRole('option', { name: new RegExp(marker2) })).toBeVisible({ timeout: 20_000 });
    await expect(agentPage.getByRole('button', { name: /^Notifications, \d+ unread$/ })).toBeVisible({ timeout: 20_000 });
    await agentPage.getByRole('button', { name: /^Notifications, \d+ unread$/ }).click();
    await expect(
      panel.getByRole('listitem').filter({ hasText: `#${ticket2.number} moved to ${SUPPORT_GROUP}` }),
    ).toBeVisible();

    await Promise.all([customer1.close(), customer2.close()]);
  } finally {
    await Promise.all([managerApi.dispose(), agentApi.dispose()]);
    await Promise.all([managerContext.close(), agentContext.close()]);
  }
});
