import { STAGES } from '../components/flow/scenarios';

import { expect, test } from './fixtures';

import type { Page } from '@playwright/test';

// The home page flow reel (US1): it plays on its own, shows every outcome, pauses when hidden, stays still
// for reduced motion and without JavaScript, fits a phone, links every stage, and passes axe.

const player = (page: Page) => page.locator('[data-flow-player]');
const reel = (page: Page) => page.locator('[data-reel]');
const animationCount = (page: Page) =>
  page.evaluate(() => document.querySelector('figure')?.getAnimations({ subtree: true }).length ?? 0);

/** The static recap (scenario 3): Technical Support at 0.88, score 0.50, Standard. */
async function expectStaticDiagram(page: Page) {
  const frame = reel(page);
  await expect(frame.locator('[data-group][data-chosen="true"]')).toHaveAttribute('data-group', 'Technical Support');
  await expect(frame.locator('[data-level][data-chosen="true"]')).toHaveAttribute('data-level', 'Standard');
  await expect(frame.locator('[data-part="score"]')).toHaveText('0.50');
  await expect(frame.locator('a[data-caption]')).toHaveCount(STAGES.length);
}

test('the flow starts playing on its own within a second', async ({ page }) => {
  await page.goto('/');
  await page.locator('figure').scrollIntoViewIfNeeded();
  await expect.poll(() => animationCount(page), { timeout: 1_000 }).toBeGreaterThan(0);
  await expect(player(page)).toHaveAttribute('data-scenario', 'order-status');
});

test('a loop shows every model level and a Needs Triage fallback', async ({ page }) => {
  await page.goto('/?speed=8');
  await page.locator('figure').scrollIntoViewIfNeeded();
  const seen = { levels: new Set<string>(), triage: false };
  await expect
    .poll(
      async () => {
        const state = await page.evaluate(() => {
          const frame = document.querySelector('[data-reel]');
          return {
            level: frame?.querySelector('[data-level][data-chosen="true"]')?.getAttribute('data-level') ?? null,
            triage: frame?.querySelector('[data-stage="triage"][data-chosen="true"]') !== null,
          };
        });
        if (state.level) seen.levels.add(state.level);
        seen.triage ||= state.triage;
        return [...seen.levels].sort().join(',') + (seen.triage ? '+triage' : '');
      },
      { timeout: 30_000, intervals: [100] },
    )
    .toBe('Advanced,Fast,Standard+triage');
});

test('the flow pauses while the tab is hidden and resumes after', async ({ page }) => {
  // Run faster, so resuming reaches the next step well inside the timeout.
  await page.goto('/?speed=4');
  await page.locator('figure').scrollIntoViewIfNeeded();
  await expect.poll(() => animationCount(page)).toBeGreaterThan(0);

  const setHidden = (hidden: boolean) =>
    page.evaluate((h) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);

  await setHidden(true);
  // Between two steps nothing may be running for a moment; the next step's animation starts paused.
  const playStates = () =>
    page.evaluate(() => document.querySelector('figure')!.getAnimations({ subtree: true }).map((a) => a.playState));
  await expect.poll(async () => (await playStates()).filter((s) => s === 'paused').length).toBeGreaterThan(0);
  // Nothing runs; entrances that had already finished stay finished.
  expect((await playStates()).filter((s) => s === 'running')).toEqual([]);
  const step = await player(page).getAttribute('data-step');
  await page.waitForTimeout(1_500);
  await expect(player(page)).toHaveAttribute('data-step', step!);

  await setHidden(false);
  await expect(player(page)).not.toHaveAttribute('data-step', step!, { timeout: 5_000 });
});

test.describe('with reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('the complete diagram is shown and nothing moves', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1_500);
    expect(await animationCount(page)).toBe(0);
    await expect(player(page)).toHaveAttribute('data-step', 'complete');
    await expectStaticDiagram(page);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`the home page passes axe in the ${scheme} theme`, async ({ page, axe }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/', { waitUntil: 'networkidle' });
      await axe.check();
    });
  }
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('the diagram, its captions and the navigation are there', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectStaticDiagram(page);
    await expect(page.getByRole('link', { name: 'Read the guides' })).toBeVisible();
  });
});

test('the flow fits the screen with the right layout', async ({ page, isMobile }) => {
  await page.goto('/');
  // A landscape frame on wide screens, a portrait one on phones.
  const box = (await reel(page).boundingBox())!;
  expect(box.height > box.width).toBe(Boolean(isMobile));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('every stage caption links to the page that explains it', async ({ page }) => {
  await page.goto('/');
  const captions = reel(page).locator('a[data-caption]');
  for (const stage of STAGES) {
    await expect(captions.and(page.locator(`[data-caption="${stage.id}"]`))).toHaveAttribute('href', stage.href);
  }
  await captions.and(page.locator('[data-caption="rules"]')).click();
  await expect(page).toHaveURL(/\/admin\/routing-rules\/$/);
});

// Section cards below the hero (US5). The axe checks above run on the whole home page, cards included.
test.describe('section cards', () => {
  const cards = (page: Page) => page.locator('[data-section-cards] > li > a');

  test('six cards each link to a page that exists', async ({ page, request }) => {
    await page.goto('/');
    await expect(cards(page)).toHaveCount(6);
    for (const href of await cards(page).evaluateAll((links) => links.map((a) => a.getAttribute('href')!))) {
      expect((await request.get(href)).status(), href).toBe(200);
    }
  });

  test('the cards stack in one column on a phone, with no sideways scroll', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto('/');
    const lefts = await cards(page).evaluateAll((links) => links.map((a) => Math.round(a.getBoundingClientRect().left)));
    expect(new Set(lefts).size).toBe(1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('a card shows a focus ring when tabbed to', async ({ page }) => {
    await page.goto('/');
    const first = cards(page).first();
    await first.focus();
    await expect(first).toBeFocused();
    expect(await first.evaluate((a) => getComputedStyle(a).outlineStyle)).not.toBe('none');
  });
});
