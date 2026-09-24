---
name: testing-conventions
description: API test harness (Vitest, Supertest, Testcontainers), factories, asUser, success/403/cross-tenant-404 triad, RLS and Clock rules, coverage gate. Use when writing or reviewing apps/api tests.
---

# testing-conventions

Rules for `apps/api/test/**`. Loaded by test-automator and reviewer. The harness (T045–T047) is
not written yet: snippets marked **target shape** come from `specs/001-multi-tenant-helpdesk/`
(tasks.md T045–T050, research D25, D26). Real config today: `apps/api/vitest.config.ts`,
`scripts/check-coverage.sh`, `compose.yaml` (`tools` service).

## Layout
- `test/support/` — `global-setup.ts`, `factories.ts`, `http.ts` (`asUser`), `socket.ts` (T045).
  plan.md shows `test/factories/`; tasks.md T045 wins: factories live in `test/support/`.
- `test/unit/`, `test/integration/<module>/`, `test/cross-tenant/`, `test/concurrency/`.
- Only `test/**/*.test.ts` is collected (`vitest.config.ts` `include`). Never put tests in `src/`.

## Rules

1. **Run tests only in Docker, via the `tools` service** (it mounts the Docker socket and sets
   `TESTCONTAINERS_HOST_OVERRIDE`, see `compose.yaml`).
   ```bash
   docker compose run --rm tools pnpm --filter api test
   docker compose run --rm tools pnpm --filter api test:cross-tenant
   docker compose run --rm tools bash scripts/test-affected.sh
   docker compose run --rm tools bash scripts/check-coverage.sh
   ```
   Wrong: `pnpm test` on the host, or pointing tests at the dev `postgres`/`valkey` services.

2. **Global setup starts throwaway `postgres:17` and `valkey/valkey:8`** (same images as
   `compose.yaml`), runs `infra/postgres/init.sql`, then all migrations as `replyx_owner`.
   `init.sql` uses psql `\getenv` for `REPLYX_*_PASSWORD`, so it must run through the image's
   initdb entrypoint (copy it to `/docker-entrypoint-initdb.d/` and set those env vars), not
   through `pg.query`. Pass connection URLs to tests with Vitest `provide`/`inject`.
   ```ts
   // target shape (tasks.md T045)
   const pg = await new PostgreSqlContainer('postgres:17')
     .withCopyFilesToContainer([{ source: INIT_SQL, target: '/docker-entrypoint-initdb.d/init.sql' }])
     .withEnvironment({ REPLYX_OWNER_PASSWORD: 'owner-test', REPLYX_APP_PASSWORD: 'app-test',
                        REPLYX_PLATFORM_PASSWORD: 'platform-test' })
     .start();
   const valkey = await new GenericContainer('valkey/valkey:8').withExposedPorts(6379).start();
   await migrateToLatest(ownerUrl(pg));
   project.provide('databaseUrl', appUrl(pg));
   ```

3. **The app under test connects as `replyx_app`** (NOBYPASSRLS). Only the migrator uses
   `replyx_owner`; only platform code uses `replyx_platform`.
   Wrong: using the container's `postgres` superuser for the app pool (silently bypasses RLS).

4. **Every factory takes an explicit tenant** (`test/support/factories.ts`):
   `createTenant()`, `createUser(tenant, { roles })`, `createGroup(tenant)`. Tenants are created
   through `TenantProvisioningService.provision` so system roles exist. Fake data only
   (`agent@example.test`, slugs like `tenant-a-<random>`); each test creates its own tenants,
   so tests never depend on order or on the dev seed.
   Wrong: `createUser({ email })` with an implicit/default tenant; reusing `acme`/`globex`.

5. **HTTP calls go through `asUser(user)`** (`test/support/http.ts`): a Supertest agent with
   `rx_session` and `rx_csrf` cookies, `X-CSRF-Token` on non-GET, and `Host: {slug}.localhost`.
   Wrong: calling services directly in an endpoint test, or hand-building cookies in each test.

6. **Mandatory triad per endpoint** in `test/integration/<module>/`: success, 403 for a
   same-tenant user without the permission, and 404 for a user of another tenant who **has** the
   permission. The cross-tenant 404 must equal the nonexistent-id 404 (constitution I).
   ```ts
   // target shape (research D25, T045)
   it('GET /groups/:id — 200 / 403 / cross-tenant 404', async () => {
     const [a, b] = [await createTenant(), await createTenant()];
     const group = await createGroup(a);
     const admin = await createUser(a, { roles: ['admin'] });
     const agent = await createUser(a, { roles: ['agent'] });
     const otherAdmin = await createUser(b, { roles: ['admin'] });

     await asUser(admin).get(`/api/groups/${group.id}`).expect(200);
     const denied = await asUser(agent).get(`/api/groups/${group.id}`).expect(403);
     expect(denied.body.error.code).toBe('PERMISSION_DENIED');
     const cross = await asUser(otherAdmin).get(`/api/groups/${group.id}`).expect(404);
     const missing = await asUser(otherAdmin).get(`/api/groups/${uuidv7()}`).expect(404);
     expect(cross.body).toEqual(missing.body);
   });
   ```
   Lists and search: tenant B gets 200 with no tenant A ids. Tickets outside the user's view
   access are 404, not 403 (`not_found` from the policy service).
   Wrong: a cross-tenant test using a user who lacks the permission (proves only the 403 path).

7. **Every new tenant-scoped resource adds a fixture** to `test/cross-tenant/fixtures.ts`. The
   generated suite (T046) enumerates routes with `DiscoveryService` and fails when a route's
   registry resource has no fixture. Real-time: tenant B `subscribe` to a tenant A stream acks
   `NOT_FOUND` (`test/support/socket.ts`, `waitForEvent`).

8. **Every new table with `tenant_id` gets RLS in its migration** (`enable_tenant_rls`); the
   catalogue-driven `test/integration/rls.test.ts` (T047) then checks it automatically: no
   `app.tenant_id` → zero rows; insert with a different `tenant_id` → error. Do not add
   per-table RLS tests; do not add exclusions except the global tables in data-model.md.

9. **Time comes from the injected `Clock`** (`src/platform-kernel/clock.ts`, T041). Tests
   override it with a fixed clock and advance it explicitly; never `vi.useFakeTimers()` on code
   that talks to Postgres, and no `setTimeout` sleeps to wait for timers.
   Wrong: `Date.now()` / `new Date()` in `src/` business logic; `await sleep(31_000)` for the sweeper.
   Waiting for async effects (relay, sockets) uses `vi.waitFor` or `waitForEvent` with a timeout.

10. **Error assertions check the envelope** `{ error: { code, message, details? } }`
    (`contracts/common.yaml` `ErrorResponse`): assert `status` and `body.error.code`, never the
    message text.

11. **Events**: assert emitted events by reading `outbox_events` for the tenant (type, streams,
    `customer_payload` has no internal fields), not by mocking `OutboxService`. See the
    `realtime-events` skill.

12. **Coverage gate**: `scripts/check-coverage.sh` requires line coverage api ≥ 80%, web ≥ 70%
    (v8 provider, `src/**/*.ts` minus `main.*.ts`). Don't lower thresholds or widen `exclude`
    in `vitest.config.ts` to pass.

## Checklist (before reporting done)
- [ ] Tests ran with `docker compose run --rm tools ...` and passed.
- [ ] Each new endpoint has success / 403 / cross-tenant 404 (with equal-body check).
- [ ] New tenant resource has a cross-tenant fixture and an `enable_tenant_rls` migration.
- [ ] Factories called with an explicit tenant; no dev-seed data used.
- [ ] No wall-clock time or sleeps; `Clock` overridden where time matters.
- [ ] `check-coverage.sh` passes without threshold changes.
