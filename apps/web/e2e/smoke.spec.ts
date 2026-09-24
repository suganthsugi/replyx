import { expect, test } from './fixtures';

/** Harness smoke test: the tenant host serves the app and the API resolves the tenant. */
test('the tenant host serves the app and reaches the API', async ({ page, axe }) => {
  await page.goto('/');
  await expect(page.locator('#root')).not.toBeEmpty();
  await axe.check();

  // From the page, like the app: Chromium resolves *.localhost, Node's DNS (page.request) does not.
  const response = await page.evaluate(async () => {
    const res = await fetch('/api/v1/does-not-exist', { credentials: 'include' });
    return { status: res.status, body: (await res.json()) as unknown };
  });
  // NOT_FOUND (route) rather than TENANT_NOT_FOUND: the Host header reached Nest intact.
  expect(response).toEqual({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
});
