import { expect, test } from './fixtures';

// Structural smoke test for the harness. Accessibility gates live in the route and theme specs, after
// the ReplyX palette replaces Fumadocs' default neutral one (T011).
test('the home page and a docs page load from the static export', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  await page.goto('/guides/triage/');
  await expect(page.getByRole('heading', { level: 1, name: 'Triaging ungrouped tickets' })).toBeVisible();
});
