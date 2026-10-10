import { defineConfig, devices } from '@playwright/test';

/**
 * Docs end-to-end tests run against the static export, served the way production serves it (plain
 * files). Build first, then run inside compose:
 *   docker compose run --rm tools pnpm --filter docs build
 *   docker compose --profile e2e run --rm playwright pnpm --filter docs test:e2e
 */
const PORT = 4322;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // The Docker VM is shared with the rest of the dev stack; one browser per CPU runs it out of memory.
  workers: process.env.CI === undefined ? 4 : 2,
  forbidOnly: process.env.CI !== undefined,
  retries: process.env.CI === undefined ? 0 : 2,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.DOCS_E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: process.env.DOCS_E2E_BASE_URL
    ? undefined
    : {
        command: `pnpm exec serve out -l ${PORT} --no-port-switching`,
        url: `http://127.0.0.1:${PORT}/`,
        reuseExistingServer: process.env.CI === undefined,
      },
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-360', use: { ...devices['Desktop Chrome'], viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true } },
  ],
});
