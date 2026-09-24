import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests (web-testing rule 6). Run inside compose:
 * `docker compose --profile e2e run --rm playwright` (shares the `web` container's network, so the
 * tenant host `acme.localhost:5173` is the Vite dev server and cookies/CSRF behave as in
 * production). Seed first: `docker compose run --rm tools pnpm --filter api seed:dev`.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: process.env.CI !== undefined,
  retries: process.env.CI === undefined ? 0 : 2,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://acme.localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
