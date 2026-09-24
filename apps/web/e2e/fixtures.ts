import { test as base, expect, type Page } from '@playwright/test';
import axe, { type AxeResults } from 'axe-core';

/**
 * Shared Playwright fixtures: `axe` checks the current page against WCAG 2.2 AA (including color
 * contrast, which jsdom can't check) and fails with the violating selectors (constitution VII,
 * SC-013a). Specs import `test`/`expect` from here instead of `@playwright/test`.
 */

export interface AxeFixture {
  /** Fails the test when the page (or `selector`) has WCAG 2.2 AA violations. */
  check(options?: { selector?: string }): Promise<void>;
}

async function runAxe(page: Page, selector?: string): Promise<AxeResults> {
  await page.addScriptTag({ content: axe.source });
  return page.evaluate(
    async ({ context }) =>
      (window as unknown as { axe: { run(context: unknown, options: unknown): Promise<AxeResults> } }).axe.run(context ?? document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      }),
    { context: selector ?? null },
  );
}

export const test = base.extend<{ axe: AxeFixture }>({
  axe: async ({ page }, use) => {
    await use({
      async check(options = {}) {
        const results = await runAxe(page, options.selector);
        const summary = results.violations.map(
          (violation) => `${violation.id}: ${violation.help} (${violation.nodes.map((node) => node.target.join(' ')).join(', ')})`,
        );
        if (summary.length > 0) throw new Error(`axe found ${summary.length} violation(s):\n  ${summary.join('\n  ')}`);
      },
    });
  },
});

export { expect };
