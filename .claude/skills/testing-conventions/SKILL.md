---
name: testing-conventions
description: API test harness (Testcontainers, getTestApp, TestClock), factories, asUser, sockets, success/403/cross-tenant-404 triad, FIXTURES, RLS and coverage. Use when writing or reviewing apps/api tests.
---

# testing-conventions

Rules for `apps/api/test/**`. Loaded by test-automator and reviewer. Harness:
`apps/api/test/support/` (`global-setup.ts`, `env.ts`, `app.ts`, `factories.ts`, `http.ts`,
`socket.ts`); config `apps/api/vitest.config.ts`. Reference tests:
`test/integration/http/kernel.test.ts`, `test/integration/rls.test.ts`, `test/cross-tenant/`.

## Layout
- `test/unit/<area>/`, `test/integration/<module>/`, `test/cross-tenant/`, `test/support/`.
- Only `test/**/*.test.ts` is collected; never put tests in `src/`.
- Files run **sequentially** (`fileParallelism: false`): relay leadership and the global `seq` are
  database-wide. Don't turn it back on. `NODE_ENV=test` is pinned in the config.

## Rules

1. **Run tests only in Docker via the `tools` service** (Testcontainers needs its Docker socket).
   ```bash
   docker compose run --rm -T tools pnpm --filter api test
   docker compose run --rm -T tools pnpm --filter api test:cross-tenant
   docker compose run --rm -T tools bash -c 'set -o pipefail; pnpm turbo run lint typecheck test --continue'
   ```
   Every run starts throwaway `postgres:17` + `valkey:8` (~20 s, `global-setup.ts`: init.sql via
   initdb with `REPLYX_*_PASSWORD`, migrations as owner). `env.ts` overrides the dev `.env` URLs
   (`BASE_DOMAIN=localhost`, `CONSOLE_HOST=console.localhost`) and closes apps after each file.
   Wrong: `pnpm test` on the host; pointing tests at the dev `postgres`/`valkey` services

2. **Use the real app.** `await getTestApp({ imports? })` (`support/app.ts`) builds
   `AppModule.forRoot({ role: 'api' })` with `configureApiApp`, as `replyx_app`, on an ephemeral
   port; the **first call per file wins**, so pass extra modules (probe controllers) in
   `beforeAll`. `getTestWorker()` starts the worker role (relay, consumers) for tests that need
   events delivered. `service(Token)` resolves providers. Both replace `Clock` with `TestClock`.
   Wrong: `Test.createTestingModule` with hand-picked providers for an endpoint test

3. **Time via `Clock` only** (`src/platform-kernel/clock.ts`). Tests move time with
   `(await getTestApp()).clock.advance(ms)` / `.advanceHours(h)` / `.set(date)`. Wait for async
   effects with `vi.waitFor` or `waitForEvent` (timeout), never sleeps.
   Wrong: `Date.now()` in `src/` business logic; `vi.useFakeTimers()` around DB code; `sleep(31_000)`

4. **Factories take an explicit tenant** (`support/factories.ts`): `createTenant({ slug?, timezone? })`
   provisions through `TenantProvisioningService` (system roles, registry grants; host
   `{slug}.localhost`); `createUser(tenant, { roles, kind?, status?, password?, session? })` returns a
   `TestUser` with `sessionToken`/`csrfToken` (customer when roles are `['customer']`);
   `createGroup(tenant, { access: [{ role, flags }] })` (Admin always gets full access);
   `createRole(tenant, { permissions, groups })`; `setGroupAccess(tenant, role, group|null, flags)`.
   Role refs: `'admin'|'manager'|'agent'|'customer'` or `{ id }`. Each test creates its own tenants.
   Wrong: reusing the dev seed's `acme`/`globex`; inserting users with raw SQL

5. **HTTP through `asUser(user, { host?, csrf? })` / `asGuest(tenantOrHost)`** (`support/http.ts`):
   sends `Host`, `rx_session` + `rx_csrf` cookies and `X-CSRF-Token` on non-GET. Paths are relative
   to `/api/v1` (`'/groups'`). `{ csrf: false }` tests CSRF; `{ host: other.host }` tests cross-host.
   ```ts
   // from apps/api/test/integration/http/kernel.test.ts
   const missing = await asUser(admin, { csrf: false }).post('/probe/items', { name: 'abc' });
   expect(missing.status).toBe(403);
   expect(missing.body).toEqual(errorBody('CSRF_FAILED'));
   ```
   Wrong: `supertest(app).get('/api/v1/groups')` without `Host`; hand-built cookies

6. **Mandatory triad per endpoint** in `test/integration/<module>/`: success, 403
   `PERMISSION_DENIED` for a same-tenant user without the permission, and 404 for a tenant B user
   who **has** it, with a body equal to the unknown-id 404 (constitution I).
   ```ts
   // target shape (triad with the real helpers)
   const [a, b] = [await createTenant(), await createTenant()];
   const group = await createGroup(a);
   const [admin, agent, otherAdmin] = [await createUser(a, { roles: ['admin'] }),
     await createUser(a, { roles: ['agent'] }), await createUser(b, { roles: ['admin'] })];
   expect((await asUser(admin).get(`/groups/${group.id}`)).status).toBe(200);
   expect((await asUser(agent).get(`/groups/${group.id}`)).body.error.code).toBe('PERMISSION_DENIED');
   const cross = await asUser(otherAdmin).get(`/groups/${group.id}`);
   const unknown = await asUser(otherAdmin).get(`/groups/${uuidv7()}`);
   expect([cross.status, cross.body]).toEqual([404, unknown.body]);
   ```
   Cross-audience (customer on staff route) is 404 `NOT_FOUND`. Tickets outside view access are 404.
   Wrong: a cross-tenant check with a caller who lacks the permission (only proves 403)

7. **Every tenant-scoped route resource needs a fixture** in `test/cross-tenant/fixtures.ts`:
   `FIXTURES[resource] = { create(tenant) → { params, ids }, bodies?, callerRoles? }`. Key = the
   registry resource (`group`, `ticket`) for `@RequirePermission` routes, `customer:{segment}` for
   `@CustomerApi` routes (`customer:conversation`). The generated `cross-tenant.test.ts` walks
   `RouteAudit.routes()` and fails on a missing fixture. Socket and attachment checks go in
   `REALTIME_CHECKS` / `ATTACHMENT_CHECKS` (`(a, b, callerB) => Promise<void>`).

8. **RLS is tested by catalogue** (`test/integration/rls.test.ts`): any table with `tenant_id` is
   checked for forced `tenant_isolation` with the `NULLIF` expression, zero rows without context,
   and rejected cross-tenant inserts. Don't add per-table RLS tests or exclusions.

9. **Sockets** (`support/socket.ts`): `connectSocket(user, { namespace?, host?, anonymous? })` (path
   `/rt`, `forceNew: true` per identity: the Manager otherwise reuses the first cookie),
   `connectResult(...)` → `'connected'` or the `connect_error` code, `waitForEvent(socket, 'event',
   predicate)` for envelopes. Ack calls: `socket.emitWithAck('subscribe', { stream })`.
   Wrong: two users over one `io()` Manager

10. **Assert the error envelope**: `status` and `body.error.code` (and `details[{ path, issue }]` for
    validation); message text only where the contract fixes it (e.g. `NOT_FOUND`/"Not found").

11. **Events**: assert by reading `outbox_events` in the tenant (type, streams, `customer_payload`
    free of internal fields), or through a socket with `getTestWorker()` running; don't mock
    `OutboxService`.

12. **Coverage gate**: `scripts/check-coverage.sh` (api lines ≥ 80%, web ≥ 70%; v8 over
    `src/**/*.ts` minus `main.*.ts`). Never lower thresholds or widen `exclude`.

## Checklist (before reporting done)
- [ ] Tests ran through `docker compose run --rm -T tools ...` and passed
- [ ] Each new endpoint has success / 403 / cross-tenant 404 (equal to unknown-id body)
- [ ] New resource has a `FIXTURES` entry (and realtime/attachment checks where relevant)
- [ ] Factories with explicit tenants; no dev seed; time moved with `TestClock`
- [ ] No sleeps; `waitForEvent`/`vi.waitFor` with timeouts
- [ ] `check-coverage.sh` passes unchanged
