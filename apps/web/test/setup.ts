import * as jestDomMatchers from '@testing-library/jest-dom/matchers';
import { cleanup } from '@testing-library/react';
import axe from 'axe-core';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, expect, vi } from 'vitest';

import { handlers } from './msw/handlers';

/**
 * Vitest setup for apps/web (web-testing rule 5): jest-dom matchers, one MSW server for every
 * test file, and `expectNoAxeViolations()` for component tests.
 */

// Registered here rather than via '@testing-library/jest-dom/vitest': that entry extends the
// `vitest` it resolves from its own install location, which under pnpm is not this app's
// instance, and it breaks built-in matchers such as `rejects.toThrow`.
expect.extend(jestDomMatchers);

// Areas open a socket once someone is signed in; component tests never talk to a real server, so
// socket.io-client gets an inert socket (the realtime client itself is tested with a fake).
vi.mock('socket.io-client', () => ({
  io: () => ({
    connected: false,
    on: () => undefined,
    emit: () => undefined,
    timeout: () => ({ emitWithAck: () => Promise.resolve({ ok: true }) }),
    connect: () => undefined,
    disconnect: () => undefined,
  }),
}));

export const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  cleanup();
});
afterAll(() => server.close());

/**
 * Runs axe-core on rendered markup and fails with a readable list of violations (WCAG 2.2 AA
 * rules). Color contrast is checked by the theme tests and Playwright: jsdom has no layout.
 */
export async function expectNoAxeViolations(container: Element = document.body): Promise<void> {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  const summary = results.violations.map(
    (violation) => `${violation.id}: ${violation.help} (${violation.nodes.map((node) => node.target.join(' ')).join(', ')})`,
  );
  if (summary.length > 0) {
    // A plain error keeps every violation readable (assertion diffs truncate long arrays).
    throw new Error(`axe found ${summary.length} violation(s):\n  ${summary.join('\n  ')}`);
  }
}
