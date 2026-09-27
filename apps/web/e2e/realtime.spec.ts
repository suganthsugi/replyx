import { request as playwrightRequest } from '@playwright/test';

import { expect, test } from './fixtures';
import { linkPath, uniqueEmail, waitForMessage } from './mailpit';
import { API_ORIGIN, deskApiOf, SEED_PASSWORD, signInStaffUi, TENANT_HOST } from './staff-ui';

import type { APIRequestContext, BrowserContext, Page, WebSocketRoute } from '@playwright/test';

/**
 * T172 (spec US8): two staff browsers see list and count changes live; the agent goes offline,
 * three customer messages arrive, and back online the agent sees all three once, with the right
 * unread count.
 *
 * Three sign-ins in all (admin and agent through the desk UI, the customer's link through the API):
 * the admin's actions go through the API on the admin browser's own session.
 *
 * "Offline" is the agent's browser context going offline (no polling fallback, no REST) while the
 * live WebSocket is closed and new ones are refused, since Chromium's offline mode alone leaves an
 * already-open WebSocket up.
 */

const ADMIN_EMAIL = 'admin@acme.test';
const AGENT_EMAIL = 'agent@acme.test';
const SUPPORT_GROUP = 'Support';
const VIEW = 'Unassigned & Open';

interface Customer {
  api: APIRequestContext;
  csrf: string;
  send(body: string): Promise<void>;
}

/** A new customer signed in by email link from Node, sending messages through the customer API. */
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
    csrf,
    send: async (body) => {
      const response = await api.post('/api/v1/customer/messages', {
        headers: { 'X-CSRF-Token': csrf, Cookie: cookie },
        data: { body, clientMessageId: crypto.randomUUID() },
      });
      if (!response.ok()) throw new Error(`Customer message failed: ${response.status()} ${await response.text()}`);
    },
  };
}

/** Lets the page's `/rt` WebSocket through, or drops it and refuses new ones, on demand. */
async function controllableSocket(page: Page) {
  let blocked = false;
  const open = new Set<WebSocketRoute>();
  await page.routeWebSocket(/\/rt\//, (ws) => {
    if (blocked) {
      void ws.close({ code: 4000, reason: 'offline' });
      return;
    }
    ws.connectToServer();
    open.add(ws);
  });
  return {
    async goOffline(context: BrowserContext) {
      blocked = true;
      await context.setOffline(true);
      for (const ws of open) await ws.close({ code: 4000, reason: 'offline' });
      open.clear();
    },
    async goOnline(context: BrowserContext) {
      blocked = false;
      await context.setOffline(false);
    },
  };
}


/** Polls `read` until it returns a value (not undefined), or fails after `timeoutMs`. */
async function eventually<T>(read: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Nothing after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
/** The count badge of a rail view (0 when there's no badge). */
async function railCount(page: Page, view: string): Promise<number> {
  const name = (await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: new RegExp(`^${view}`) }).textContent()) ?? '';
  const count = /(\d+)\s*$/.exec(name.slice(view.length));
  return count === null ? 0 : Number(count[1]);
}

async function openView(page: Page, view: string) {
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: new RegExp(`^${view}`) }).click();
}

test('staff see list and count changes live, and an agent back online catches up exactly once', async ({ browser, request }) => {
  test.setTimeout(240_000);
  const marker = `rt-${Date.now().toString(36)}`;
  const firstMessage = `Realtime check ${marker}: my parcel never arrived`;

  // The ticket: a new customer's first message, which lands in Needs Triage (Ungrouped).
  const customer = await signInCustomer(request, uniqueEmail('e2e-realtime'), 'Realtime Customer');
  await customer.send(firstMessage);

  const adminContext = await browser.newContext();
  const agentContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  const agentPage = await agentContext.newPage();
  const agentSocket = await controllableSocket(agentPage);
  await signInStaffUi(adminPage, ADMIN_EMAIL, SEED_PASSWORD);
  await signInStaffUi(agentPage, AGENT_EMAIL, SEED_PASSWORD);

  const { api: adminApi, csrf: adminCsrf } = await deskApiOf(adminPage);
  const { api: agentApi } = await deskApiOf(agentPage);
  const ticket = await eventually(async () => {
    const response = await adminApi.get('/api/v1/tickets?groupId=ungrouped&limit=50');
    const { items } = (await response.json()) as { items: { id: string; number: number; title: string }[] };
    return items.find((candidate) => candidate.title.includes(marker));
  });
  const ticketId = ticket.id;
  const groups = (await (await adminApi.get('/api/v1/groups')).json()) as { items: { id: string; name: string }[] };
  const support = groups.items.find((group) => group.name === SUPPORT_GROUP);
  if (support === undefined) throw new Error('No Support group in the seed');
  const me = (await (await agentApi.get('/api/v1/me')).json()) as { id: string };

  // 1. Both browsers are on Unassigned & Open; the admin moves the ticket into Support.
  await openView(adminPage, VIEW);
  await openView(agentPage, VIEW);
  // Loaded first, so the move below is a live change to a list that's already there.
  await expect(adminPage.getByRole('listbox', { name: `Tickets in ${VIEW}` })).toBeVisible();
  await expect(agentPage.getByRole('listbox', { name: `Tickets in ${VIEW}` })).toBeVisible();
  const adminBefore = await railCount(adminPage, VIEW);
  const agentBefore = await railCount(agentPage, VIEW);
  const moved = await adminApi.patch(`/api/v1/tickets/${ticketId}`, { headers: { 'X-CSRF-Token': adminCsrf }, data: { groupId: support.id } });
  expect(moved.status()).toBe(200);

  // Without a refresh, both lists show it and both counts go up.
  const row = (page: Page) => page.getByRole('option', { name: new RegExp(marker) });
  await expect(row(adminPage)).toBeVisible();
  await expect(row(agentPage)).toBeVisible();
  await expect.poll(() => railCount(adminPage, VIEW)).toBe(adminBefore + 1);
  await expect.poll(() => railCount(agentPage, VIEW)).toBe(agentBefore + 1);

  // 2. The agent opens the ticket; the admin assigns it to them (they're notified).
  await row(agentPage).click();
  // In the conversation itself, not the list row (the ticket's title is the same text).
  const conversation = agentPage.getByRole('region', { name: 'Ticket conversation' });
  await expect(conversation.getByText(firstMessage)).toBeVisible();
  const assigned = await adminApi.patch(`/api/v1/tickets/${ticketId}`, { headers: { 'X-CSRF-Token': adminCsrf }, data: { ownerId: me.id } });
  expect(assigned.status()).toBe(200);
  await expect(agentPage.getByRole('button', { name: /^Notifications, \d+ unread$/ })).toBeVisible();

  // 3. The agent goes offline; three customer messages arrive meanwhile.
  await agentSocket.goOffline(agentContext);
  await expect(agentPage.getByText(/Reconnecting/).first()).toBeVisible();
  const missed = [1, 2, 3].map((n) => `Follow-up ${n} ${marker}`);
  for (const body of missed) await customer.send(body);
  // All three are stored and notified (one burst entry, count 3) before the agent comes back. This
  // API context is the test's own, so the browser being offline doesn't affect it.
  await eventually(async () => {
    const response = await agentApi.get('/api/v1/notifications?limit=50');
    const { items } = (await response.json()) as { items: { ticketId: string | null; eventType: string; count: number }[] };
    return items.some((item) => item.ticketId === ticketId && item.eventType === 'message.customer_on_my_ticket' && item.count === 3) ? true : undefined;
  }, 20_000);

  // 4. Back online: every missed message shows exactly once, and the badge matches the server.
  await agentSocket.goOnline(agentContext);
  await expect(agentPage.getByText(/Reconnecting/)).toHaveCount(0, { timeout: 20_000 });
  for (const body of missed) await expect(conversation.getByText(body, { exact: true })).toHaveCount(1);
  const expectedUnread = ((await (await agentApi.get('/api/v1/notifications?limit=1')).json()) as { unreadCount: number }).unreadCount;
  expect(expectedUnread).toBeGreaterThan(0);
  await expect(agentPage.getByRole('button', { name: `Notifications, ${expectedUnread} unread` })).toBeVisible();

  // The burst is one entry with a count, not three.
  await agentPage.getByRole('button', { name: `Notifications, ${expectedUnread} unread` }).click();
  const panel = agentPage.getByRole('dialog', { name: 'Notifications' });
  // This ticket's entry only: the shared dev database keeps the agent's entries from earlier runs.
  const burst = panel.getByRole('listitem').filter({ hasText: `Realtime Customer wrote on #${ticket.number}` });
  await expect(burst).toHaveCount(1);
  await expect(burst.getByText('3 messages')).toBeVisible();

  await Promise.all([adminApi.dispose(), agentApi.dispose(), customer.api.dispose()]);
  await Promise.all([adminContext.close(), agentContext.close()]);
});
