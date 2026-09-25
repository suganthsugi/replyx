# Run log — 001-multi-tenant-helpdesk

Scope: P1 only (Phases 1–11, T001–T199). Phase 12 (Deploy) excluded. **2026-09-25 user: time matters; finish Phase 3 and Phase 4, then stop.**
Start commit: b4afe6b

## Decisions (approved by user 2026-09-24)
- B1 Unowned paths granted via handoff: backend-agent → root config, `infra/`, `.github/`, `apps/*/Dockerfile`, `compose.yaml`, `.env.example`, `.gitignore`, `.dockerignore`, `apps/api/*` config; frontend-agent → `apps/web/*.config.ts`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/routes/`, `apps/web/public/`; dev-documentator → `apps/docs` scaffold (`package.json`, `astro.config.mjs`, `index.mdx`); frontend-automator → `apps/web/playwright.config.ts`.
- B2 Docs: dev-documentator also owns `apps/docs/src/content/docs/developers/`; documentator also owns `admin/` and `operators/`.
- B3 frontend-agent builds pages against hook signatures given in the handoff; a follow-up wiring pass by frontend-agent under the same task ID when pages must import new hooks.
- B4 committer creates tag `archive/ticket-classifier` (T001); backend-agent removes the nextjs block from CLAUDE.md/AGENTS.md.
- A1 Tests run through Docker `tools` service once T011 exists.
- A2 T052 (data/http.ts) moved early in Phase 2 so orval generation works.
- A3 "Merge into openapi.yaml" tasks = contract/operationId verification; commit only if changes.
- A4 Commits follow docs/commit-guidelines.md: no Co-Authored-By trailers.
- C1 Pipeline resolves tenant from Host before authenticating (T024/T025); accepted deviation from constitution II wording — reviewer informed.
- C3 `@StaffApi()` (P3-1) accepted by the user 2026-09-25: own-account staff routes under `/auth` and `/me` need a staff session but no permission key; the route audit enforces the paths.
- C2 `ADMIN_ACCESS_FIXED` accepted (Admin access still granted via registry).
- T004: validation library = **zod** (research.md silent; record there when docs are touched).
- T006 mutator contract for T052: `export const http = <T>(url: string, options?: RequestInit): Promise<T>` in `apps/web/src/data/http.ts`; rejects with parsed `{ error: { code, message, details? } }`; adds credentials + `X-CSRF-Token` on non-GET. Generated output: `src/api/generated/` (tags-split, schemas in `model/`).
- Skills: first versions drafted from plan/research/constitution; refreshed from kernel code at end of Phase 2.

### Phase 2 decisions (implementation, 2026-09-24)
- P2-1 Order: T034 (outbox) and T029 (registry/decorators) run before T025, which needs `session.revoked` appends and the `@Public`/`@CustomerApi`/`@OperatorApi` metadata. Everything else in task order.
- P2-2 `tenants` grants: `replyx_platform` full DML; `replyx_app` SELECT, INSERT (id, slug, name) for one-transaction provisioning (T033), UPDATE (access_version, updated_at) for `bumpAccessVersion` (T032). Suspension stays a platform action.
- P2-3 `outbox_events` has forced RLS (the app role appends/replays its own tenant) plus policy `relay_all_tenants` TO replyx_platform; platform gets SELECT/UPDATE/DELETE (prune), and SELECT/DELETE on `processed_events`. The unpublished index is `(id) WHERE published_at IS NULL` (serves the id-ordered relay scan).
- P2-4 UUIDv7 everywhere: SQL default `gen_uuid_v7()` (0001_helpers) and `uuidv7()` in `platform-kernel/ids.ts`.
- P2-5 Health routes `/health/live` and `/health/ready` sit outside `/api/v1` and outside tenant resolution (Docker healthchecks have no tenant host). `configureApiApp()` in `src/app.setup.ts` is shared by main.api.ts and the test harness.
- P2-6 Suspended tenants: the resolver middleware attaches `req.tenant`; the global `TenantStatusGuard` answers 503 unless `@AllowSuspended()` (middleware can't read route metadata).
- P2-7 Stream key `tenant` for tenant-wide control events (`access.changed`, `tenant.suspended`); consumed by the gateway, never joined by clients.
- P2-9 T041 (Clock) pulled forward before T025 so session expiry uses the injected clock.
- P2-10 CSRF (T026): global guard after tenant status, before auth; safe methods and `@Public()` routes exempt (no session to ride; sign-in issues the cookie); `@OperatorApi()` routes not exempt. Sign-in (US3) calls `issueCsrfCookie(res, maxAge)` next to `SessionService.setCookie`.
- P2-11 Lockout (T027): sliding window in Redis ZSET `lockout:{tenant}:{user}`; `users.locked_until`/`failed_sign_ins` durable; DB consecutive-count fallback if Redis is down. Sign-in must check `LockoutService.isLocked` before verifying and answer `accountLocked()` (423). The `auth.locked` audit row is inserted directly (TODO(T042): route through AuditService).
- P2-12 Rate limits (T028): `RateLimitGuard` after AuthGuard; `@RateLimit('sign-in'|'sign-in-link'|'customer-message')` + `api` on every request with a session; `RateLimiter.consume()` for sockets; fail-open when Redis is down.
- P2-13 Policy (T030): ticket actions need the registry key AND the group flag; merge/split/bulk_update/move_message need edit; invisible ticket (no `ticket.view` or no `can_view`) = `not_found`; only `user` actors (others throw); `ticketAccessFilter(ctx, action, column='tickets.group_id')` is async. T048 done right after T030 (unit tests; DB paths probed on the scratch DB).
- P2-14 Permission guard (T031): last global guard; cross-audience calls (customer on staff route, staff on `/customer/*`, operator route off the console host) answer the same 404 as an unknown route (`NOT_FOUND`/`Not found`). Operator routes require `req.operator`, which T081's operator auth guard must set. Route audit also enforces `@CustomerApi` ⇔ `/customer/*` and `@OperatorApi` ⇔ `/platform/*`. `tenantContextOf(req)` in request-context.ts builds the HTTP context.
- P2-15 Provisioning (T033): `TenancyModule` lives in tenant-provisioning.service.ts; contributors are providers marked `@ProvisioningContributor()` implementing `TenantProvisioningContributor.contribute(tx, tenant)`. Needs registry-synced `permission_definitions` (the api syncs on boot; test harness must boot the app or sync before provisioning). Errors: 409 `SLUG_TAKEN`/`SLUG_RESERVED`, 400 details `invalid_format`/`invalid_timezone`.
- P2-16 Jobs (T036, done before T035): consumers extend `IdempotentHandler` (`consumer`, `queue`, `eventTypes`, `handle(tx, event)`); the claim in `processed_events` shares the handler's transaction. Job name = consumer, job id `{consumer}.{eventId}`. `JobsModule` + `OutboxRelayModule` are worker-only.
- P2-17 Relay/envelope (T035): persistent envelopes are emitted under the Socket.IO event name `event`; envelope `stream` uses client names (`user`, `views`, `conversation`, `tickets`, `ticket:{id}`, see `clientStream`). `customerPayload` is `{ type: 'conversation.*', data }` (`CustomerProjection`); customer envelopes carry `actor: { kind }` only. Control events (`session.revoked`, `tenant.suspended`, `access.changed`) are also `serverSideEmit('replyx:control', { id, seq, tenantId, type, payload })` for the gateways. `seq` is global (max+1 per batch). T052's socket.ts must follow this.
- P2-18 Gateway (T037–T040): `RedisIoAdapter` in `configureApiApp`; sockets join `t:{tenant}:tenant` and `t:{tenant}:session:{sessionId}` for control targeting; forced disconnects emit `closing { code }` first (web client must handle it). `TICKET_GROUP_LOOKUP` (socket-context.ts) is `@Optional` in `StreamAccess`: US6 must provide it from a **global** module, until then `ticket:*` subscribe/sync is NOT_FOUND. `sync` acks `{ ok, upToSeq, resyncRequired: string[] }` (bounds read via the platform pool; replay capped at 1000 per stream). `access.changed`/`access.revoked` reach sockets as `user`-stream envelopes (measured ~24 ms). Presence service only; gateway messages wired by T111/T143/T238. socket.io-client tests need `forceNew: true` per identity (Manager multiplexing reuses the first cookie).
- P2-19 Audit/mail/seed (T042–T044): `TenantContext` has optional `ip` (set by `tenantContextOf`); `AuditService.record(tx, entry, { actor? })` drops secret/body keys; `AuditModule` in audit.module.ts (global). Lockout now audits via AuditService (its `meta.ip` param removed: sign-in builds its context with `ip`). Email: `MailQueue.enqueue(data, { dedupeKey })` **after commit** (jobs may carry link tokens; removed from Redis on completion/failure; dead-letter copies keep only ids); `JobProcessor` base class for non-event jobs; global `QueuesModule` in both processes. Templates `mail/templates/{name}.subject.txt|.html|.txt` (+ nest-cli assets); generic `notice` template exists. Seed: `pnpm --filter api seed:dev` (Nest context with the api role so the registry syncs); "Support Agent" = Agent permissions + view/edit Support; globex ticket pending US1.
- P2-20 Test harness (T045–T050): Testcontainers PG17 + Valkey8 start for every `pnpm test` (~20 s); `test/support/env.ts` overrides the dev `.env` URLs; `getTestApp({ imports })` (first call per file wins) with `TestClock`; `getTestWorker()` for relay/consumers; factories `createTenant/createUser/createGroup/createRole/setGroupAccess`; `asUser(user, { host?, csrf? })`/`asGuest`; `connectSocket/connectResult/waitForEvent`. **Test files run sequentially** (`fileParallelism: false`): relay leadership and the global seq are DB-wide. Cross-tenant suite: `test/cross-tenant/fixtures.ts` `FIXTURES[resource]` (staff: registry resource; customer: `customer:{segment}`), plus `REALTIME_CHECKS`/`ATTACHMENT_CHECKS`; verified to fail on a missing fixture and on a leaking route. `OutboxRelay.start()` connects the emitter without leading.
- P2-21 Web areas (T054): console area = host whose first label is `console` (a reserved slug; no build-time config needed). `/desk` and below = workspace; anything else on a tenant host = customer. `AreaShell` gives each area its own `LiveRegionProvider` + `ToastProvider` + route-keyed `ErrorBoundary`; `App` holds QueryClient/theme/router. Pages add routes inside `CustomerArea`/`WorkspaceArea`/`ConsoleArea` (workspace paths are relative to `/desk`).
- P3-1 `@StaffApi()` (route access kind `staff`): any signed-in staff user, no permission key, only for the caller's own account (`/auth/sign-out*`, `/me*`). Customer sessions get the cross-audience 404 (87989d7).
- P3-3 Staff sign-in failure is 401 `INVALID_CREDENTIALS` (not `UNAUTHENTICATED`, whose web message is "Sign in to continue"). The failure that sets the lock answers 423. Reset tokens: 400 `VALIDATION_FAILED` details `[{ path: 'token', issue: 'invalid_or_expired' }]`; a new reset request or a confirm retires the user's other unused resets; confirm also clears lockout and revokes all sessions. Reset link `/desk/reset-password?token=` (T067 page). Password reset request uses the `sign-in-link` rate limit (per email); confirm uses `sign-in`.
- P3-4 Email links: `tenantUrl(slug, path)` (platform-kernel/http/public-url.ts) with `PUBLIC_URL_SCHEME`/`PUBLIC_URL_PORT` (dev http/5173, added to `.env.example` and the local `.env`; `docker compose up -d api worker` to reload env, `restart` doesn't).
- P3-5 `MeService.me(ctx)` (identity/me.service.ts) builds the `Me` DTO; sign-in returns it; T060's controller reuses it. `avatarUrl` is null until attachments exist.
- P3-6 Route audit: `/customer` and `/platform` also hold that audience's `@Public()` routes (sign-in links, operator sign-in); nothing else (59ccf67).
- P3-7 `customer_profiles.email_on_reply` added to migration 0006 in place (never deployed; dev DB got a manual `ALTER`).
- P3-8 Customer password sign-in reuses `StaffAuthService.signIn(..., { kind: 'customer', trustDevice })` (same lockout, 401 `INVALID_CREDENTIALS`). Customer avatars: only `null` accepted until attachments exist (same for staff `PATCH /me`).
- P3-9 Users: invite with customer-only roles creates an active customer (no email); mixed staff/customer roles → 400 `roleIds invalid_value`. Delete checks `USER_HISTORY_CHECKS` providers (none until tickets exist, so the 409 path can't be tested yet). Self deactivate/delete/erase → 409 `CANNOT_*_SELF`. Erase = deactivate now + `user.erasure_requested` event (T062 consumer on the `retention` queue, must be registered in a module loaded by the worker). New events `user.deactivated`, `user.erasure_requested` on `user:{id}`.
- P3-2 `user_invitations.user_id` (not in data-model): the invitation belongs to the `invited` user row that POST /users creates; accept activates that row.
- P2-8 API tests pin `NODE_ENV=test` (the dev image sets development). Table row types live in `src/platform-kernel/db/tables/*.ts`, intersected into `Database`.

## Done
| task | agent | commit | notes |
|------|-------|--------|-------|
| T001 | backend-agent + user (file deletion) + committer | de7d7f9 | tag `archive/ticket-classifier` → b4afe6b (not pushed); deletions done by user after permission block |
| T002 | backend-agent | 626ec88 | lockfile not regenerated (no host pnpm); regenerate in Docker after T004/T005/T007 |
| T007 | dev-documentator (sonnet) | 2d9a62c | sidebar autogenerates guides/admin/operators/developers; API ref link → /api/docs |
| T005 | frontend-agent | 58ff442 | setupFiles removed until T055; not typechecked (no install yet) |
| T012 | backend-agent (sonnet) | b98c413 | dev DB passwords `replyx_*_dev_password`, db `replyx`; T013/T011 must match |
| T003 | backend-agent | 06a0b41 | root tsconfig.json deleted; module settings per app; ESLint unverified until Docker install |
| T004 | backend-agent | 4b284d7 | zod chosen; unverified until install; see Open issues follow-ups |
| T006 | frontend-agent | 5a20662 | tags-split, fetch mutator `http` (see Decisions) |
| T013 | backend-agent | c493295 | verified on postgres:17; passwords via `\getenv REPLYX_*_PASSWORD` |
| T008 | backend-agent | 78b8f88 | redocly: 0 errors, 22 warnings (unused components, license) |
| T010 | backend-agent (sonnet) | ec8b680 | Caddy Dockerfile duplicates the web build stage; build blocked on stale lockfile at the time |
| T009 | backend-agent | 1067e6d | stages base/dev/build/runtime; migrations compiled separately; not yet built (lockfile) |
| T014 | backend-agent (sonnet) | facaa5a | redocly step + docker-build matrix (api runtime, web build, caddy); actionlint clean |
| T015 | backend-agent (sonnet) | 084c88f | api (runtime) + web (caddy) to ghcr `:<sha>`/`:main`; actionlint clean |
| T011 | backend-agent | c8c039e | 10 services; one-shot `install`; worker own dist volume; `docker compose config` OK, `up` at checkpoint |
| T005 fix | frontend-agent | a78318f | Vite proxy `changeOrigin: false` (Host-based tenant resolution) |
| T009 fix | backend-agent | 096acb3 | git + ca-certificates in api `dev` stage |
| T010 fix | backend-agent (sonnet) | 7508944 | web `dev` stage: no COPY/install, git, workdir /repo/apps/web; dev image builds |
| T002 lockfile | backend-agent | ceef552 | frozen install + api/web typecheck + web vitest pass in container |
| T005 fix 2 | frontend-agent (haiku) | c9cbda4 | import-x/order in vite/vitest configs; web lint clean |
| T007 fix | dev-documentator (sonnet) | 026f580 | Starlight 0.42: `@astrojs/starlight/loaders`, sidebar `items:[{autogenerate}]`; docs build passes |
| T014 review fix | backend-agent | 824cc3f | ci `permissions: contents: read`; freshness via `git status --porcelain` |
| T009 review fix | backend-agent | f70c48d | runtime `/data/files` owned by node |
| T002 review fix | backend-agent | a437e64 | turbo `globalPassThroughEnv` |
| T012 review fix | backend-agent | 4a5555a | re-ignore `/.next/` |
| T005 review fix | frontend-agent | c7fb108 | web vitest `passWithNoTests` (critical) |
| T005 review fix | frontend-agent | 80d9883 | `@vitest/coverage-v8` ^5.0.1 + lockfile |
| T006 review fix | frontend-agent | c55df30 | orval `includeHttpResponseReturnType: false` (mutator returns body) |
| T016 | inline (main session) | 7e9ce83 | in-progress files verified; lint fix for the empty `Database` (TenantTableName without intersection) |
| T017 | inline | 29e755c, 02c11e7 | NULLIF policy; grant helpers; gen_uuid_v7(); fix commit for a lint error my pipeline hid |
| T018–T021 | inline | b7023ee, 8251d0b, c680ecd, 5400895 | probed on a scratch postgres:17 with init.sql (RLS, grants, checks, composite FKs) |
| T022 | inline | bac5487 | +15 unit tests |
| T023 | inline | eda67cb (deps), daa56d2 | OTel deps; RedisModule; LOG_LEVEL/METRICS_PORT in .env.example |
| T024 | inline | 97a086a | live-checked Host resolution on the dev stack |
| T034 | inline | 1f4fc5b | moved before T025 (P2-1) |
| T029 | inline | fcba662 | 57 keys; sync upserts definitions (platform pool, advisory lock) then reconciles every tenant's Admin role to all keys; access decorators accumulate so T031 can reject duplicates; health routes `@Public()` |
| T041 | inline | 68f9e58 | pulled forward (P2-9); dev offset in Redis `replyx:dev:clock-offset-ms`, read by every non-production process |
| T018 fix | inline | 46e7a0c | `GeneratedTimestamp` (Kysely doesn't unwrap `Generated<ColumnType>`) |
| T025 | inline | 30f7fbe | `SessionRepository extends TenantRepository`; cache `session:{tenant}:{hash}` + index `session-key:{tenant}:{id}`; `purgeCache` must also be called post-commit by the `session.revoked` handler (T037); guards registered in order in `src/api-pipeline.module.ts` (T031 adds PermissionGuard there) |
| T026 | inline | 838e05f | CSRF guard + cookie helpers |
| T027 | inline | 8f92138 | probed on scratch DB + dev Valkey: window ageing, single audit on lock, no count during active lock |
| T028 | inline | ffde2b0 | Lua sliding window probed on dev Valkey |
| T030 | inline | ab98429 | probed on scratch DB (union, not_found/deny, filter, eligibility, cache, version bump) |
| T048 | inline | 702e400 | pulled forward after T030 |
| T031 | inline | 04e764a | live-checked: api boots with the route audit |
| T032 | inline | 82093d8 | probed: bump, event on `tenant` stream, tenant mismatch refused, rollback |
| T033 | inline | 3eee8fe | probed with the real registry synced into the scratch DB |
| T036 | inline | edf817a | pulled before T035; probed with real BullMQ (dedupe, redelivery skip, dead letter) |
| T035 | inline | d664b82 | probed: two relays (one leader, failover ~5 s), gap-free seq, rollback not published, rooms/namespaces |
| T037 | inline | 98b45a9 | live-checked on dev stack: audience/tenant/cookie handshake, NOT_FOUND acks, revocation → closing + disconnect |
| T038 | inline | 6989b65 | live-checked: replay own streams only, other tenant/user excluded, customer projection only |
| T039 | inline | eb9fefd | live: revocation delivered in ~24 ms |
| T040 | inline | ecbe276 | TTL behaviour probed on dev Valkey |
| T042 | inline | b356982 | probed on scratch DB (ip/request id from context, consumer once, rollback, app UPDATE refused) |
| T043 | inline | 306c1e8 | probed: queue → worker → Mailpit; build copies templates |
| T044 | inline | 4880389 | dev DB seeded (acme, globex, operator); rerun is a no-op |
| T045 | inline | 8b1f0eb | harness smoke test (pipeline, sockets, relay revocation) |
| T046 | inline | ea8716b | proved with a temporary leaky route (not committed) |
| T047 | inline | 940605b | catalogue + no-context + cross-tenant insert |
| T049 | inline | 6e17c16 | 7 tests; vitest files now sequential |
| T050 | inline | 439323e | probe controller inside the test app |
| T051 | inline | 505115f | user's in-progress theme verified and completed |
| T052 | inline | 6a7b3e5, c128e7f | http/errors/query-client/socket; `generate-api-client.sh` output committed (models only so far) |
| T055 | inline | 7ba2264 | jest-dom matchers registered in setup (the `/vitest` entry breaks under pnpm) |
| T053 | inline | 41fa2d4 | +15 component tests; `test/render.tsx` `renderWithProviders`; live regions use plain `aria-live` (no status/alert role) so they don't collide with components' roles |
| T005 fix | inline | 39280be | web tsconfig `module: ESNext` (dynamic imports) |
| T056 | inline | 5ff879d | probed: inviter delete nulls only `invited_by`, pending email unique is case-insensitive, empty role_ids rejected; RLS test covers the 4 tables |
| T057 | inline | 87989d7, aa65cbd, 5c06fee, f23f14e | live-checked on dev: sign-in cookies, identical 401s, CSRF 403, sign-out 204 then 401, reset 202 for unknown email, Mailpit link, confirm single use, old password 401 |
| T063 | inline | 6523468, 91cb4c3 | merged via a Node script (yaml@2.9.1, run in tools container); redocly valid |
| T061 (early) | inline | a565d1c, 00bb14a | `GET /roles` (listRoles) pulled forward for the invite dialog; T091 extends `authorization/roles.controller.ts` |
| T073 | documentator (sonnet) | 8e2dd70 | docs build verified inline |
| T058 | inline | c42babc | invitations; roles assigned at invite time, access only once active |
| T059 | inline | 59ccf67, 2571954, 08527e2 | live-checked: self-registration, staff email gets no link, redeem single use, 30-day cookies, PATCH me, customer on staff route 404, password sign-in |
| T060 | inline | 4061dac | live-checked PATCH /me, invalid timezone 400, wrong current password 400 |
| T054 | inline | 1534483, 4f0595f | areas are separate chunks in `vite build`; live-checked acme/console hosts on the dev server |
| T061 | inline | 0f58880 | live-checked every route: filters, cursor page, 409 EMAIL_IN_USE, role-kind mixing 400, self-action 409s, cross-tenant 404, agent 403, access_version bumps |
| T062 | inline | 6f8a1aa | erasure consumer on the `retention` queue; live-checked both kinds, the freed email and the audit entry |
| T064 | test-automator + inline | dbd372d | as written; green |
| T065 | test-automator + inline | 414bdfc | fixed `linkTokenFor`: the email job is found by the link's dedupe key (`getJobs` has no order) |
| T066 | inline | 38d900b | 22 tests; `user` and `role` cross-tenant fixtures |
| T067–T070 | frontend-agent + inline | 6091e37, 51283d5, 723d147, 6078b06 | live-checked in Chrome: sign-in (401/lockout copy), invite dialog, ERASE confirmation, profile, customer link sign-in via Mailpit |
| T071 | inline | 75f10bf | 26 component tests; `renderWithProviders` now wraps a QueryClient and a MemoryRouter |
| T072 | inline | 357c203 | `e2e/mailpit.ts` helper; 6/6 green on both Playwright projects |

### Phase 3 complete (T056–T073) 2026-09-25
- Checkpoint: `turbo run lint typecheck test` 8/8 green; api 231 tests, web 94 tests; coverage api 88.61% / web 85.39% (gate 80/70); `redocly lint` valid; e2e 6/6 on desktop and mobile.
- Two real defects found by the live checks and fixed in the owning task's commit:
  - a staff session on the tenant root got "Couldn't load your account" — `/customer/me` answers 404 for staff, so `CustomerArea` now treats `NOT_FOUND` like `UNAUTHENTICATED` (T070).
  - destructive text buttons failed WCAG AA on the page background, and the users table widened the page at phone width (Chrome then zoomed the whole page out) — theme `textError`/`outlinedError` use `danger.dark` in light mode, and the table scrolls inside its container (T071).
- Follow-ups for later stories:
  - `useAccessChangeRefetch` (apps/web/src/data/auth.ts) is written but unwired: there is no `RealtimeClient` provider yet. Wire it when one arrives (T088/T099).
  - `USER_ERASURE_CONTRIBUTORS` (apps/api/src/identity/erasure.job.ts) has no provider yet: Tickets (US6) must erase a customer's tickets and messages and put `Former user` on a staff user's content. Same for `USER_HISTORY_CHECKS`, which `DELETE /users/{id}` consults.
  - `inviteUser` declares an `Idempotency-Key` parameter in openapi.yaml that nothing enforces yet.
- Dev-environment gotcha: `.env` has `CHOKIDAR_USEPOLLING=false`, so Vite in the `web` container does not see host edits on Windows — `docker compose restart web` after editing `apps/web`, or set the flag to `true`.
- Live checks over HTTP need the cookies handled by hand: `rx_session`/`rx_csrf` are `Secure`, so curl will not store them from an `http://` response. Read the `Set-Cookie` headers and send them back as a `Cookie` header (browsers accept them because `localhost` is a secure context).
- E2E notes: sign-in is rate-limited 10/min per IP and both Playwright projects share one, so the spec signs in as few times as possible; unique email addresses per test (never clear the shared Mailpit); on the phone viewport the invite dialog is submitted from the keyboard, because a click on the footer button lands on the dialog container.

### Resume here (Phase 4) 2026-09-25
- User scope: finish Phase 3 and Phase 4, then stop. Phase 3 is done; Phase 4 (T074–T090) is next, starting at T074.
- Checks: `docker compose run --rm -T tools bash -c 'set -o pipefail; pnpm turbo run lint typecheck test --continue'`; coverage `./scripts/check-coverage.sh`; e2e `docker compose --profile e2e run --rm -T playwright bash -c 'cd /repo && pnpm --filter web exec playwright test e2e/'` after `pnpm --filter api seed:dev`.
- `docker compose restart api worker` after backend changes, `restart web` after frontend changes. Write files as UTF-8.
- Merge script for openapi (T081 needs it): scratchpad `merge-openapi.js`, run `docker compose run --rm -T -e PLAN='<json>' tools node - < merge-openapi.js`; not in the repo — recreate if the scratchpad is gone.

## Skills created
- Catalog section added to CLAUDE.md (8 skills `planned`) — skill-writer — b773097

- Phase 2 drafts (from the docs; refresh from kernel code at the end of Phase 2): tenant-scoping, api-conventions, realtime-events, testing-conventions, ui-components, data-hooks, web-testing. skill-writer ×3, c2f0499 (catalog flipped to ready).

## Open issues
- Skill-writer follow-ups for Phase 2 handoffs: **T017** use the `NULLIF` policy (skill), not the tasks.md text. **T021** outbox relay reads across tenants: grant `replyx_platform` SELECT/UPDATE on `outbox_events` (+`processed_events`) in the migration, per data-model. **T022** validation uses zod `.strict()`; `issue` codes `too_long`/`required`/`unrecognized_key` are proposed; confirm the 403 code name (`PERMISSION_DENIED`?). **T045** init.sql uses psql `\getenv`, so mount it into initdb.d with the `REPLYX_*_PASSWORD` env vars; factories go in `test/support/` (T045 wins over plan.md). **T037** stream keys `user:{userId}`/`views:{userId}` still to confirm.
- ~~T001 deletion blocked by permissions~~ — resolved: user deleted the files manually.
- `pnpm-lock.yaml` stale (still Next.js deps); pnpm not on host PATH. Regenerate via Docker (node:24 + corepack pnpm@12.5.1) once app package.json files exist.
- ~~Legacy root tsconfig.json~~ — removed in T003.
- ESLint config (T003) and web tsconfig (T005) unverified; run lint/typecheck in Docker at Phase 1 checkpoint. apps/web tsconfig must include vite/vitest config files for projectService.
- T004 follow-ups: (a) migrations/ outside build rootDir → prod `migrate` needs compiled migrations (handle in T009/T017); (b) api+worker dev watchers share `dist` → separate volumes in T011; (c) `scripts/lint-changed.sh` skips apps without their own `eslint.config.*` → add per-app re-export configs (apps/api, apps/web) at checkpoint; (d) dep versions guessed offline — verify at lockfile regen.
- T013 follow-ups: (a) T011 must pass `REPLYX_OWNER_PASSWORD`/`REPLYX_APP_PASSWORD`/`REPLYX_PLATFORM_PASSWORD`, `POSTGRES_PASSWORD`, `POSTGRES_DB=replyx` to postgres and add them to `.env.example`; (b) **T017 must use `NULLIF(current_setting('app.tenant_id', true), '')::uuid`** in the RLS policy (empty-string cast errors on pooled connections); (c) spec inconsistency: research D3 says `replyx_platform` runs migrations, tasks T013/T017 say `replyx_owner` — followed tasks; D3 needs a doc fix (user decision); (d) minor: runtime roles can connect to the `postgres` maintenance DB.
- T008 follow-ups: tags = identity, access, tickets, operations, customer (one per contract file); platform.yaml deferred to T081 (needs console server + `rx_op_session` scheme under a `platform` tag, per T081); CSRF header scheme and 413/415/423/503 shared responses to add when endpoints merge.
- T009 follow-ups: **T017** migrator locates migrations via `fileURLToPath(new URL('../../../migrations', import.meta.url))`; migrations import only packages (compiled separately); prod migrate cmd `node dist/platform-kernel/db/migrator.js`. **T011** needs an install step into named node_modules volumes before api/worker; writable `/data/files` volume + healthcheck. `.dockerignore` could exclude `specs/`, `docs/` (minor).
- T011 follow-ups routed back to the original agents: Vite proxy `changeOrigin: false` (T005/frontend-agent); web `dev` stage aligned with api dev + git (T010); git in api `dev` stage for `tools` (T009). Compose service is `valkey` (research/quickstart say `redis`: doc drift). api/worker/tools read the whole `.env` (dev only; acceptable).
- Stale `.next/` and root `node_modules/` left on disk (agent deletion blocked); asked user to remove.
- ~~Pending decisions~~ resolved 2026-09-24: migrations run as `replyx_owner` (recommended: the schema owner runs DDL, `replyx_platform` stays least-privilege; research D3 wording to be fixed when docs are touched). The user removed the stale dirs, and the orchestrator may delete stale artifacts from now on.
- Phase 1 review (minor, deferred): release.yml publishes even if CI fails + actions not SHA-pinned (T015); caddy Dockerfile hard-codes pnpm@12.5.1 and runs as root; Caddyfile due in T201 (T010); compose `env_file: .env` gives owner creds to api/worker, dev only, not for T200 (T011); mailpit/clamav images unpinned (T011); openapi `platform` tag/console server/`operatorSession` → T081 (T008); docs GitHub URL placeholder + API ref link to localhost (T007).

## Story summaries
### Phase 1: Setup (T001–T015): reviewer PASS 2026-09-24
- 15 tasks and 16 fix commits, b4afe6b..c55df30. The lockfile was regenerated in Docker (ceef552).
- Checkpoint: `turbo run test lint typecheck` passes 8/8 in Docker; the coverage gate passes (no tests yet); the docs build passes; `compose up` shows all services healthy; the web proxy on acme.localhost:5173 reaches Nest. Host preservation can only be checked once T024 exists.
- Review round 1 FAIL: 1 critical and 5 majors, all fixed. Round 2 PASS.
- Carry-over: run `scripts/generate-api-client.sh` right after T052 (http.ts) and commit what it generates, or confirm it generates nothing. The CI freshness check now also catches untracked files.
- Next up: Phase 2. skill-writer creates `tenant-scoping` before T016.

