import { request as playwrightRequest } from '@playwright/test';

import { expect, test } from './fixtures';
import { linkPath, uniqueEmail, waitForMessage } from './mailpit';
import { API_ORIGIN, cookieHeaderOf, csrfOf, SEED_PASSWORD, signInStaffUi, TENANT_HOST } from './staff-ui';

import type { APIRequestContext, Page } from '@playwright/test';


/**
 * T157 (spec US6): an agent assigns a ticket to themselves, replies (the customer sees it live),
 * adds an internal note (the customer never does), changes priority, and the ticket's history
 * shows all of it. Also covers a staff-started ticket reaching the customer's one conversation.
 *
 * Two fresh sign-ins only: the customer's magic link and one staff UI sign-in. The staff-started
 * ticket is created through the API using that same authenticated browser session (no separate
 * sign-in), the same way `staff-api.ts` acts for the customer-chat spec but reusing the desk UI's
 * own cookies instead of a second `sign-in` call.
 */

const STAFF_EMAIL = 'admin@acme.test';
const STAFF_NAME = 'Ada Admin';

async function signInCustomer(page: Page, request: APIRequestContext, email: string, name: string) {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByRole('textbox', { name: 'Name' }).fill(name);
  await page.getByRole('button', { name: 'Send sign-in link' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Check your email' })).toBeVisible();
  const mail = await waitForMessage(request, email, 'sign-in link');
  await page.goto(linkPath(mail, '/sign-in/redeem'));
  // Redeeming and staff sign-in share the suite's one per-IP sign-in budget: wait out a limit
  // rather than fail on the suite's own load (see customer-chat.spec.ts).
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

test('an agent works a ticket end to end, and a staff-started ticket reaches the customer', async ({ page, request, browser, axe }) => {
  test.setTimeout(220_000);
  const customerEmail = uniqueEmail('e2e-agent-flow');
  const customerName = 'E2E Agent Flow Customer';
  const question = `My invoice looks wrong (${customerEmail.split('@')[0]})`;
  const reply = 'Thanks, I can see the issue and I am fixing it now.';
  const note = 'Refund the duplicate line item once confirmed.';
  const staffTicketTitle = `Billing follow-up (${customerEmail.split('@')[0]})`;
  const staffTicketBody = `Heads up, we found a billing glitch affecting your account (${customerEmail.split('@')[0]}).`;

  await signInCustomer(page, request, customerEmail, customerName);
  await expect(page.getByRole('heading', { level: 1, name: 'Acme Support' })).toBeVisible();
  await axe.check();

  const conversation = page.getByRole('region', { name: 'Conversation' });
  await page.getByRole('textbox', { name: 'Message' }).fill(question);
  await page.getByRole('textbox', { name: 'Message' }).press('Enter');
  await expect(conversation.getByRole('listitem').filter({ hasText: question })).toContainText(/Sent|Delivered|Read/);

  const staffContext = await browser.newContext();
  const staffPage = await staffContext.newPage();
  try {
    await signInStaffUi(staffPage, STAFF_EMAIL, SEED_PASSWORD);
    await expect(staffPage.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();

    // The new ticket lands in "Needs Triage" (ungrouped), the default landing view, without a reload.
    const ticketOption = staffPage.getByRole('option').filter({ hasText: question });
    await expect(ticketOption).toBeVisible({ timeout: 20_000 });
    await ticketOption.click();
    // The ticket focus pane is a lazy chunk: under a cold Vite dev compile of its imports (e.g. a
    // full e2e run with several workers in parallel), first paint can take well over 20 s even
    // though the API responses themselves are fast.
    await expect(staffPage.getByRole('heading', { level: 2, name: question })).toBeVisible({ timeout: 60_000 });

    // Triages it to Support first (an ungrouped ticket shows the triage bar instead of the owner
    // controls), then assigns it to themselves.
    const triage = staffPage.getByRole('region', { name: 'Triage' });
    await triage.getByRole('combobox', { name: 'Group' }).click();
    await staffPage.getByRole('listbox').getByRole('option', { name: 'Support', exact: true }).click();
    await triage.getByRole('button', { name: 'Assign' }).click();
    await expect(triage).toHaveCount(0);
    await staffPage.getByRole('button', { name: 'Assign to me' }).click();
    await expect(staffPage.getByRole('combobox', { name: 'Owner' })).toHaveValue(STAFF_NAME);

    // Replies, and the customer sees it live.
    await staffPage.getByRole('combobox', { name: 'Reply' }).fill(reply);
    await staffPage.getByRole('button', { name: 'Send reply' }).click();
    const ticketConversation = staffPage.getByRole('region', { name: 'Ticket conversation' });
    await expect(ticketConversation.getByText(reply)).toBeVisible();
    await expect(conversation.getByText(reply)).toBeVisible();

    // Adds an internal note, which the customer never sees.
    await staffPage.getByRole('group', { name: 'Message type' }).getByRole('button', { name: 'Internal note' }).click();
    await staffPage.getByRole('combobox', { name: 'Internal note' }).fill(note);
    await staffPage.getByRole('button', { name: 'Add note' }).click();
    await expect(ticketConversation.getByText(note)).toBeVisible();
    await expect(page.getByText(note)).toHaveCount(0);
    await expect(page.getByText(/internal note/i)).toHaveCount(0);

    // Changes priority.
    await staffPage.getByRole('group', { name: 'Priority' }).getByRole('button', { name: 'High' }).click();
    await expect(staffPage.getByRole('group', { name: 'Priority' }).getByRole('button', { name: 'High' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // History shows all the changes.
    await staffPage.getByRole('tab', { name: 'History' }).click();
    const history = staffPage.getByRole('list', { name: 'Ticket history' });
    await expect(history.getByText(/Owner/)).toBeVisible();
    await expect(history.getByText(/Priority/)).toBeVisible();
    expect(await history.getByRole('listitem').count()).toBeGreaterThanOrEqual(2);

    await axe.check({ page: staffPage });

    // A staff-started ticket appears in the customer's one conversation: created through the API
    // with the desk session's own cookies (no extra sign-in), the way NewTicketDialog itself calls it.
    const csrf = await csrfOf(staffPage);
    const cookie = await cookieHeaderOf(staffPage);
    const deskApi = await playwrightRequest.newContext({ baseURL: API_ORIGIN, extraHTTPHeaders: { Host: TENANT_HOST, Cookie: cookie } });
    try {
      const usersResponse = await deskApi.get(`/api/v1/users?kind=customer&status=active&q=${encodeURIComponent(customerEmail)}`);
      expect(usersResponse.ok()).toBeTruthy();
      const { items: userItems } = (await usersResponse.json()) as { items: { id: string; email: string }[] };
      const customerId = userItems.find((item) => item.email.toLowerCase() === customerEmail.toLowerCase())?.id;
      if (customerId === undefined) throw new Error(`Customer ${customerEmail} not found via /users`);

      const groupsResponse = await deskApi.get('/api/v1/groups?status=active');
      expect(groupsResponse.ok()).toBeTruthy();
      const { items: groupItems } = (await groupsResponse.json()) as { items: { id: string; name: string }[] };
      const supportGroupId = groupItems.find((group) => group.name === 'Support')?.id;
      if (supportGroupId === undefined) throw new Error('Support group not found via /groups');

      const createResponse = await deskApi.post('/api/v1/tickets', {
        headers: { 'X-CSRF-Token': csrf },
        data: { customerId, groupId: supportGroupId, title: staffTicketTitle, message: { body: staffTicketBody } },
      });
      expect(createResponse.ok()).toBeTruthy();
    } finally {
      await deskApi.dispose();
    }

    await expect(conversation.getByText(staffTicketBody)).toBeVisible();
    await expect(page.getByText(/ticket/i)).toHaveCount(0);
  } finally {
    await staffContext.close();
  }
});
