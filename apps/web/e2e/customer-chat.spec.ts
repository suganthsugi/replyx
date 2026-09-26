import { expect, test } from './fixtures';
import { linkPath, uniqueEmail, waitForMessage } from './mailpit';
import { signInStaff, staffReply, staffTyping } from './staff-api';

import type { APIRequestContext, Page } from '@playwright/test';

/**
 * The customer chat end to end (T131, spec US1) against the seeded dev stack: a new customer
 * signs in with an emailed link and sends a message, support (the seeded admin, who can see
 * Ungrouped tickets) types and replies through the API, and the reply appears live with the
 * typing indicator first. A second tab of the same customer stays in sync throughout.
 */

const SEED_PASSWORD = 'password-123456';

async function signInCustomer(page: Page, request: APIRequestContext, email: string) {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByRole('textbox', { name: 'Name' }).fill('E2E Chat Customer');
  await page.getByRole('button', { name: 'Send sign-in link' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Check your email' })).toBeVisible();
  const mail = await waitForMessage(request, email, 'sign-in link');
  await page.goto(linkPath(mail, '/sign-in/redeem'));
  // Redeeming counts against the per-IP sign-in limit the whole suite shares: when the page says
  // to wait, wait that long and confirm again.
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

test('a customer chats with support live, in sync across tabs', async ({ page, request, axe }) => {
  // Allows for waiting out the shared sign-in limit twice (customer link, staff sign-in).
  test.setTimeout(180_000);
  const email = uniqueEmail('e2e-chat');
  const question = `Where is my order? (${email.split('@')[0]})`;
  const answer = 'It left our warehouse this morning.';

  await signInCustomer(page, request, email);
  await expect(page.getByRole('heading', { level: 1, name: 'Acme Support' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Hi there, how can we help?' })).toBeVisible();
  await axe.check();

  const second = await page.context().newPage();
  await second.goto('/');
  await expect(second.getByRole('heading', { level: 1, name: 'Acme Support' })).toBeVisible();

  const staff = await signInStaff('admin@acme.test', SEED_PASSWORD);
  try {
    const ticketCreated = staff.nextTicket(question);

    await page.getByRole('textbox', { name: 'Message' }).fill(question);
    await page.getByRole('textbox', { name: 'Message' }).press('Enter');

    const conversation = page.getByRole('region', { name: 'Conversation' });
    const secondConversation = second.getByRole('region', { name: 'Conversation' });
    await expect(conversation.getByRole('listitem').filter({ hasText: question })).toContainText(/Sent|Delivered|Read/);
    // The other tab gets the customer's own message as an echo.
    await expect(secondConversation.getByText(question)).toBeVisible();

    // Nothing about the ticket reaches the customer.
    await expect(page.getByText(/ticket/i)).toHaveCount(0);

    const ticketId = await ticketCreated;
    await staffTyping(staff, ticketId, 'start');
    await expect(conversation.getByText('Ada Admin is typing')).toBeVisible();

    await staffReply(staff, ticketId, answer);
    await expect(conversation.getByText(answer)).toBeVisible();
    await expect(conversation.getByText('Ada Admin is typing')).toBeHidden();
    await expect(secondConversation.getByText(answer)).toBeVisible();
    await expect(conversation.getByRole('listitem').filter({ hasText: answer })).toContainText('Ada Admin');

    await axe.check();
  } finally {
    await staff.close();
  }
});
