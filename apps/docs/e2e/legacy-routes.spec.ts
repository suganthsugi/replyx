import { expect, test } from './fixtures';

// Every URL the Starlight site served (contracts/routes.md) still answers in the new site, with the
// same page title (US3, FR-002, FR-003). `/` was the old docs index; it is now the home page.
const LEGACY_PAGES: Record<string, string> = {
  '/guides/ai-assist/': 'AI Assist',
  '/guides/custom-views/': 'Build and share custom views',
  '/guides/customer-chat/': 'Chatting with support',
  '/guides/macros-merge-split/': 'Macros, merging, splitting and bulk changes',
  '/guides/search/': 'Search tickets and customers',
  '/guides/signing-in/': 'Signing in',
  '/guides/triage/': 'Triaging ungrouped tickets',
  '/guides/views-and-notifications/': 'Views and notifications',
  '/guides/working-tickets/': 'Working tickets',
  '/admin/audit-and-retention/': 'Audit log and data retention',
  '/admin/organization-settings/': 'Organization settings',
  '/admin/roles-and-groups/': 'Roles and groups',
  '/admin/routing-rules/': 'Routing rules',
  '/admin/sla-and-business-hours/': 'SLA and business hours',
  '/admin/support-access/': 'Support access',
  '/admin/users/': 'Users',
  '/operators/tenants/': 'Tenants',
  '/developers/authorization/': 'Authorization',
  '/developers/conversation-routing/': 'Conversation routing',
  '/developers/deployment/': 'Deployment',
};

test.describe('legacy URLs', () => {
  test('the old docs index still answers', async ({ request }) => {
    expect((await request.get('/')).status()).toBe(200);
  });

  for (const [path, title] of Object.entries(LEGACY_PAGES)) {
    test(`${path} keeps its page`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
    });
  }
});

test('the sidebar has every group', async ({ page, isMobile }) => {
  await page.goto('/guides/triage/');
  if (isMobile) await page.getByRole('button', { name: /sidebar|menu/i }).first().click();
  const nav = page.locator('#nd-sidebar, [data-sidebar], aside').filter({ hasText: 'Guides' }).first();
  for (const group of ['Guides', 'Admin', 'Operators', 'Developers']) {
    await expect(nav.getByText(group, { exact: true }).first()).toBeVisible();
  }
});

// Search runs in the browser over the static index (research R10): open it, type, pick the result
// for the expected page and land on it.
const SEARCHES: [query: string, title: string, path: string][] = [
  ['triage', 'Triaging ungrouped tickets', '/guides/triage'],
  ['SLA', 'SLA and business hours', '/admin/sla-and-business-hours'],
  ['complexity', 'AI Assist', '/guides/ai-assist'],
];

for (const [query, title, path] of SEARCHES) {
  test(`search for "${query}" finds ${path}/`, async ({ page }) => {
    // Wait for hydration: the static HTML renders the search button before it is interactive.
    await page.goto('/guides/signing-in/', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /search/i }).filter({ visible: true }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Search' });
    await dialog.getByRole('combobox', { name: 'Search' }).fill(query);
    await dialog.getByRole('option', { name: new RegExp(title) }).first().click();
    await expect(page).toHaveURL(new RegExp(`${path}/?(#.*)?$`));
  });
}
