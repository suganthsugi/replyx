import { advanceClock, resetClock } from './dev-clock';
import { expect, test } from './fixtures';
import { linkPath, messagesTo, uniqueEmail, waitForMessage } from './mailpit';
import { deskApiOf, SEED_PASSWORD, signInStaffUi } from './staff-ui';

import type { APIRequestContext, Page } from '@playwright/test';

/**
 * T189 (spec User Stories 1, 5, 6, 7; SC-016): quickstart.md "Main flow", steps 1 to 9, with the
 * customer in one browser and the manager, agent and admin in others.
 *
 * Deviation from the quickstart, step 6: the seeded Manager role has no access to the Support
 * group, so a manager can never be notified about an internal note on a Support ticket (FR-081
 * drops recipients who cannot view the ticket). The note mentions the admin (full access) instead.
 *
 * Step 9 moves the development clock by the grace period plus 1 h (the same Valkey offset `dev:advance-clock` writes),
 * which expires every staff session (12 h idle), so the admin signs in again to check the result.
 * Sign-ins: customer link, manager, agent, admin, admin again = 5 (the suite allows 10 a minute).
 */

const MANAGER_EMAIL = 'manager@acme.test';
const AGENT_EMAIL = 'agent@acme.test';
const ADMIN_EMAIL = 'admin@acme.test';
const AGENT_NAME = 'Ann Agent';
const NEEDS_TRIAGE = 'Needs Triage';
const UNASSIGNED_OPEN = 'Unassigned & Open';

async function signInCustomer(page: Page, request: APIRequestContext, email: string, name: string) {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByRole('textbox', { name: 'Name' }).fill(name);
  await page.getByRole('button', { name: 'Send sign-in link' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Check your email' })).toBeVisible();
  await page.goto(linkPath(await waitForMessage(request, email, 'sign-in link'), '/sign-in/redeem'));
  const deadline = Date.now() + 70_000;
  for (;;) {
    await page.getByRole('button', { name: 'Continue' }).click();
    const chat = page.getByRole('heading', { level: 1, name: 'Acme Support' });
    const wait = page.getByRole('alert').filter({ hasText: /Too many attempts/ });
    await expect(chat.or(wait)).toBeVisible();
    if (await chat.isVisible()) return;
    const seconds = Number(/(\d+) seconds?/.exec((await wait.textContent()) ?? '')?.[1] ?? 5);
    if (Date.now() > deadline) throw new Error('Still rate limited after 70 s');
    await page.waitForTimeout(seconds * 1000 + 250);
  }
}

async function openView(page: Page, view: string) {
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: new RegExp(`^${view}`) }).click();
}

async function railCount(page: Page, view: string): Promise<number> {
  const name = (await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: new RegExp(`^${view}`) }).textContent()) ?? '';
  const count = /(\d+)\s*$/.exec(name.slice(view.length));
  return count === null ? 0 : Number(count[1]);
}

interface TicketDetail {
  id: string;
  number: number;
  title: string;
  state: string;
  group: { id: string; name: string } | null;
  owner: { id: string; name: string } | null;
  links: { kind: string; direction: string; ticket: { id: string; number: number } | null }[];
}

async function findTicket(api: APIRequestContext, query: string, marker: string): Promise<{ id: string; number: number }> {
  let found: { id: string; number: number } | undefined;
  await expect
    .poll(async () => {
      const response = await api.get(`/api/v1/tickets?${query}&limit=50`);
      const { items } = (await response.json()) as { items: { id: string; number: number; title: string }[] };
      found = items.find((candidate) => candidate.title.includes(marker));
      return found !== undefined;
    })
    .toBe(true);
  return found as { id: string; number: number };
}

async function getTicket(api: APIRequestContext, id: string): Promise<TicketDetail> {
  const response = await api.get(`/api/v1/tickets/${id}`);
  expect(response.status()).toBe(200);
  return (await response.json()) as TicketDetail;
}

test('the customer-to-agent main flow, from first message to follow-up after the grace period', async ({ page, request, browser, axe }) => {
  test.setTimeout(420_000);
  const marker = `mf-${Date.now().toString(36)}`;
  const customerEmail = uniqueEmail('e2e-main-flow');
  const firstMessage = `My order has not arrived (${marker})`;
  const reply = `Sorry about that, I am checking your order now (${marker}).`;
  const answer = `It was order 1234 (${marker})`;
  const note = `please check the refund policy (${marker})`;
  const thanks = `thanks (${marker})`;
  const followUpMessage = `Another question about a new order (${marker})`;

  const conversation = page.getByRole('region', { name: 'Conversation' });
  const composer = page.getByRole('textbox', { name: 'Message' });
  const send = async (body: string) => {
    await composer.fill(body);
    await composer.press('Enter');
    await expect(conversation.getByRole('listitem').filter({ hasText: body })).toContainText(/Sent|Delivered|Read/);
  };

  const managerContext = await browser.newContext();
  const agentContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const managerPage = await managerContext.newPage();
  const agentPage = await agentContext.newPage();
  const adminPage = await adminContext.newPage();
  const cleanup: (() => Promise<unknown>)[] = [];

  // An aborted earlier run may have left a clock offset behind.
  await resetClock();

  try {
    await signInCustomer(page, request, customerEmail, 'E2E Main Flow Customer');
    await signInStaffUi(managerPage, MANAGER_EMAIL, SEED_PASSWORD);
    await signInStaffUi(agentPage, AGENT_EMAIL, SEED_PASSWORD);
    await signInStaffUi(adminPage, ADMIN_EMAIL, SEED_PASSWORD);
    const manager = await deskApiOf(managerPage);
    const agent = await deskApiOf(agentPage);
    const admin = await deskApiOf(adminPage);
    cleanup.push(() => manager.api.dispose(), () => agent.api.dispose(), () => admin.api.dispose());

    // The manager already has Needs Triage open, with its live count.
    await openView(managerPage, NEEDS_TRIAGE);
    const triageBefore = await railCount(managerPage, NEEDS_TRIAGE);

    // --- 1. The customer writes; no ticket concept anywhere. ------------------------------------
    await axe.check();
    await send(firstMessage);
    await expect(conversation.getByText('Support has your message')).toBeVisible();
    await expect(page.getByText(/#\d+/)).toHaveCount(0);
    await expect(page.getByText(/ticket/i)).toHaveCount(0);

    // --- 2. It appears in the manager's Needs Triage live, and the count goes up. --------------
    const row = (target: Page) => target.getByRole('option', { name: new RegExp(marker) });
    await expect(row(managerPage)).toBeVisible({ timeout: 5_000 });
    await expect.poll(() => railCount(managerPage, NEEDS_TRIAGE)).toBe(triageBefore + 1);
    const ticket = await findTicket(manager.api, 'groupId=ungrouped', marker);

    // --- 3. The manager triages it to Support. -------------------------------------------------
    await row(managerPage).click();
    await expect(managerPage.getByRole('heading', { level: 2, name: new RegExp(marker) })).toBeVisible({ timeout: 60_000 });
    const triage = managerPage.getByRole('region', { name: 'Triage' });
    await triage.getByRole('combobox', { name: 'Group' }).click();
    await managerPage.getByRole('listbox').getByRole('option', { name: 'Support', exact: true }).click();
    await triage.getByRole('button', { name: 'Assign' }).click();
    await expect(managerPage.locator('[aria-live="polite"]')).toContainText('Ticket sent to Support');
    await expect(row(managerPage)).toHaveCount(0);

    await openView(agentPage, UNASSIGNED_OPEN);
    await expect(row(agentPage)).toBeVisible({ timeout: 20_000 });

    // --- 4. The agent is notified, takes the ticket and replies publicly. ----------------------
    await agentPage.getByRole('button', { name: /^Notifications, \d+ unread$/ }).click();
    const agentPanel = agentPage.getByRole('dialog', { name: 'Notifications' });
    await expect(agentPanel.getByRole('listitem').filter({ hasText: `New ticket #${ticket.number} in Support` })).toBeVisible();
    await agentPage.keyboard.press('Escape');

    await row(agentPage).click();
    await expect(agentPage.getByRole('heading', { level: 2, name: new RegExp(marker) })).toBeVisible({ timeout: 60_000 });
    await agentPage.getByRole('button', { name: 'Assign to me' }).click();
    await expect(agentPage.getByRole('combobox', { name: 'Owner' })).toHaveValue(AGENT_NAME);

    // --- 5. The customer sees the typing indicator, then the reply with the agent's name. -------
    const agentReply = agentPage.getByRole('combobox', { name: 'Reply' });
    await agentReply.pressSequentially(reply, { delay: 20 });
    await expect(page.getByText(`${AGENT_NAME} is typing`).first()).toBeVisible();
    await agentPage.getByRole('button', { name: 'Send reply' }).click();
    const replyBubble = conversation.getByRole('listitem').filter({ hasText: reply });
    await expect(replyBubble).toBeVisible();
    await expect(replyBubble).toContainText(AGENT_NAME);

    // The customer answers; the agent sees it live.
    await send(answer);
    const ticketConversation = agentPage.getByRole('region', { name: 'Ticket conversation' });
    await expect(ticketConversation.getByText(answer)).toBeVisible();

    // --- 6. An internal note mentioning the admin: they are notified, the customer sees nothing.
    // Posted through the API with the agent session: the seeded Agent role lacks user.view, so the
    // composer's @mention picker (which lists staff through GET /users) has nobody to offer an agent.
    const adminId = ((await (await admin.api.get('/api/v1/me')).json()) as { id: string }).id;
    const noted = await agent.api.post(`/api/v1/tickets/${ticket.id}/messages`, {
      headers: { 'X-CSRF-Token': agent.csrf },
      data: { visibility: 'internal', body: `@Ada Admin ${note}`, clientMessageId: crypto.randomUUID(), mentionIds: [adminId] },
    });
    expect(noted.status()).toBe(201);
    await expect(ticketConversation.getByText(note)).toBeVisible();

    await expect
      .poll(async () => {
        const response = await admin.api.get('/api/v1/notifications?limit=50');
        const { items } = (await response.json()) as { items: { ticketId: string | null; eventType: string }[] };
        return items.some((item) => item.ticketId === ticket.id && item.eventType === 'mention');
      })
      .toBe(true);
    await adminPage.getByRole('button', { name: /^Notifications, \d+ unread$/ }).click();
    await expect(
      adminPage
        .getByRole('dialog', { name: 'Notifications' })
        .getByRole('listitem')
        .filter({ hasText: `${AGENT_NAME} mentioned you` })
        .filter({ hasText: `#${ticket.number}` }),
    ).toBeVisible();
    await adminPage.keyboard.press('Escape');

    await expect(page.getByText('refund policy')).toHaveCount(0);
    await expect(page.getByText(/internal note|mentioned/i)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Notifications/ })).toHaveCount(0);
    // Mail can arrive late: keep checking the customer's mailbox for a short window, not just once.
    const mailDeadline = Date.now() + 6_000;
    do {
      for (const mail of await messagesTo(request, customerEmail)) expect(mail).not.toContain(note);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    } while (Date.now() < mailDeadline);

    // --- 7. The agent resolves; the customer sees the friendly marker. -------------------------
    await agentPage.getByRole('button', { name: 'Resolve', exact: true }).click();
    await expect(agentPage.locator('[aria-live="polite"]')).toContainText('Ticket resolved');
    await expect(conversation.getByText('Glad we could help, just reply if you need anything else')).toBeVisible();

    // --- 8. "thanks" within the grace period reopens the same ticket; one action resolves again.
    const groupId = (await getTicket(agent.api, ticket.id)).group?.id;
    await send(thanks);
    await expect.poll(async () => (await getTicket(agent.api, ticket.id)).state).not.toMatch(/resolved|closed/);
    const reopened = await getTicket(agent.api, ticket.id);
    expect(reopened.group?.id).toBe(groupId);
    expect(reopened.owner?.name).toBe(AGENT_NAME);
    const resolveAgain = agentPage.getByRole('button', { name: 'Resolve', exact: true });
    await expect(resolveAgain).toBeVisible();
    await resolveAgain.click();
    await expect.poll(async () => (await getTicket(agent.api, ticket.id)).state).toBe('resolved');

    // --- 9. Past the grace period: the old ticket closes, a follow-up starts in Needs Triage. --
    cleanup.push(resetClock);
    const settings = await admin.api.get('/api/v1/settings');
    expect(settings.status()).toBe(200);
    const { gracePeriodHours } = (await settings.json()) as { gracePeriodHours: number };
    await advanceClock(gracePeriodHours + 1);
    // The api has the new time once the staff sessions (12 h idle) read as expired.
    await expect.poll(async () => (await agent.api.get('/api/v1/me')).status(), { timeout: 15_000 }).toBe(401);
    const adminContext2 = await browser.newContext();
    cleanup.push(() => adminContext2.close());
    const adminPage2 = await adminContext2.newPage();
    await signInStaffUi(adminPage2, ADMIN_EMAIL, SEED_PASSWORD);
    const admin2 = await deskApiOf(adminPage2);
    cleanup.push(() => admin2.api.dispose());

    // The sweeper (every 30 s) closes it on its own, before the customer writes again.
    await expect.poll(async () => (await getTicket(admin2.api, ticket.id)).state, { timeout: 90_000, intervals: [1_000] }).toBe('closed');

    await send(followUpMessage);
    const followUp = await findTicket(admin2.api, 'groupId=ungrouped', marker);
    expect(followUp.id).not.toBe(ticket.id);
    const followUpDetail = await getTicket(admin2.api, followUp.id);
    expect(followUpDetail.links).toContainEqual(
      expect.objectContaining({ kind: 'follow_up_of', direction: 'outgoing', ticket: expect.objectContaining({ id: ticket.id }) }),
    );
    await openView(adminPage2, NEEDS_TRIAGE);
    await expect(adminPage2.getByRole('option', { name: /Another question about a new order/ }).first()).toBeVisible();

    // The customer still sees one continuous thread, with no ticket numbers.
    for (const text of [firstMessage, reply, answer, thanks, followUpMessage]) {
      await expect(conversation.getByText(text)).toHaveCount(1);
    }
    await expect(page.getByText(/#\d+/)).toHaveCount(0);
    await expect(page.getByText(/ticket/i)).toHaveCount(0);
  } finally {
    // Back to real time first, so a failure never leaves the other specs in the future. A failing
    // reset must not stop the contexts closing; it is rethrown afterwards.
    let resetError: unknown;
    try {
      await resetClock();
    } catch (error) {
      resetError = error;
    }
    for (const step of cleanup.reverse()) await step().catch(() => undefined);
    await Promise.all([managerContext.close(), agentContext.close(), adminContext.close()]);
    expect(resetError, `resetClock failed: ${String(resetError)}`).toBeUndefined();
  }
});
