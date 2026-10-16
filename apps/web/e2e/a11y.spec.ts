import { expect, test } from './fixtures';
import { SEED_PASSWORD } from './staff-ui';

import type { Page } from '@playwright/test';

/**
 * Accessibility pass (T265, SC-013a): axe (WCAG 2.2 AA, contrast included) on every page, under
 * both the light and the dark color-scheme preference, and a keyboard-only staff path.
 *
 * The app has one visual theme today (light); running each page under `prefers-color-scheme: dark`
 * as well makes sure nothing reacts to the OS setting in a way that breaks contrast. One staff
 * sign-in for the whole run (the suite shares 10 sign-ins a minute), done with the keyboard only.
 */

const SCHEMES = ['light', 'dark'] as const;

const SIGNED_OUT_PAGES: readonly { path: string; heading: RegExp }[] = [
  { path: '/', heading: /./ },
  { path: '/desk/sign-in', heading: /sign in/i },
  { path: '/desk/forgot-password', heading: /password/i },
];

const STAFF_PAGES: readonly { path: string; heading: RegExp }[] = [
  { path: '/desk/inbox', heading: /^Inbox$/ },
  { path: '/desk/dashboard', heading: /dashboard/i },
  { path: '/desk/search?q=order', heading: /search/i },
  { path: '/desk/notifications', heading: /notifications/i },
  { path: '/desk/me', heading: /profile/i },
  { path: '/desk/me/notifications', heading: /notification/i },
  { path: '/desk/admin/users', heading: /^Users$/ },
  { path: '/desk/admin/roles', heading: /^Roles$/ },
  { path: '/desk/admin/groups', heading: /^Groups$/ },
  { path: '/desk/admin/routing', heading: /routing rules/i },
  { path: '/desk/admin/automation', heading: /automation rules/i },
  { path: '/desk/admin/webhooks', heading: /^Webhooks$/ },
  { path: '/desk/admin/macros', heading: /macros/i },
  { path: '/desk/admin/sla-policies', heading: /SLA/i },
  { path: '/desk/admin/business-hours', heading: /business hours/i },
  { path: '/desk/admin/notifications', heading: /notification/i },
  { path: '/desk/admin/support-access', heading: /support access/i },
  { path: '/desk/admin/settings', heading: /organization/i },
  { path: '/desk/admin/audit', heading: /audit/i },
  { path: '/desk/admin/ai', heading: /AI/ },
  { path: '/desk/admin/ai/policies', heading: /polic/i },
  { path: '/desk/admin/ai/complexity', heading: /complex/i },
  { path: '/desk/admin/ai/usage', heading: /usage/i },
];

async function checkPage(page: Page, axe: { check(): Promise<void> }, path: string, heading: RegExp) {
  for (const colorScheme of SCHEMES) {
    await page.emulateMedia({ colorScheme });
    await page.goto(path);
    // The first visit to a lazy route waits for Vite to compile it.
    await expect(page.getByRole('heading', { level: 1, name: heading }).first()).toBeVisible({ timeout: 30_000 });
    // Let skeletons settle into their loaded or empty state before checking.
    await expect(page.getByText(/^Loading /)).toHaveCount(0);
    await test.step(`${path} (${colorScheme})`, () => axe.check());
  }
}

/** Tabs until the focused element matches, failing after `limit` presses. */
async function tabTo(page: Page, matches: (name: string, role: string) => boolean, limit = 60): Promise<void> {
  for (let presses = 0; presses < limit; presses += 1) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return { name: (el?.getAttribute('aria-label') ?? el?.textContent ?? '').trim(), role: el?.getAttribute('role') ?? el?.tagName.toLowerCase() ?? '' };
    });
    if (matches(focused.name, focused.role)) return;
  }
  throw new Error('The control was not reachable with Tab');
}

test('signed-out pages have no WCAG 2.2 AA violations in either color scheme', async ({ page, axe }) => {
  for (const { path, heading } of SIGNED_OUT_PAGES) await checkPage(page, axe, path, heading);
});

test('every staff page has no violations, and the staff path works with the keyboard only', async ({ page, axe }) => {
  test.setTimeout(300_000);

  // Sign in with the keyboard only.
  await page.goto('/desk/sign-in');
  await page.getByRole('textbox', { name: 'Email' }).focus();
  await page.keyboard.type('admin@acme.test');
  await page.keyboard.press('Tab');
  await page.keyboard.type(SEED_PASSWORD);
  const deadline = Date.now() + 70_000;
  for (;;) {
    await page.keyboard.press('Enter');
    const inbox = page.getByRole('heading', { level: 1, name: 'Inbox' });
    const wait = page.getByRole('alert').filter({ hasText: /Too many attempts/ });
    await expect(inbox.or(wait)).toBeVisible();
    if (await inbox.isVisible()) break;
    if (Date.now() > deadline) throw new Error('Still rate limited after 70 s');
    await page.waitForTimeout(Number(/(\d+) seconds?/.exec((await wait.textContent()) ?? '')?.[1] ?? 5) * 1000 + 250);
    await page.getByLabel('Password').focus();
  }

  for (const { path, heading } of STAFF_PAGES) await checkPage(page, axe, path, heading);

  // Keyboard only: reach a page action, open its dialog, close it with Escape, focus comes back.
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/desk/admin/webhooks');
  await expect(page.getByRole('heading', { level: 1, name: 'Webhooks' })).toBeVisible();
  await expect(page.getByText(/^Loading /)).toHaveCount(0);
  await tabTo(page, (name) => name === 'Add endpoint');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Add endpoint' });
  await expect(dialog).toBeVisible();
  // Focus moves into the dialog (the focus trap), so Tab reaches its fields next.
  await expect.poll(() => dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  const urlField = dialog.getByRole('textbox', { name: /Endpoint URL/ });
  for (let presses = 0; presses < 5 && !(await urlField.evaluate((el) => el === document.activeElement)); presses += 1) await page.keyboard.press('Tab');
  await expect(urlField).toBeFocused();
  await axe.check();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Add endpoint' }).first()).toBeFocused();

  // Keyboard only through the admin rail: Tab to a section link and follow it.
  await tabTo(page, (name, role) => name === 'Groups' && (role === 'a' || role === 'link'), 120);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Groups' })).toBeVisible();
});
