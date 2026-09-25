---
name: web-testing
description: apps/web tests - renderWithProviders, role queries, typed MSW, axe checks, live-region asserts, Playwright projects and axe fixture, in Docker. Use when writing or running tests under apps/web/test or apps/web/e2e.
---

# web-testing

Scope: `apps/web/test` (Vitest + jsdom + RTL + MSW) and `apps/web/e2e` (Playwright). Loaded by
frontend-automator. Harness: `test/setup.ts`, `test/render.tsx`, `test/msw/handlers.ts`,
`e2e/fixtures.ts`, `playwright.config.ts`. Reference tests: `test/components/*.test.tsx`,
`test/routes/areas.test.tsx`, `test/data/socket.test.ts`.

## Rules

1. **Run in Docker.** Unit/component: `docker compose run --rm -T tools pnpm --filter web test`
   (or the turbo line from testing-conventions). E2E: seed first
   (`docker compose run --rm tools pnpm --filter api seed:dev`), then
   `docker compose run --rm playwright pnpm --filter web test:e2e` (shares the `web` network, so
   `acme.localhost:5173` and `mailpit` resolve).
   Wrong: `pnpm --filter web test:e2e` on the host

2. **Render with `renderWithProviders(ui)`** (`test/render.tsx`): theme + `CssBaseline` +
   `LiveRegionProvider` + `ToastProvider`, like every area. Anything using `useAnnounce`/`useToast`
   needs it. Route tests render `AreaRoutes hostname=…` inside `MemoryRouter` (see
   `areas.test.tsx`); pass `{ timeout: 10_000 }` to `findBy*` for lazy areas (cold transforms).
   Hooks using TanStack Query need a `QueryClientProvider` with `createQueryClient()`.
   Wrong: bare `render(<Toast…/>)` (throws outside `LiveRegionProvider`)

3. **Query by role and accessible name**; interact with `userEvent`; assert names/descriptions.
   ```tsx
   // from apps/web/test/components/shell.test.tsx
   await userEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
   const field = await screen.findByRole('textbox', { name: 'Email' });
   await waitFor(() => expect(field).toHaveAccessibleDescription('Enter a valid email address'));
   expect(field).toHaveAttribute('aria-invalid', 'true');
   ```
   Wrong: `container.querySelector('.composer-input')`, `getByTestId`

4. **Live announcements**: the regions have no role (plain `aria-live`), so assert them by
   attribute, not `getByRole('status')`:
   ```tsx
   // from apps/web/test/components/shell.test.tsx
   expect(container.ownerDocument.querySelector('[aria-live="polite"]')).toHaveTextContent('Saved');
   expect(container.ownerDocument.querySelector('[aria-live="assertive"]')).toHaveTextContent('Could not save');
   ```
   (`getByRole('status')` is for `Skeleton`'s loading status only.)

5. **MSW**: one server in `setup.ts` (`onUnhandledRequest: 'error'`, reset after each test). Default
   handlers in `test/msw/handlers.ts` answer any `/api/v1/*` with a 404 `NOT_FOUND` envelope; stories
   add their endpoint defaults there, tests override with `server.use(...)` (`import { server }
   from '../setup'`). Bodies are typed with generated models; errors use `errorResponse(status,
   code, message?)`.
   ```ts
   // target shape (test/msw/handlers.ts, with a generated model)
   http.get(`${API}/groups/:id`, ({ params }) =>
     HttpResponse.json<Group>({ id: params.id as string, name: 'Support', /* ... */ })),
   ```
   Wrong: `HttpResponse.json({ id: '1' })` untyped; paths without `/api/v1`; `server.listen()` per file

6. **API errors in component tests**: reject with the real `HttpError` from `src/data/http.ts`
   (e.g. `new HttpError(400, { code: 'VALIDATION_FAILED', message, details: [{ path, issue }] })`)
   so `mapError` runs as in production. Use issue codes the API emits (api-conventions rule 4).

7. **Accessibility**: every test of a component/page that ships markup calls
   `await expectNoAxeViolations(container)` (from `test/setup.ts`; WCAG 2.2 AA tags;
   `color-contrast` and `region` disabled in jsdom). Contrast is covered by `test/theme/theme.test.ts`
   and Playwright.
   Wrong: one app-wide axe smoke test instead of per-component checks

8. **Socket code** is tested with a fake passed as `createSocket` to `RealtimeClient`
   (`test/data/socket.test.ts`): emit `event`/`closing`, answer `emitWithAck` for `subscribe`/`sync`.
   Never open a real socket in unit tests.

9. **Playwright** (`playwright.config.ts`): `baseURL` = `E2E_BASE_URL` or
   `http://acme.localhost:5173` (tenant host, so cookies/CSRF are real); projects `desktop`
   (Desktop Chrome) and `mobile` (Pixel 7); console specs use `http://console.localhost:5173`.
   Specs import `test`/`expect` from `e2e/fixtures.ts` and call `await axe.check()` (or
   `{ selector }`) on each primary screen (customer chat, triage, ticket reply). Read sign-in and
   magic-link mail through Mailpit's HTTP API (`http://mailpit:8025/api/v1/...`) in a shared helper
   in `e2e/` (target: not written yet).
   Wrong: `baseURL: 'http://localhost:5173'` (no tenant); importing from `@playwright/test` in specs

10. **Cross-tenant and 403/404 matrices stay in apps/api** (testing-conventions). Web tests assert
    what renders and what is reachable by keyboard for one authorized session.

## Checklist (before reporting done)
- [ ] Tests ran via the compose `tools` / `playwright` services and passed
- [ ] Components rendered with `renderWithProviders`; queries by role/name
- [ ] Live-region assertions use `[aria-live=...]`; axe check on new markup
- [ ] MSW handlers typed with generated models; errors as `HttpError`/`errorResponse`
- [ ] E2E specs use `e2e/fixtures.ts`, the tenant `baseURL`, both projects, and `axe.check()`
