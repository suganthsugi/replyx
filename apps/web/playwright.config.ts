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
  // The specs run against the Vite dev server with both projects in parallel, and each one
  // follows real email: allow for a loaded machine rather than fail on first-load latency.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://acme.localhost:5173',
    trace: 'retain-on-failure',
  },
  // Sign-ins are limited per IP (10 a minute) and the whole suite shares one. The customer chat
  // spec signs in twice per device (customer link, staff), so it runs after the other specs in
  // its own desktop/mobile projects and waits out whatever is left of the limit.
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: /customer-chat/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testIgnore: /customer-chat/ },
    { name: 'desktop-chat', use: { ...devices['Desktop Chrome'] }, testMatch: /customer-chat/, dependencies: ['desktop', 'mobile'] },
    { name: 'mobile-chat', use: { ...devices['Pixel 7'] }, testMatch: /customer-chat/, dependencies: ['desktop', 'mobile'] },
  ],
});
