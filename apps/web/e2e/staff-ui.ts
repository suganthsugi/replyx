import { request as playwrightRequest } from '@playwright/test';

import { expect } from './fixtures';

import type { APIRequestContext, Page } from '@playwright/test';

/**
 * Staff signed in through the desk UI, and API calls made on behalf of that same browser session
 * (no second sign-in: the suite shares one per-IP sign-in budget of 10 a minute).
 *
 * Node can't resolve `acme.localhost` (see staff-api.ts), so API calls from the test's Node side go
 * to the API service directly by compose name and name the tenant in the Host header, exactly as
 * the Vite proxy forwards it.
 */

export const API_ORIGIN = process.env.E2E_API_URL ?? 'http://api:3000';
export const TENANT_HOST = process.env.E2E_TENANT_HOST ?? 'acme.localhost:5173';
export const SEED_PASSWORD = 'password-123456';

export async function signInStaffUi(page: Page, email: string, password: string) {
  await page.goto('/desk/sign-in');
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByLabel('Password').fill(password);
  const deadline = Date.now() + 70_000;
  for (;;) {
    await page.getByRole('button', { name: 'Sign in' }).click();
    const inbox = page.getByRole('heading', { level: 1, name: 'Inbox' });
    const wait = page.getByRole('alert').filter({ hasText: /Too many attempts/ });
    await expect(inbox.or(wait)).toBeVisible();
    if (await inbox.isVisible()) return;
    const seconds = Number(/(\d+) seconds?/.exec((await wait.textContent()) ?? '')?.[1] ?? 5);
    if (Date.now() > deadline) throw new Error('Still rate limited after 70 s');
    await page.waitForTimeout(seconds * 1000 + 250);
  }
}

/** The double-submit CSRF cookie the desk UI's own session set, for API calls made on its behalf. */
export async function csrfOf(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((cookie) => cookie.name === 'rx_csrf')?.value;
  if (csrf === undefined) throw new Error('No rx_csrf cookie on the staff session');
  return csrf;
}

/** The desk UI's own session cookies, as a `Cookie` header, for API calls made on its behalf. */
export async function cookieHeaderOf(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

/** An API context acting as the staff member signed in on `page`. */
export async function deskApiOf(page: Page): Promise<{ api: APIRequestContext; csrf: string }> {
  const cookie = await cookieHeaderOf(page);
  const api = await playwrightRequest.newContext({ baseURL: API_ORIGIN, extraHTTPHeaders: { Host: TENANT_HOST, Cookie: cookie } });
  return { api, csrf: await csrfOf(page) };
}
