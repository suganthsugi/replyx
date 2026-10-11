import { expect, test } from './fixtures';

// The concept pages (US4): each answers, has its illustration with a text alternative, shows a
// worked example as a table, links to the related admin and guide pages, and passes axe in both
// themes.
const CONCEPTS = [
  {
    path: '/concepts/how-ai-routing-works/',
    title: 'How AI routing works',
    links: ['/admin/routing-rules/', '/guides/ai-assist/', '/concepts/how-complexity-picks-a-model/'],
  },
  {
    path: '/concepts/how-complexity-picks-a-model/',
    title: 'How complexity picks a model',
    links: ['/guides/ai-assist/', '/concepts/how-ai-routing-works/'],
  },
];

for (const concept of CONCEPTS) {
  test.describe(concept.path, () => {
    test('has its illustration, worked example and links', async ({ page }) => {
      const response = await page.goto(concept.path);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(concept.title);

      const illustration = page.locator('figure svg[role="img"]');
      await expect(illustration).toBeVisible();
      await expect(illustration.locator('title')).not.toBeEmpty();
      await expect(illustration.locator('desc')).not.toBeEmpty();

      const example = page.locator('h2#worked-example ~ * table').first();
      await expect(example).toBeVisible();

      const article = page.locator('article, main').first();
      for (const href of concept.links) {
        await expect(article.locator(`a[href^="${href}"], a[href^="${href.replace(/\/$/, '')}"]`).first()).toBeAttached();
      }
    });

    test('fits a phone without scrolling sideways', async ({ page }) => {
      await page.setViewportSize({ width: 360, height: 740 });
      await page.goto(concept.path);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });

    for (const scheme of ['light', 'dark'] as const) {
      test(`passes axe in the ${scheme} theme`, async ({ page, axe }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(concept.path, { waitUntil: 'networkidle' });
        await axe.check();
      });
    }
  });
}

test('the complexity page has the score anchor the home flow links to', async ({ page }) => {
  await page.goto('/concepts/how-complexity-picks-a-model/#the-score');
  await expect(page.locator('#the-score')).toBeAttached();
});
