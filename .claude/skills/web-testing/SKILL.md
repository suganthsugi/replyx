---
name: web-testing
description: RTL role queries, typed MSW handlers, axe checks, and Playwright projects for apps/web, all run in Docker. Use when writing or running tests under apps/web/test or apps/web/e2e.
---

# web-testing

Scope: `apps/web/test` (Vitest + RTL + MSW) and `apps/web/e2e` (Playwright). Loaded by
frontend-automator. Ties to task T055, `apps/web/vitest.config.ts`, `apps/web/package.json`,
and `research.md` D26 (all test commands run inside containers).

## Rules

1. **Run web tests through Docker Compose, not a bare local `pnpm test`.** The `compose.yaml`
   dev stack owns Node 24, the `api`/`worker` services for MSW-bypassed integration checks, and
   Mailpit; Playwright's `playwright` service runs against the compose `web` service on
   `http://acme.localhost:5173`. Use `docker compose run --rm web pnpm test` and
   `docker compose run --rm playwright pnpm test:e2e` (or the equivalent `docker compose exec`
   during an already-running stack), matching how CI invokes them.
   Wrong: running `pnpm --filter web test:e2e` on the host with no compose network — the
   `acme.localhost` tenant host and the api/mailpit services won't resolve.

2. **Query by role and accessible name, not by test id or CSS class.** This doubles as the axe
   coverage check: if a query needs `getByRole('button', { name: 'Send' })` to pass, the button
   already has an accessible name.
   ```tsx
   // apps/web/test/... (target shape, matches T053 components)
   render(<MessageComposer onSend={onSend} />);
   await userEvent.type(screen.getByRole('textbox', { name: 'Write a message' }), 'Hi');
   await userEvent.click(screen.getByRole('button', { name: 'Send' }));
   ```
   Wrong: `container.querySelector('.composer-input')`.

3. **MSW handlers are typed from the generated client, not hand-typed response objects.** Import
   the response/request types from `src/api/generated/model` so a contract change breaks the test
   at compile time instead of silently passing against a stale shape.
   ```ts
   // apps/web/test/setup.ts (target shape, tasks.md T055)
   import { http, HttpResponse } from 'msw';
   import type { Ticket } from '../src/api/generated/model';

   export const handlers = [
     http.get('/api/tickets/:id', ({ params }) =>
       HttpResponse.json<Ticket>({ id: params.id as string, subject: 'Order missing', /* ... */ })),
   ];
   export const server = setupServer(...handlers);
   ```
   Wrong: `HttpResponse.json({ id: '1', subject: 'x' })` with no `Ticket` type — a renamed or
   removed field in the OpenAPI spec won't be caught.

4. **Every component test that renders a page-level or interactive component calls
   `expectNoAxeViolations()`** (the helper set up in `apps/web/test/setup.ts`, wrapping
   `axe-core`), in addition to the RTL assertions — not as a separate, skippable test.
   ```ts
   const { container } = render(<TicketRow ticket={ticket} />);
   await expectNoAxeViolations(container);
   ```
   Wrong: one axe smoke test for the whole app instead of one per component that ships new markup.

5. **Vitest setup is wired through `vitest.config.ts`'s `test.setupFiles`**, pointing at
   `apps/web/test/setup.ts` (starts the MSW `server`, registers `@testing-library/jest-dom`
   matchers, defines `expectNoAxeViolations`). Don't start MSW per-test-file; `beforeAll`/`afterEach`
   /`afterAll` in `setup.ts` handles `server.listen()`, `server.resetHandlers()`, `server.close()`.

6. **Playwright projects cover desktop and mobile against the customer chat and the workspace**,
   with `baseURL` set from the tenant host (`http://acme.localhost:5173`) so cookies and CSRF
   behave exactly as in production (research D2, D21). An axe fixture runs on the primary flows
   (customer chat, triage, ticket reply — constitution VII, SC-013a). Use Mailpit's HTTP API
   (`http://mailpit:8025/api/v1/...` inside compose) to read sign-in and magic-link emails instead
   of parsing SMTP logs.
   ```ts
   // apps/web/playwright.config.ts (target shape, tasks.md T055)
   export default defineConfig({
     use: { baseURL: 'http://acme.localhost:5173' },
     projects: [
       { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
       { name: 'mobile', use: { ...devices['iPhone 14'] } },
     ],
   });
   ```
   Wrong: hard-coding `localhost:5173` without the tenant subdomain — the API can't resolve a
   tenant and every request 404s.

7. **Cross-tenant and permission scenarios stay in `apps/api`'s cross-tenant suite** (see
   `testing-conventions`); web e2e tests assert UI behavior (what renders, what's reachable by
   keyboard) for a single, already-authorized session — don't duplicate 403/404 matrices here.

## Checklist (before reporting done)
- [ ] Tests were run via the compose `web` / `playwright` service, not the bare host toolchain
- [ ] New RTL queries use role/name, not test ids or CSS selectors
- [ ] New MSW handlers import response types from `src/api/generated/model`
- [ ] New interactive component/page has an `expectNoAxeViolations()` assertion
- [ ] New Playwright specs use the tenant-host `baseURL` and run on both configured projects
