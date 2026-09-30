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

| T074–T081 | inline | c13c3cc..0e2bfb6 | backend: support access grants, operator auth, tenants API, suspension, support token as read-only actor, branding, openapi merge |
| T082–T085 | inline | 1f306cf..f82c032 | integration tests + cross-tenant fixtures (`support_access_grant`, `tenant_settings`, socket handshake) |
| T086–T088 | inline | 4cd76b1, b384a2b, a3e5a80, cf45443 | console + support access pages, hooks; new `data/realtime.tsx` (`RealtimeProvider`, `useSessionEnded`) wired into the workspace and customer areas |
| T089 | inline | 327c4d7 (+4655f37 timeouts) | 8/8 e2e on both projects |
| T090 | documentator (sonnet) | 431a0a0 | docs build verified inline |

### Phase 4 complete (T074–T090) 2026-09-25
- Checkpoint: `turbo run lint typecheck test` 8/8 green; api 265 tests, web 119 tests; coverage api 87.8% / web 84.32% lines; docs build passes; e2e 8/8 on desktop and mobile.
- T088 went further than its text: no area opened a socket, so suspension could not reach an open page. `RealtimeProvider` opens one per area once the user is known. Staff use `useKnownMe`, a cache-only `['me']` observer; customers open theirs once `/customer/me` has loaded. On `closing`, staff get a cleared cache, a toast and `/desk/sign-in`. For customers, `TENANT_SUSPENDED` refetches branding, which shows the unavailable page, and any other code resets `customerMe`. `useAccessChangeRefetch` (Phase 3 follow-up) is now wired. Component tests mock `socket.io-client` globally with an inert socket (test/setup.ts).
- Playwright `timeout` 60 s / `expect` 10 s: with the lifecycle spec, four workers against the Vite dev server timed the sign-in spec out.
- Component tests for the US2 pages had no task; they were added so the web coverage gate keeps its margin.
- Not covered: a signed-out customer on a page that is already open only notices a suspension when branding refetches (focus, or 60 s stale), because it has no socket.

### Stopped here 2026-09-25
- User scope (Phases 3 and 4) done. Next is Phase 5 (US4, T091+).

### Phase 5 decisions (2026-09-26; user: continue Phase 5, skip Jira if unavailable)
- Jira skipped: the Atlassian MCP server failed to connect (404) for the whole run. No RX issues were created for T091–T102.
- P5-1 `GET /groups/{id}/eligible-owners` is `@RequirePermission('ticket.edit')` and then the policy decides on the group itself: no view gives 404 `GROUP_NOT_FOUND`, view without edit gives 403. Agents don't hold `group.view`, but they pick owners. A support session skips the group check.
- P5-2 `GROUP_TICKET_STATS` (groups.service.ts) is an optional provider for open-ticket counts per group and per owner, and for `hasTickets` (409 `GROUP_HAS_TICKETS`). **US6 must provide it from a global module.** Until then every count is 0 and no group has tickets.
- P5-3 `role.updated { roleId, groupsLostEdit }` goes on the `tenant` stream. The relay does not put it in socket rooms, so only consumers see it. **T142 consumes it to unassign owners (FR-026).** Every role edit bumps the access version.
- P5-4 The role access rules are pure functions in `authorization/role-access.ts` (`diffGroupAccess`, `reducesAccess`, `newGroupAccess`). A missing matrix entry counts as no access.
- P5-5 Cross-tenant fixtures can be keyed by route name (`GroupsController.eligibleOwners`), and that key wins over the resource key. Use it when a route's permission resource differs from its path resource.
- P5-6 openapi also has `getRole`/`getGroup` (the contract listed the paths but not the operationIds) and a separate `GroupCreateInput` (name required).
- P5-7 Web design system (ui-components rule 9): `designSystemTokens`, `createDesignSystemTheme` and `DesignSystemScope`. The accent is resolved through `resolveBrandAccent` (new `fallbackColor` argument), then brought to 4.5:1 against `pageBg`, because axe failed teal links on the page background. The Users and Support access pages keep the old theme inside the new admin rail. Sora is named but not loaded, like Inter: the app loads no web fonts.
- P5-8 The web socket client now applies an envelope with the same `seq` as the stream cursor (only below-cursor ones are dropped; duplicates are caught by id). The gateway emits `access.revoked` with the `access.changed` seq, so before this change the client dropped every revocation.
- P5-9 The admin area (`AdminLayout` and its pages) is its own lazy chunk inside the workspace. Loading it eagerly pushed the workspace chunk's cold import past the 10 s area-test timeout in the full parallel run.
- P5-10 `useAccessChangeRefetch` (auth.ts) was replaced by `useAccessChanges`/`useAccessRevoked` (data/access.ts). `roleKeys`/`useRoles` moved from users.ts to roles.ts.

| task | agent | commit | notes |
|------|-------|--------|-------|
| T103–T118 | inline | 22fcbc0..0bd0092 | tickets/messages/attachments migration, state machine, router, customer conversation service + controller, staff replies/notes, typing/presence, offline-reply email, file storage (local+S3), uploads, ClamAV scan job, signed downloads, openapi merge + client regen, dev seed |
| T119–T126 | inline | 60cf57d..3dafe53 | state-machine unit tests, router branch tests, customer API tests, concurrency (50 parallel sends), staff message tests, attachment tests, realtime conversation tests, cross-tenant ticket/message/attachment fixtures |
| T127–T129 | inline | 5ad7d2b, 8d00454, 951fba2, 37ddfc7 (+d2b860e fix) | chat components, ChatPage/ProfileSheet, realtime client signals, conversation/attachments data hooks |
| T130–T132 | inline | a1e2cda, d40cd55, fa1c9a0, 48c6400 (+3c5e545, f80055e fixes) | chat component tests, customer-chat e2e (desktop+mobile), customer guide + developer doc |
| T066 follow-up | inline | 97c3cb2 | `USER_HISTORY_CHECKS` now has a real provider (tickets/messages exist); test checks user delete against real history |

| T091 | inline | 0ac1d6e | live-checked on dev: every 4xx path, audit rows (`role.*`, `permission.changed`, `group_access.changed`), outbox `role.updated` + `access.changed` |
| T092 | inline | 72c0593 | live-checked: Admin-only access on create, case-insensitive 409, eligible owners 200/404 per caller, cross-tenant 404s |
| T093 | inline | 3776ee6, 7477e50 | merge script recreated in the scratchpad; redocly valid (22 warnings as before); client regenerated |
| T094 | inline | 4ef5101, 735cfe8 | refactor to pure rules first, then 13 unit tests |
| T095 | inline | 1052241, 95163c8 | 21 tests including SC-014 (a registry key added at run time goes to Admin only, in every tenant) |
| T096 | inline | 11f66ba, 0a22d43 | revocation measured under 2 s; room membership observed by delivery; `beforeAll` waits for the relay backlog left by files without a worker |
| T097 | inline | 96ef433, 574e76b | design-system theme + builders |
| T098 | inline | 5e3209b | pages |
| T099 | inline | 556c0a1, 86ac81a | equal-seq fix + hooks |
| T100 | inline | 7e5c587 | admin shell, lazy chunk |
| T101 | inline | 555c406, d2427a1 | 13 builder/layout tests, plus 7 page tests (not in the task text; added for coverage) |
| T102 | documentator + dev-documentator (sonnet) | 7d923c4, 9f91e6c | reviewed inline; overstated claims removed; dead link replaced |

### Phase 5 complete (T091–T102) 2026-09-26
- `turbo run lint typecheck test` 8/8 green; api 311 tests (37 files), web 141 tests (22 files). Coverage: api 91.09% lines, web 84.83% (gate 80/70). E2E 8/8 on desktop and mobile after re-seeding. Docs build passes (8 pages). redocly valid.
- Chrome live check not possible: the extension refuses scripted cookies and credentials aren't typed into the browser. A temporary Playwright walkthrough (not committed) signed in, screenshotted roles, role editor, Admin (locked), groups and the group dialog on both projects, and ran axe on each. It found and fixed an active-rail contrast failure, teal links on the page background, 24 px radii (sx radius multiplies the 8 px base), a black rail border (a responsive shorthand reset the color) and a mobile page overflow (a `VisuallyHidden` span escaping the table scroller; the table containers are `position: relative` now).
- Reviewer: PASS, no critical or major findings. Minor: RoleEditorPage runs its own submit/error cycle because `Form` has no confirm-before-submit hook; extend `Form` with one before the next confirm-then-save form. The reviewer also saw one timing flake in role-pages.test.tsx under the full parallel run; it passed on the rerun and alone.
- Follow-ups: the developer doc's Mermaid diagram renders as a code block (Starlight has no Mermaid plugin); load Sora and Inter when the retheme task lands.

### Phase 6 complete (T103–T132, T066 follow-up) 2026-09-26 (reconstructed from git log; no prior run-log entry)
- Tickets/messages/attachments schema, state machine, customer message router with per-customer locking, customer conversation + projection (public-only), staff replies/notes, presence/typing, offline-reply email, file storage (local + S3), ClamAV scan, signed downloads; openapi merged and client regenerated; dev seed extended (globex ticket, resolved acme conversation).
- Tests added alongside: unit (state machine, router branches), integration (customer API, staff messages, attachments), concurrency (50 parallel sends / 10 repeated `clientMessageId`s → 40 messages, one ticket), realtime (echo, typing, no leaking fields), cross-tenant fixtures for ticket/message/attachment (including download).
- Frontend: chat components (thread/bubble/composer/resolved marker/status/typing), `ChatPage`/`ProfileSheet`, `data/conversation.ts` + `data/attachments.ts`, realtime client extended with ephemeral signals/typing/cursor seeding; component tests + customer-chat e2e (desktop and mobile) + customer guide + developer doc (conversation routing).
- Fixes landed in-task: read receipts compared against the stored row (T109), signed-out customers return to sign-in (T128), chat timestamps/failed bubbles kept at contrast (T131).
- Follow-up landed after the story: `USER_HISTORY_CHECKS` (Phase 3 follow-up) now has a real provider since tickets/messages exist; a test (T066) confirms user delete is blocked by real ticket history.
- No explicit reviewer PASS commit found in git log for this phase (reviewer runs are not committed); full suite/coverage/e2e state at Phase 6 end not recorded separately — verify at Phase 7's own checkpoint.
- Since Phase 6, `.claude/agents/*.md`, `.claude/skills/ui-components/SKILL.md` and `CLAUDE.md` were edited by the user (uncommitted) and `docs/design-system/` was added (uncommitted, untracked): these are the ui-components skill's new Phase 5+ design-system pointer. Not part of any task; left untouched.

### Resume notes (Phase 7) 2026-09-26
- User scope: run Phase 7 (US6, T133–T158) through to a reviewer PASS, then stop for approval.
- No Jira tracking (removed from the orchestrator workflow in 7f369ba).
- Checks: `docker compose run --rm -T tools bash -c 'set -o pipefail; pnpm turbo run lint typecheck test --continue'`; coverage `./scripts/check-coverage.sh`; e2e `docker compose --profile e2e run --rm -T playwright bash -c 'cd /repo && pnpm --filter web exec playwright test e2e/'` after `pnpm --filter api seed:dev`. `docker compose restart api worker` after backend changes, `restart web` after frontend changes.
- Merge script for openapi (T145 needs it): scratchpad `merge-openapi.js`, run `docker compose run --rm -T -e PLAN='<json>' tools node - < merge-openapi.js`; not in the repo — recreate if the scratchpad is gone (see the Phase 5 recreation at 3776ee6).
- T151–T154 (frontend): tell frontend-agent to follow `docs/design-system/` (uncommitted user addition) per the updated `ui-components` skill, for any Phase 5+ screen. Do not stage/commit `docs/design-system/` or the edited agent/skill/CLAUDE.md files — they are the user's own uncommitted changes, out of scope for this run.
- docs-style skill is still `planned`; create it via skill-writer before T158 (agent guide) if not done by then.

### Phase 7 complete (T133–T158) 2026-09-27
- All 26 tasks committed and marked `[X]` (645e3e2..19ac63d). Resumed on 2026-09-27 with an unfinished T151 focus fix in the working tree: a list no longer pulls focus back after focus really left it (blur to empty space), told apart from a removal-caused blur by `isConnected` on the blurred row (ec89f94, test 4c1fa76).
- Checkpoint: `turbo run lint typecheck test` 8/8 green (api 53 files, web 39 files); coverage api 90.3% / web 78.26% lines (gate 80/70); e2e 12/12 on desktop, mobile and the chat/agent projects. The first e2e run failed 2 specs because Vite was still cold after `restart web`; the rerun passed. Web coverage fell from 84.8% (Phase 5) to 78.3% with the workspace pages; still above the gate.
- Reviewer: PASS. One major, fixed: a group move that named no owner kept an owner who couldn't edit the destination (FR-040); the move now unassigns them with history (004f1a1, test 19ac63d). Warnings left as they are: `message.moved` has no customer projection on purpose (the customer's thread isn't ticket-scoped, so nothing they see changes); the sweeper takes at most 200 due tickets per tenant per 30 s tick, so a larger backlog drains at about 400/min.
- Reviewer didn't trace line by line: view visibility rules (covered by T148's tests), the selector bodies (the server enforces eligibility), the T158 guide and the T157 spec body.
- Jira: still skipped. CLAUDE.md still says to track work in Jira, but 7f369ba removed it from the workflow; flagged to the user.

### Phase 8 decisions (2026-09-27)
- P8-1 View counts (`views/view-counts.service.ts`): one Redis hash per viewer (`t:{tenant}:view-counts:{userId}`) holding every view's count plus the access version it was computed under (a version change is a miss, nothing to delete), 30 s TTL. `GET /views` and `GET /views/counts` share it. "Which views can this viewer see" now lives in `view-visibility.ts` (`visibleViews`, `canSeeView`, `viewerIdOf`) for the api and the worker.
- P8-2 Count hints (`views/counts-notifier.ts`, worker consumer `view-counts` on the `notifications` queue): ticket list events → active staff with view on the groups in the event's `tickets:group:*` streams (`AccessRepository.groupViewerIds`), `access.changed` → every active staff user. The cache is dropped at once; hints are one per viewer per 500 ms window: the first in a window is appended in the consumer's own transaction (durable, replayed by `sync`), later ones in the window schedule one trailing hint in-process. The web client refetches counts every 60 s as the backstop for a trailing hint lost to a crash (reviewer major, fixed).
- P8-3 `PUT /views/order` / `DELETE /views/{id}` are `view.view` routes; the service decides per view: a personal view is its owner's, a shared one (default views included) needs `view.edit` (arrange) / `view.delete` (delete). Position and hidden belong to the view, so arranging a shared view does it for everyone. Default views: 409 `SYSTEM_VIEW` on delete.
- P8-4 Notifications mapping (`notifications/notifications.consumer.ts` header table). `my_ticket_changed` comes from `ticket.state_changed`, a priority change in `ticket.updated` (skipped when the same change also assigns: `assigned_to_me` covers it) and a customer-caused `ticket.reopened`. Customer messages on an unassigned ticket add nothing until support's first reply (research D20 updated; reviewer asked to confirm with product). Ticket subscriptions don't exist yet, so they add nobody. SLA events have no source until US12.
- P8-5 `@StaffApi()` now also covers `/notifications` and `/notification-preferences` (route-audit.ts): every handler takes the user from the session only. `POST /notification-preferences/push-subscriptions` is left for US15.
- P8-6 Tenant defaults: `NotificationDefaultsContributor` writes the built-in defaults into `tenant_settings.notification_defaults` for new tenants; older tenants keep `{}`, which resolves to the same defaults.
- P8-7 Queue consumers must read access with `PolicyService.effectiveAccessIn(ctx, tx, userId)`, never `effectiveAccess` (which opens a second unit of work, i.e. a second pool connection). With 5 jobs per queue and a 10-connection pool, jobs holding one connection and waiting for another stalled the worker; in the test suite this showed as 120 s `afterAll` timeouts (fb4f490).
- P8-8 Web: `useNotificationEvents` (cache) is mounted once in DeskLayout; `useNotificationArrivals` is listen-only for LiveRegion announcements. The unread badge is set only from real fetches and events, never copied back from cached pages (a live bump was being reset to 0, found by T172). `ticket.removed_from_view` with reason `moved` refetches lists and only closes an open ticket after a 404, since staff who can see both groups get the old room's event too (found by T172; T155 fix).

| task | agent | commit | notes |
|------|-------|--------|-------|
| T159 | inline | fc5b9d9 (+dc707e5) | live-checked: 12 views for admin, 11 for agent (no Needs Triage); an assignment gave each viewer one hint and refreshed counts |
| T160 | inline | 5f1ac21 | live-checked: agent 403, admin 204, duplicate ids 400, default view 409 SYSTEM_VIEW, unknown 404 |
| T161 | inline | 1102001 | applied on dev |
| T162 | inline | 80d3a91 | |
| T163 | inline | 02cc698 (+fb4f490) | live-checked assign → assigned + priority notifications on the user stream |
| T164 | inline | 20b5460 | live-checked list, mark-all-read, validation 400s |
| T165 | inline | c45f4df, 863d8b3 | splice-merge script in the scratchpad (`merge-openapi-p8.cjs`, text insertion so existing formatting is untouched); redocly valid, no warnings on new paths |
| T166 | test-automator | e621dff (+add4b8e) | 25 cases |
| T167 | test-automator | 47cff0b | 7 cases; the generated cross-tenant suite now covers the two notification GET routes; `POST /notifications/read` (ids in the body) has a hand-written cross-tenant case |
| T168 | test-automator + inline | f5f823d | hardened: listen before probing, drain hints until quiet, burst asserts fewer hints than changes; 5/5 stable |
| T169 | frontend-agent + inline | a73e229, b20d074 | |
| T170 | frontend-agent + inline | 70d6224, fa56ace | inline fixes: arrange buttons use `aria-disabled` (focus stays), neighbour must be editable to swap, save errors announced, banner only after a real drop, banner text contrast |
| T171 | frontend-connector + inline | f5c0053, f535001 (+ae803bb, 17df773) | |
| T172 | inline | 846b09a, fec823f | own `desktop-realtime` project after the agent projects; offline = context offline + `routeWebSocket` closing the socket |
| T173 | documentator + inline | b965f3b | build verified inline |

### Phase 8 complete (T159–T173) 2026-09-27
- Checkpoint: `turbo run lint typecheck test` 8/8 green (api 56 files / 723 tests, web 44 files / 248 tests); coverage api 91.19% / web 78.93% lines (gate 80/70); e2e 13/13 (desktop, mobile, chat, agent, realtime projects; the first run after `restart web` failed the same two cold-start specs as Phase 7, the rerun passed); redocly valid; docs build passes (12 pages).
- Reviewer: PASS. One major (a count hint lost if the worker crashed inside the 500 ms window), fixed (P8-2). Warnings: the before-first-reply rule was undocumented (now in research D20; product question left to the user).
- Also fixed during the checkpoint: the pool exhaustion above (P8-7), a support-token test that tampered the last base64url character (sometimes a no-op, c8b233d), and the route-audit message test.
- Reviewer didn't read: NotificationsPage, the DeskLayout wiring, the web test assertions in detail, realtime.spec.ts, the `moved` change in data/tickets.ts, the guide.
- Follow-ups: a cross-tenant check for body-keyed routes like `POST /notifications/read` isn't generated (non-GET routes without path ids are skipped by the suite); add a hand-written case for each new one. The inline RoleEditorPage `Form` confirm hook from Phase 5 is still open.

### Stopped here 2026-09-27
- User scope (finish Phase 7, run Phase 8) done. Next is Phase 9 (US5, T174+).

### Resume notes (Phase 9) 2026-09-29
- User scope: continue where we left off and stop after the next phase; then, while the Phase 9 checkpoint ran, "continue with the next phase" (Phase 10).
- Jira still skipped: the Atlassian MCP server failed to connect this session (and 7f369ba removed it from the workflow). Flagged to the user again.
- Docker Desktop was not running; started it from `%LOCALAPPDATA%\Programs\DockerDesktop`. The host has no pnpm or python: run `scripts/check-coverage.sh` inside the tools container. The dev API is `http://acme.localhost:3000/api/v1`; its cookies are `Secure`, so curl over http must pass them as a header (scratchpad `live/lib.sh`).

### Phase 9 decisions (2026-09-29)
- P9-1 Triage (`tickets/triage.service.ts`) reuses `TicketsService.applyLocked`, the locked-update half of `update` (split out, a368a60). Order of checks: row lock; a ticket already in a group the caller can't see is 404; one they can see is 409 `ALREADY_TRIAGED` with edit on Ungrouped, else 403; an ungrouped ticket needs view (404) and edit (403) on Ungrouped.
- P9-2 A race lost to a triage into a group the loser can't see answers the unknown-ticket 404, never `ALREADY_TRIAGED` (reviewer major: a history-based 409 confirmed tickets to users who had never had access). The web hook turns a triage 404 into `{ visibleToCaller: false, alreadyTriaged: true }`; the bar announces "Someone else already triaged this ticket." and closes the ticket.
- P9-3 An unknown destination group is 404 `GROUP_NOT_FOUND` (was 409 `GROUP_INACTIVE`), for `PATCH /tickets/{id}` too.
- P9-4 User decision: `GET /groups/destinations` (`ticket.edit`; active groups' id and name only). Manager and Agent defaults have no `group.view` (data-model role table), so the desk pickers (TriageBar, TicketFocus, NewTicketDialog) were empty for them; `GET /groups` also returns `openTicketCount`, which they shouldn't see. Admin pages keep `GET /groups`.
- P9-5 While the triage bar shows (ungrouped + `change_group`), the ticket strip hides its priority, group, owner, "Assign to me" and tags controls. The agent-flow e2e now triages its ticket to Support before assigning it.
- P9-6 TriageBar shortcuts: `G`/`O` focus Group/Owner when not typing; `Enter` assigns only from its own Group/Owner input with the listbox closed (it used to fire from anywhere once a group was picked, e.g. on a focused list row). The listener is in the capture phase so the check sees the listbox as it was before Autocomplete handles the key; e2e passed with and without that, so it is hardening, not a proven fix.

| task | agent | commit | notes |
|------|-------|--------|-------|
| T174 | inline | a368a60, c273e60, 504deac, b034888, ae2e47c | live-checked on dev: 404 without Ungrouped, 409 OWNER_NOT_ELIGIBLE, 404 unknown group, 200 `visibleToCaller:false`, 409 on retry; history + events + notifications |
| T175 | inline | 5c6d539, 238088c, be34282, 5987f8d | hand-inserted into openapi.yaml; redocly valid |
| T176 | test-automator + inline | 3510de0, 723f36b | 11 cases; cross-tenant suite 51/51 (fixture body for the triage route); race tests stable over 3 reruns |
| T177 | frontend-agent + inline | f2844c7, 3eb9c9a, 70cb789, 8a755aa, 92b1aae, bb4caee, 3c0d225, 58d033b, b540c9f | inline fixes: Enter scope, duplicate strip controls, destinations endpoint (P9-4) |
| T178 | frontend-connector + inline | 60d7039, ee18d3b, acde090 | 404-as-lost-race handling (P9-2) added inline |
| T179 | frontend-automator + inline | 59320ec, f32550f | own `desktop-triage` project after `desktop-realtime`; 4 sign-ins for the whole spec; the agent found the empty group list and the duplicate Owner control |
| T180 | documentator + inline | 839e9d9, db3915f | build passes (13 pages) |

### Phase 9 complete (T174–T180) 2026-09-29
- Checkpoint: api 57 files / 737 tests; coverage api 91.24% / web 79.43% lines (gate 80/70); web 46 files / 261 tests when run alone. In the turbo run the web tests failed once while the api suite loaded the machine (the known `areas.test.tsx` 10 s lazy-load wait); passes alone. E2E 14/14 on the second run (first run after `restart web`: the usual 3 cold-start desktop failures). redocly valid; docs build passes.
- Reviewer: PASS. Major fixed (P9-2). Warnings fixed: direct tests for the invisible-destination race and the grouped-ticket 403; the refetch after `ALREADY_TRIAGED` no longer leaves an unhandled rejection.
- Reviewer didn't read: TicketFocus beyond the diff, NewTicketDialog and fixture diffs, generated client, `allowedActions`, repository internals, the docs sidebar.
- Follow-ups: `areas.test.tsx`'s 10 s lazy wait is tight under full parallel load; the e2e after the P9-2 fixes was not rerun separately (covered by the Phase 10 checkpoint).

### Resume notes (Phase 10) 2026-09-30
- User scope: "analyse and continue from the current phase". Phase 10 (US7) had T187 (settings page half), T189 and T190 open; T179 was committed (59320ec, f32550f) but never ticked, now ticked. T183's two test files (`contrast.test.ts`, `settings.test.ts`) were left uncommitted by the last session; 24/24 pass, committed as 85e03f1 and 7da55b9.
- User's uncommitted edits (agent models → sonnet, ui-components rule 9 for `docs/design-system`, CLAUDE.md catalog line, `docs/design-system/`) are left alone. The settings page follows rule 9 through the existing `DesignSystemScope` (T097).
- Jira: the Atlassian connector needs interactive authentication this session; still skipped (7f369ba removed it from the workflow).

- T187 b18fea7, 18b71ad (frontend-agent; no logo or accent control yet: no upload flow). T190 e5a79ca (documentator; docs build verified inline, 14 pages).
- User: "start the next phase, if there is no dependency on the current test". Phase 11 doesn't depend on T189's spec. The shared dev stack does: edits don't hot-reload it (restarts are manual), so backend agents run Testcontainers tests only, with no restart, seed or dev migration until T189 finishes. T191+T192 and T193 run in parallel. T194 (openapi) comes after both. T197/T198 (web) wait for T189.

### Phase 10/11 decisions (2026-09-30)
- P10-1 The T189 e2e advances the clock by writing the `dev:advance-clock` Valkey key straight from the playwright container (`e2e/dev-clock.ts`) and resets it in `finally`. The 73 h jump expires staff sessions (12 h idle), so the spec signs the admin in again. Customer sessions (trusted device, 30 days) survive.
- P10-2 User decision: agents get @mention candidates from a new narrow endpoint (active staff id, name and avatar; no `user.view`), as P9-4 did with `/groups/destinations`. Until then the main-flow e2e posts the note through the API with `mentionIds`. Scheduled after T194 so the two don't both edit openapi.yaml.
- P10-3 User decision: quickstart step 6 mentions the admin, not the manager (the seeded Manager has no Support access, so FR-081 blocks the notification). Done in cb48371.
- P10-4 In the full e2e run, `sign-in.spec.ts` "an invited agent accepts, signs in and signs out everywhere" fails on desktop and mobile. It passes alone and failed the same way on the HEAD playwright config. Suspected cause: `tenant-lifecycle.spec.ts` running in parallel (503 "workspace unavailable" on sign-in). Must be green before T189 is ticked.
- P11-1 T192 lands with the `audit_log` cross-tenant fixture (tasks.md had it under T195), so the generated suite stays green.
- P11-2 T193 adds a `replyx_retention` role (0012). It has DELETE on `audit_logs` only and stays under RLS. It is NOLOGIN without `REPLYX_RETENTION_PASSWORD`. Existing databases, dev included, need `infra/postgres/init.sql` re-run (idempotent) plus `DATABASE_URL_RETENTION` in `.env` before migration 0012 runs.

- P10-4 resolved: the cause was the 10/min per-IP sign-in limit (the invitation accept got a 429 while tenant-lifecycle ran in the same first phase), not a shared tenant. tenant-lifecycle now runs in its own desktop/mobile projects after the sign-in specs (e880d8a). Full e2e 15/15.
- P11-3 Updating the dev stack for 0012 (`.env` retention lines, re-running init.sql, restart) was refused by the permission classifier. The user was asked to run it. Until then the dev api/worker must not be restarted, since the migration would fail.
- Commits: T191 3de3008; T192 030b8fa, 6fb0788; T193 335fec2, 0c02e76, 3461f6b; T194 d29c5ac, 1dfe8b1, 1e1b881 (web fixtures fixed inline); T189 27f068e, fd90100, e880d8a.

- Phase 10 review round 1: FAIL.
  - Critical: resolution.test.ts times out when it runs after auto-close-race (order dependence).
  - Majors:
    - the auto-close race never races (a frozen clock sets autoCloseAt = now);
    - Save stays dirty after the API normalizes a value;
    - the contrast announcement is untested.
  - Warnings and minors: live resolved/idle status vs reload; logoAttachmentId unchecked; suggestion margin; the e2e 73 h clock jump is hard-coded, resetClock cleanup, the negative mail check runs too early; BrandPreview px literals; read-only flash while /me loads; double alert; TicketFocus resolve has no catch; no FOR UPDATE on the settings merge.
  - Routing: test-automator (1, 2), frontend-agent (3, 4, 11-14, 16), backend-agent (5-7, 15), frontend-automator (8-10).

- Phase 10 review API fixes:
  - faca667: contrast suggestion aims at 4.6.
  - eb3b677: FOR UPDATE on the settings row; a non-null logoAttachmentId gets 400 `not_supported` until US16.
  - e5e89a2: openapi descriptions.
  - 336cbd4: the resolve event sends the status a reload would show; only resolved tickets get a marker. The `closed_at` fallback is dropped, so a pending_close swept to closed shows no marker.
- Commits: T195 5b749d0; T196 8bb7c14; T198 c5411f0, 4abf2ee, e4b5049; T197 (audit page) 6d79ba8, 708e413.
- Audit page choices (agent defaults, accepted):
  - the actor filter is a text id, since `useUsers` needs user.view;
  - filters live in component state, as on the other admin pages;
  - times use `toLocaleString`, since nothing formats in the tenant timezone yet.

- P10-2 done:
  - API 94aa487, openapi 1c5a1a0, client 2c9e2ab; web part pending.
  - The endpoint is `GET /tickets/{id}/mention-candidates` (ticket.edit on the group; active staff who can view it; id, name, avatar; ≤ 20).
  - The POST doesn't check that mentioned users can view the ticket, but `recipient-resolver.ts` filters mention notifications by `canView`, so FR-081 holds.
  - Follow-up: TicketFocus history names no longer come from `useUsers`, so a former owner not in the candidates shows as "Unknown user". This needs names in the history payload.
- Incident: a running agent ran `git stash` on the shared tree (27 real files, plus CRLF churn), so 94aa487 first landed with only its test file. The stash was restored and the commit amended (local, unpushed). All running agents were told not to change git state.
- T189 review fixes: e501875.

### Phase 10 complete (T181–T190) 2026-09-30
- Review round 2: PASS. All 16 round-1 findings fixed:
  - 63e47e1, b9b7520, 318a548 (tests);
  - 4b6de18, b7270ad (web);
  - 336cbd4, faca667, eb3b677, e5e89a2 (api);
  - e501875 (e2e).
- Round-2 minors:
  - JSDoc fixed (65e9ee7);
  - the race mix isn't asserted (accepted);
  - history names for former owners (logged follow-up).
- Warning: the organization-settings axe test hits the 20 s default timeout in the container. The fix agent says this predates the fixes (NewTicketDialog too); passes with `--testTimeout=90000`. To be settled at the checkpoint.
- Mention web: eb448f1. Follow-ups: other TicketFocus selectors still `void mutateAsync` without catch; the settings page load error isn't mapped.

### Phase 11 review (2026-09-30)
- Full API suite 68 files / 820 tests; web 50 / 302; lint and typecheck clean both.
- Reviewer: PASS, no critical findings. Majors M1 and M2 are fixed now rather than deferred, because both mean irreversible, unrecorded audit loss:
  - M1: shortening auditRetention has no confirmation;
  - M2: a partial audit purge isn't recorded.
- Warnings:
  - W1: the dialog should say "at least N, at the next daily run";
  - W2: a load-more failure replaces the audit list;
  - W3: the api container gets DATABASE_URL_RETENTION;
  - W4: the cold-start axe timeout;
  - W5: files are deleted before the rows commit (privacy-safe; to document);
  - W6: retention role and rollback tests.
- Minors m1–m4 are logged: `now()` vs `clock_timestamp()` for occurred_at; raw Modal plus double error announcement; the composer filters by substring while the server matches a prefix, and mention errors are ignored; the mention SQL duplicates `decide`.
- Routing: backend-agent (M1 API, M2, W3, W6 in part), frontend-agent (W2 now; then the M1 dialog, W1 and W4 once the contract lands), documentator (W5).

- Phase 11 fixes:
  - API 0430050, 245dad5, acba5f5, fe0e94e, bd9ddba, 667607e;
  - web 9cd4d56, 5d6a497, 638ec59, 88d4f07;
  - docs 5b847fb.
- Re-review: PASS (two tolerable minors).
- M1 contract: 409 `AUDIT_RETENTION_CONFIRMATION_REQUIRED` until `confirmAuditPurgeCount` matches. When both periods shorten, the ticket confirmation comes first, one 409 per request.
- Checkpoint:
  - The web coverage gate first failed on `areas.test.tsx`, the Phase 9 10 s lazy wait, now slower under coverage instrumentation with the bigger admin chunk. The wait is now 30 s in a 60 s describe (this commit). Web 318 tests, 80.56% lines.
  - API coverage 91.44% lines (829 tests). One run failed once on catch-up.test.ts SC-002 "count hints … once for a burst" (it passes 3/3 alone): a flake under load, logged. The re-run is green (69 files / 829).

### Phase 11 status (T191–T199) 2026-09-30
- All tasks ticked. Reviewer PASS (both rounds). Coverage green: api 91.44% / web 80.56% lines. Docs build passes (15 pages); redocly valid.
- Dev stack updated for 0012: the `.env` retention lines, postgres recreated, `init.sql` re-run (by the orchestrator, with user approval). The user ran `migrate` (0012 applied) and restarted api and worker after the classifier refused that step. Then `seed:dev` and a web restart.
- E2E on the Phase 11 code: 15/15 (5.4 min) on the fourth run. The earlier failures were:
  - run 1: `docker compose run playwright` recreated api mid-run, because acba5f5 changed api's compose config; the first specs hit a compiling API;
  - run 2: a timing-dependent `toHaveURL(/\/desk$/)` missed the redirect to `/desk/inbox/<view>`; fixed in all four places (b7eea47);
  - run 3: a 429 on invitation accept after back-to-back runs used up the per-IP sign-in budget.
- Quickstart validation scenarios: covered by suites that passed today (cross-tenant and RLS in the full API suite, concurrency, and the realtime and main-flow e2e). Not re-walked by hand: attachments with `--profile scan` and the support-access flow (their integration tests pass).
- 🎯 MVP (all P1 stories, Phases 3–11) complete. Next is Phase 12 (deploy to the VM, T200–T206).
- Open follow-ups:
  - TicketFocus history names for former owners;
  - other TicketFocus selectors don't catch mutation errors;
  - the settings page load error isn't mapped;
  - composer substring vs server prefix match, and mention errors are ignored;
  - `occurred_at` uses `now()`;
  - the catch-up SC-002 flake under load;
  - the auto-close race mix isn't asserted.
- Jira: still skipped (the connector needs sign-in).

### Resume notes (Phase 4) 2026-09-25
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

