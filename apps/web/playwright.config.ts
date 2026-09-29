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
  // and agent conversation specs each sign in twice per device (customer link, staff), so they run
  // after the other specs in their own desktop/mobile projects and wait out whatever is left of the
  // limit.
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: [/customer-chat/, /agent-conversation/, /realtime/, /triage/, /main-flow/, /tenant-lifecycle/] },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testIgnore: [/customer-chat/, /agent-conversation/, /realtime/, /triage/, /main-flow/, /tenant-lifecycle/] },
    // Tenant lifecycle signs in four times a run (operator, admin twice, customer) and is slow: on its own,
    // after the sign-in specs, so together they stay inside the 10 sign-ins a minute.
    { name: 'desktop-lifecycle', use: { ...devices['Desktop Chrome'] }, testMatch: /tenant-lifecycle/, dependencies: ['desktop', 'mobile'] },
    { name: 'mobile-lifecycle', use: { ...devices['Pixel 7'] }, testMatch: /tenant-lifecycle/, dependencies: ['desktop-lifecycle'] },
    { name: 'desktop-chat',use: { ...devices['Desktop Chrome'] }, testMatch: /customer-chat/, dependencies: ['mobile-lifecycle'] },
    { name: 'mobile-chat', use: { ...devices['Pixel 7'] }, testMatch: /customer-chat/, dependencies: ['mobile-lifecycle'] },
    { name: 'desktop-agent', use: { ...devices['Desktop Chrome'] }, testMatch: /agent-conversation/, dependencies: ['desktop-chat', 'mobile-chat'] },
    { name: 'mobile-agent', use: { ...devices['Pixel 7'] }, testMatch: /agent-conversation/, dependencies: ['desktop-chat', 'mobile-chat'] },
    // Two staff browsers side by side: desktop only (the one-pane phone inbox has no rail beside the list).
    { name: 'desktop-realtime', use: { ...devices['Desktop Chrome'] }, testMatch: /realtime/, dependencies: ['desktop-agent', 'mobile-agent'] },
    // Two more staff browsers (manager, agent): after realtime, so the suite's sign-in budget has recovered.
    { name: 'desktop-triage', use: { ...devices['Desktop Chrome'] }, testMatch: /triage/, dependencies: ['desktop-realtime'] },
    // The whole conversation flow (customer, manager, agent, admin), and it moves the shared dev clock so
    // sessions expire: last, so nothing else runs while time is shifted.
    { name: 'desktop-main-flow', use: { ...devices['Desktop Chrome'] }, testMatch: /main-flow/, dependencies: ['desktop-triage'] },
  ],
});
