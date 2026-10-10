import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

// Light, dark and system themes (US2): System by default, no flash of the wrong theme, a manual
// choice that persists, and AA contrast in both themes.

/**
 * Watches the document while it is parsed and records whether any page content (an h1) existed
 * before <html> got its theme class. next-themes runs its script at the top of <body>, so the class
 * must be set before the first heading is parsed; otherwise the wrong theme would flash.
 */
async function watchForFlash(page: Page) {
  await page.addInitScript(() => {
    const state = { themedFirst: null as boolean | null, theme: '' };
    (window as unknown as { __flash: typeof state }).__flash = state;
    const check = () => {
      if (state.themedFirst !== null) return;
      const cls = document.documentElement?.classList;
      if (cls?.contains('light') || cls?.contains('dark')) {
        state.themedFirst = document.querySelector('h1') === null;
        state.theme = cls.contains('dark') ? 'dark' : 'light';
      } else if (document.querySelector('h1')) {
        state.themedFirst = false;
      }
    };
    new MutationObserver(check).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  });
}

const flashState = (page: Page) =>
  page.evaluate(() => (window as unknown as { __flash: { themedFirst: boolean | null; theme: string } }).__flash);
const htmlClasses = (page: Page) => page.evaluate(() => [...document.documentElement.classList]);

for (const scheme of ['dark', 'light'] as const) {
  test(`a first visit follows a ${scheme} system preference with no flash`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await watchForFlash(page);
    await page.goto('/guides/triage/');
    expect(await flashState(page)).toEqual({ themedFirst: true, theme: scheme });
    expect(await htmlClasses(page)).toContain(scheme);
  });
}

test('the site follows a system theme change without a reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/guides/triage/', { waitUntil: 'networkidle' });
  expect(await htmlClasses(page)).toContain('light');

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => htmlClasses(page)).toContain('dark');
});

test('a manual Light choice persists while the system stays dark', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The theme switch sits in the closed sidebar drawer on phones.');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/guides/triage/', { waitUntil: 'networkidle' });
  await page.locator('[data-theme-toggle]').getByRole('button', { name: 'Light' }).filter({ visible: true }).first().click();
  await expect.poll(() => htmlClasses(page)).toContain('light');

  await watchForFlash(page);
  await page.reload();
  expect(await flashState(page)).toEqual({ themedFirst: true, theme: 'light' });

  // Back to System follows the dark preference again.
  await page.waitForLoadState('networkidle');
  await page.locator('[data-theme-toggle]').getByRole('button', { name: 'System' }).filter({ visible: true }).first().click();
  await expect.poll(() => htmlClasses(page)).toContain('dark');
});

for (const scheme of ['light', 'dark'] as const) {
  test(`key pages pass axe in the ${scheme} theme`, async ({ page, axe }) => {
    await page.emulateMedia({ colorScheme: scheme });
    for (const path of ['/', '/guides/triage/', '/developers/authorization/']) {
      await page.goto(path, { waitUntil: 'networkidle' });
      await axe.check();
    }
  });
}
