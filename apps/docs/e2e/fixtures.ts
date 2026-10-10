import { test as base, expect, type Page } from '@playwright/test';
import axe, { type AxeResults } from 'axe-core';

/**
 * `axe` checks the current page against WCAG 2.2 AA and fails on serious or critical issues
 * (SC-005). Specs import `test`/`expect` from here instead of `@playwright/test`.
 */
export interface AxeFixture {
  check(options?: { selector?: string; page?: Page }): Promise<void>;
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
        const results = await runAxe(options.page ?? page, options.selector);
        const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
        const summary = blocking.map(
          (v) => `${v.id} [${v.impact}]: ${v.help} (${v.nodes.map((node) => node.target.join(' ')).join(', ')})`,
        );
        if (summary.length > 0) throw new Error(`axe found ${summary.length} serious/critical violation(s):\n  ${summary.join('\n  ')}`);
      },
    });
  },
});

export { expect };
