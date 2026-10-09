import { expect, test } from './fixtures';
import { linkPath, uniqueEmail, waitForMessage } from './mailpit';
import { deskApiOf, SEED_PASSWORD, signInStaffUi } from './staff-ui';

import type { APIRequestContext, Page } from '@playwright/test';

/**
 * specs/002-ai-assist US3 (T029), with the fake AI provider and fake store (`AI_PROVIDER=fake`,
 * `COMMERCE_PROVIDER=fake` in the dev `.env`): the assistant answers a customer in Auto-reply, the
 * "Now replying" badge follows take over and hand back on both the ticket and the customer chat,
 * and in Drafts mode an agent uses the AI draft and sends it.
 *
 * It switches AI on for the shared `acme` tenant, so it runs alone after every other spec
 * (project `desktop-ai`), and a `finally` turns AI off and removes the key and the store again.
 * Two sign-ins: the admin through the desk UI and the customer's sign-in link.
 */

const ADMIN_EMAIL = 'admin@acme.test';
const ADMIN_NAME = 'Ada Admin';
// The assistant answers about 3 s after the customer's last message, through the worker.
const AI_REPLY = { timeout: 30_000 };

async function signInCustomer(page: Page, request: APIRequestContext, email: string, name: string) {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByRole('textbox', { name: 'Name' }).fill(name);
  await page.getByRole('button', { name: 'Send sign-in link' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Check your email' })).toBeVisible();
  const mail = await waitForMessage(request, email, 'sign-in link');
  await page.goto(linkPath(mail, '/sign-in/redeem'));
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

test('the assistant answers, an agent takes over and hands back, and uses an AI draft', async ({ page, request, browser, axe }) => {
  test.setTimeout(240_000);
  const customerEmail = uniqueEmail('e2e-ai-assist');
  // Letters only: the fake chat looks up any 5+ digit number in the text as an order number.
  const marker = (customerEmail.split('@')[0] ?? '').replace(/\d/g, (digit) => 'abcdefghij'[Number(digit)] ?? 'x');
  const question = `Where is my order? (${marker})`;

  const staffContext = await browser.newContext();
  const staffPage = await staffContext.newPage();
  await signInStaffUi(staffPage, ADMIN_EMAIL, SEED_PASSWORD);
  const { api, csrf } = await deskApiOf(staffPage);
  const send = (method: 'put' | 'patch' | 'delete', path: string, data?: object) => api[method](`/api/v1${path}`, { headers: { 'X-CSRF-Token': csrf }, ...(data === undefined ? {} : { data }) });

  try {
    expect((await send('put', '/ai/settings/provider-key', { apiKey: 'sk-or-v1-e2e-fake-key-E2E1' })).ok()).toBeTruthy();
    expect((await send('patch', '/ai/settings', { replyMode: 'auto' })).ok()).toBeTruthy();

    // The customer asks; the assistant answers in the chat, marked as AI, and the header says so.
    await signInCustomer(page, request, customerEmail, 'E2E AI Customer');
    const conversation = page.getByRole('region', { name: 'Conversation' });
    const header = page.locator('header');
    await page.getByRole('textbox', { name: 'Message' }).fill(question);
    await page.getByRole('textbox', { name: 'Message' }).press('Enter');
    const answer = conversation.getByRole('listitem').filter({ hasText: 'Could you share your order number?' });
    await expect(answer).toBeVisible(AI_REPLY);
    await expect(answer).toContainText('Assistant');
    await expect(answer).toContainText('AI');
    const customerBadge = header.getByTestId('responder-badge');
    await expect(customerBadge).toContainText('Assistant · AI');
    await axe.check({ selector: '[data-testid="responder-badge"]' });

    // The agent opens the ticket: the assistant is replying.
    const ticketOption = staffPage.getByRole('option').filter({ hasText: question });
    await expect(ticketOption).toBeVisible({ timeout: 20_000 });
    await ticketOption.click();
    await expect(staffPage.getByRole('heading', { level: 2, name: question })).toBeVisible({ timeout: 60_000 });
    const staffBadge = staffPage.getByTestId('responder-badge');
    await expect(staffBadge).toContainText('Assistant · AI');
    await axe.check({ page: staffPage, selector: '[data-testid="responder-badge"]' });

    // Take over: both badges switch to the agent.
    await staffPage.getByRole('button', { name: 'Take over' }).click();
    await expect(staffBadge).toContainText(ADMIN_NAME);
    await expect(staffPage.getByRole('button', { name: 'Hand back to AI' })).toBeVisible();
    await expect(customerBadge).toContainText(ADMIN_NAME);

    // Hand back: both badges switch back to the assistant.
    await staffPage.getByRole('button', { name: 'Hand back to AI' }).click();
    await expect(staffBadge).toContainText('Assistant · AI');
    await expect(customerBadge).toContainText('Assistant · AI');

    // Drafts mode: the next customer message becomes a draft only the agent sees.
    expect((await send('patch', '/ai/settings', { replyMode: 'drafts' })).ok()).toBeTruthy();
    await page.getByRole('textbox', { name: 'Message' }).fill('Hello again, anyone there?');
    await page.getByRole('textbox', { name: 'Message' }).press('Enter');
    const draftBar = staffPage.getByRole('region', { name: 'AI draft' });
    await expect(draftBar).toBeVisible(AI_REPLY);
    const draftText = 'Thanks for getting in touch. How can I help with your order today?';
    await expect(draftBar).toContainText(draftText);
    await expect(conversation.getByText(draftText)).toHaveCount(0);

    await draftBar.getByRole('button', { name: 'Use' }).click();
    await expect(staffPage.getByRole('combobox', { name: 'Reply' })).toHaveValue(draftText);
    await staffPage.getByRole('button', { name: 'Send reply' }).click();
    await expect(conversation.getByRole('listitem').filter({ hasText: draftText })).toContainText(ADMIN_NAME);
    await expect(draftBar).toHaveCount(0);
    await expect(page.getByText(/ticket/i)).toHaveCount(0);
  } finally {
    await send('patch', '/ai/settings', { replyMode: 'off' });
    await send('delete', '/ai/settings/provider-key');
    await api.dispose();
    await staffContext.close();
  }
});
