import { defineConfig, mergeConfig } from 'vitest/config';

import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      globals: true,
      // RTL matchers, MSW server and expectNoAxeViolations().
      setupFiles: ['./test/setup.ts'],
      css: true,
      include: ['test/**/*.{test,spec}.{ts,tsx}', 'src/**/*.{test,spec}.{ts,tsx}'],
      exclude: ['e2e/**', 'node_modules/**'],
      // `userEvent` types character by character, and `turbo run test` runs this suite beside the
      // api's Testcontainers suite: 5 s is not enough for a page test on a loaded machine.
      testTimeout: 20_000,
      passWithNoTests: true,
    },
  }),
);
