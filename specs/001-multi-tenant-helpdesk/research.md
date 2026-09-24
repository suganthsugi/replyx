# Research & Decisions: Multi-Tenant Customer Support Platform

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Date**: 2026-09-24

Each decision records what was chosen, why, and what was rejected. Where the plan input left
something open, the simplest production-ready option was chosen (constitution principle VIII).

---

## D1. Technology stack and repository layout

**Decision**: A pnpm + Turborepo monorepo on Node.js 24 LTS and TypeScript 5 (strict).

| Area | Choice |
|------|--------|
| API and workers | NestJS 11 (`apps/api`), one codebase started in two process roles: `api` (HTTP + WebSocket) and `worker` (jobs, outbox relay, sweepers) |
| Database | PostgreSQL 17 |
| Data access | Kysely (type-safe SQL query builder) + SQL migrations in `apps/api/migrations/` |
| Cache, pub/sub, queues | Redis-compatible store (Redis 7 / Valkey 8) |
| Jobs | BullMQ |
| Real-time | Socket.IO 4 with the Redis adapter |
| File storage | Attachments on a Docker volume behind a `FileStorage` interface; S3-compatible adapter optional (D17) |
| Email | SMTP via Nodemailer: an external SMTP relay in production, Mailpit in development |
| Runtime | Docker Compose everywhere: development (D26) and production on the owner's VM (D24) |
| Reverse proxy / TLS | Caddy (automatic HTTPS) |
| Web app | Vite + React 19 + TypeScript (`apps/web`), MUI 7 with a custom theme, TanStack Query 5, React Router 7, socket.io-client |
| API client | orval, generated from `apps/api/openapi.yaml` into `apps/web/src/api/generated/` |
| Docs | Astro Starlight (`apps/docs`) |
| Tests | Vitest, Supertest, Testcontainers (API); Vitest, React Testing Library, MSW (web); Playwright (e2e) |

**Rationale**: The plan input left the stack blank. The repository already commits to this stack
through its agents (`.claude/agents/*`), CI (`.github/workflows/ci.yml` expects turbo, orval and
coverage gates for `apps/api` and `apps/web`) and scripts (`scripts/generate-api-client.sh`,
`scripts/check-coverage.sh`). Choosing anything else would invalidate that tooling. Every piece is
mainstream and well understood (principle VIII).

**Existing code**: The repository root currently holds an unrelated Next.js prototype
("ticket-classifier": `src/`, `next.config.ts`, root `package.json`). It is not part of this
product. The scaffold task moves it out of the way (to its own branch or an `archive/` tag) and
turns the root into the workspace root. The root CLAUDE.md/AGENTS.md "NOT the Next.js you know"
block only applies to that prototype and can be dropped with it.

**Alternatives considered**:
- Rails API: productive, but conflicts with the repo's TypeScript tooling and shared types.
- Next.js full-stack: blurs the API boundary that principle IX and the orval workflow depend on,
  and long-lived WebSockets and workers fit poorly in its server model.
- Prisma / TypeORM: Prisma makes per-transaction `SET LOCAL` for row-level security and
  dynamic, compiled view queries awkward; TypeORM's entity model encourages exposing storage
  models. Kysely keeps SQL explicit and typed. Drizzle was a close second.

---

## D2. Tenant resolution

**Decision**: Each tenant is served from its own subdomain: `{slug}.replyx.app` (locally
`{slug}.localhost`). The platform-operator console lives on `console.replyx.app`.

- The request pipeline resolves the tenant from the `Host` header, then checks that the session
  belongs to that tenant. A mismatch is treated as unauthenticated.
- Session cookies are host-only (no `Domain` attribute), so a cookie for one tenant is never sent
  to another tenant's host.
- Slugs: 3–40 characters, lowercase letters, digits and hyphens, with a reserved list
  (`console`, `api`, `www`, `admin`, `static`, ...).

**Rationale**: Host-only cookies give isolation at the browser level for free, and URLs look
native to each tenant.

**Alternatives considered**: Path prefix (`/t/{slug}`) shares one cookie jar across tenants, so
one browser session could carry another tenant's cookie into the wrong context. It is simpler for
DNS, but weaker. Custom domains per tenant are future work; the resolver supports adding a
`tenant_domains` lookup later.

**Trade-off**: Needs a wildcard DNS record pointing at the VM. Certificates are issued per
subdomain on demand by Caddy (D24), so no wildcard certificate or DNS API access is needed.

---

## D3. Tenancy strategy and row-level security

**Decision**: One database, shared schema, `tenant_id` on every tenant-owned table, enforced in
two layers:

1. **Application layer (primary)**: all data access goes through tenant-scoped repositories that
   receive a `TenantContext` object. A repository cannot be constructed without one, and every
   query they build adds `tenant_id = :tenantId`.
2. **Database layer (defense in depth)**: PostgreSQL row-level security (RLS) is enabled and
   *forced* on every tenant-owned table, with the policy
   `tenant_id = current_setting('app.tenant_id')::uuid`. The application connects as a
   non-owner role (`replyx_app`) that cannot bypass RLS. Each unit of work runs in a transaction
   that first runs `SET LOCAL app.tenant_id = ...`. Without it, the policy matches no rows.
3. Global tables (`tenants`, `platform_operators`, `permission_definitions`) have no RLS.
   Migrations and the platform console use a separate role (`replyx_platform`) that only reads
   and writes those global tables. Support-access reads (FR-001a) run under the normal app role
   with the tenant's context set and a read-only transaction (`SET TRANSACTION READ ONLY`).

**Rationale**: The constitution (principle I) requires enforcement in the data-access layer and
asks for database isolation as defense in depth where practical. It is practical here: the
per-transaction setting is cheap and works with connection pooling because `SET LOCAL` ends with
the transaction.

**Alternatives considered**: A schema or database per tenant gives stronger isolation, but makes
migrations and cross-tenant operations (platform metrics, the outbox relay) heavy at thousands of
tenants. RLS alone, without scoped repositories, would make every missed context a silent empty
result instead of a loud programming error.

**Trade-off**: Every query must run inside a transaction with the context set. The unit-of-work
helper makes that the only way to get a query handle. Background jobs carry `tenantId` in their
payload and open the same unit of work.

---

## D4. Ticket numbers

**Decision**: A `tenant_counters (tenant_id, name, value)` row per tenant, incremented with
`UPDATE ... SET value = value + 1 RETURNING value` inside the ticket-creating transaction.
Numbers start at 1001.

**Rationale**: The row lock serializes creation per tenant only, so numbers have no gaps and no
duplicates, even under concurrency. Expected load (well under 10 new tickets per second per
tenant) is far below the point where this lock would contend.

**Alternatives considered**: One PostgreSQL sequence per tenant: thousands of sequences, and
numbers skip on rollback. `MAX(number) + 1`: races.

---

## D5. Authentication and sessions

**Decision**:
- **Server-side sessions** stored in a `sessions` table. The browser holds an opaque, random
  256-bit token in an `HttpOnly; Secure; SameSite=Lax` host-only cookie. The database stores
  only a SHA-256 hash of the token. A small Redis cache (60 s) sits in front of session lookups
  and is purged on revocation.
- **Passwords**: argon2id with OWASP-recommended parameters.
- **Staff**: email + password. **Customers**: one-time email sign-in link (FR-012) with an
  optional password. Links are stored hashed, single use, valid for 15 minutes, and superseded by
  newer links. The link-request response is identical whether or not the account exists
  (FR-012a).
- **Session lifetime**: staff expire after 12 h idle; customers stay signed in for 30 days on a
  trusted device ("keep me signed in", on by default in the chat).
- **Lockout**: 5 failed password attempts in 15 minutes locks the account for 15 minutes, and
  the audit log records it.
- **"Sign out of all sessions"**, deactivation, and tenant suspension delete the session rows,
  purge the cache, and publish `session.revoked` so open sockets disconnect.
- **CSRF**: `SameSite=Lax` plus a double-submit token (`X-CSRF-Token` header must match a
  non-HttpOnly cookie) on every state-changing request.
- **Operators**: email + password on the console host. Two-factor is out of scope for this spec
  (spec, Out of scope), but the operator login is isolated so it can be added first.

**Rationale**: Server-side sessions can be revoked instantly, which the spec requires (suspension,
deactivation, sign out everywhere). Hashed tokens mean a database leak does not leak sessions.

**Alternatives considered**: Stateless JWTs cannot be revoked instantly without a denylist, which
brings back server state anyway. Third-party identity providers are out of scope (SSO is future
work).

---

## D6. Authorization: registry, policy service, access filters, cache

**Decision**:
- **Registry**: each module exports a `ModulePermissions` declaration (resources, actions,
  descriptions). On startup, the API syncs them into `permission_definitions`. Newly added
  definitions are granted to every tenant's Admin role in the same migration-like sync step and
  to no other role (FR-017). A registry test fails if a controller route has no permission
  metadata.
- **Policy service** (`authorization` module) is the only place that decides access:
  - `can(actor, action, resource)` → allow / deny / not-found.
  - `ticketAccessFilter(actor, action)` → a Kysely expression limiting tickets to groups where
    the actor's roles grant `action` (plus `group_id IS NULL` when Ungrouped is granted). List,
    view, search, count, dashboard and export queries all use this filter, so a list and a single
    read can never disagree.
- **Scopes**: `role_group_access` carries a `scope` column (`group` today; `assigned`, `own`
  later), and `role_permissions` carries the same column. Adding "only tickets assigned to me"
  later means adding a scope value and a filter branch, with no schema rewrite (FR-027).
- **Effective-access cache**: the union of a user's permissions and group access is cached in
  Redis under a key containing the tenant's `access_version`. Any change to roles, role
  permissions, group access, user roles or user status increments that version inside the same
  transaction and emits `access.changed`. Old cache entries simply stop matching.
- **Live enforcement**: the real-time gateway consumes `access.changed`, recomputes each connected
  user's access, removes subscriptions they no longer qualify for, and sends
  `access.revoked { resource }` so the client closes open screens (FR-025, SC-011 within 2 s).

**Rationale**: One path (principle II), one filter for reads and writes, and instant invalidation
without per-user bookkeeping.

**Alternatives considered**: Per-user cache invalidation (more keys, easy to miss one). A policy
engine such as OPA or Cedar: extra infrastructure that isn't needed for a role × group model.

---

## D7. Domain events and the transactional outbox

**Decision**:
- Services append domain events to `outbox_events` in the same transaction as the state change
  (principle IV: persist first, then publish).
- A single active **relay** in the worker process (leader chosen with a PostgreSQL advisory lock)
  reads unpublished rows in id order, assigns each a monotonically increasing `seq`, and then:
  - fans out to BullMQ queues for consumers (notifications, SLA, automation, webhooks, search,
    audit, analytics);
  - publishes real-time payloads via the Socket.IO Redis emitter.
- The relay wakes on `LISTEN/NOTIFY` and also polls every 500 ms as a fallback.
- Events carry `id` (UUIDv7), `seq`, `tenantId`, `type`, `occurredAt`, `actor`, `streams[]` and a
  payload. Customer-visible streams get a separately projected payload that never contains
  internal fields (see D9).
- Published events are kept for 7 days for reconnect catch-up, then pruned.

**Rationale**: Assigning `seq` at publish time by a single relay gives a gap-free, commit-ordered
cursor. Database sequence ids can become visible out of order when concurrent transactions
commit, which would make clients skip events.

**Alternatives considered**: Publishing directly after commit (loses events if the process
crashes between commit and publish). Logical replication / Debezium (heavy infrastructure).

**Trade-off**: One relay is a throughput ceiling of a few thousand events per second, far above
the expected scale. If it is ever reached, the relay can be sharded by tenant.

---

## D8. Real-time transport and reconnect catch-up

**Decision**: Socket.IO over WebSocket (long-polling fallback) with the Redis adapter so any API
instance can deliver to any socket.

- **Connect**: the handshake is authenticated with the session cookie. The host decides the
  tenant, and the session must belong to it (D2).
- **Subscribe**: every subscription goes through the policy service. Rooms are tenant-qualified:
  `t:{tenantId}:user:{userId}`, `t:{tenantId}:ticket:{ticketId}`,
  `t:{tenantId}:views:{userId}`, `t:{tenantId}:conversation:{customerId}`.
  Customers can only join their own conversation room.
- **Catch-up**: clients keep the last `seq` per stream. On reconnect they send
  `sync { stream, afterSeq }` and the server replays matching events from the outbox (filtered by
  current access). If the cursor is older than 7 days, the server returns `resync_required` and
  the client refetches over REST. Clients drop duplicates by event `id`.
- **Ephemeral signals** (typing, presence, "who is viewing", availability) go through Redis only,
  with a 30 s TTL heartbeat. They are never stored in ticket history.

**Rationale**: Socket.IO is what the repo's frontend-connector agent already assumes, and it
handles reconnect, rooms and multi-node fan-out out of the box.

**Alternatives considered**: Server-Sent Events (one-way; typing and subscriptions would need a
separate channel). Raw `ws` (would re-implement rooms, acknowledgements and reconnection).

---

## D9. Message visibility and the customer conversation model

**Decision**:
- `ticket_messages.visibility` is `public` or `internal`. Every customer-facing read goes through
  `CustomerConversationService`, whose queries include `visibility = 'public'` at the repository
  level. There is no general-purpose method that customer controllers could call.
- The customer API returns a separate DTO (`ConversationMessage`) with only public fields: no
  ticket id, number, state, group, owner, priority or SLA. Resolved markers and the friendly
  status are derived server-side.
- Customer-stream events are built by a dedicated projector. A contract test asserts that the
  projected payload schema has no internal fields, and a unit test asserts that internal notes
  never produce customer-stream events or customer notifications.

**Rationale**: Customers must never see internal ticketing concepts (principle XI, FR-049). Doing
it structurally is safer than filtering in each endpoint.

---

## D10. Customer message routing and concurrency

**Decision**: `CustomerMessageRouter.accept(customer, message, idempotencyKey)` runs in one
transaction:

1. `pg_advisory_xact_lock(hash(tenant_id, customer_id))`, which serializes all routing for that
   customer, including the auto-close sweeper (step 4 of D11 takes the same lock).
2. Idempotency: `INSERT ... ON CONFLICT (tenant_id, author_id, client_message_id) DO NOTHING`.
   A duplicate returns the originally stored message.
3. Choose the target ticket using the algorithm in [data-model.md § Conversation routing](data-model.md#conversation-routing).
4. Insert the message, update ticket state and timestamps, and append outbox events.

**Rationale**: The advisory lock is released automatically at commit or rollback, needs no extra
infrastructure, and makes "two tickets from concurrent sends" impossible (SC-006). The unique
constraint handles double taps and network retries.

**Alternatives considered**: A per-customer single-writer queue (adds latency and a moving part).
Redis locks (can expire mid-transaction; the database is the source of truth).

---

## D11. Timers: reminders, pending close, grace period, SLA, retention

**Decision**: Timer fields are stored on rows (`pending_until`, `auto_close_at`, SLA due times).
A BullMQ repeatable job runs a **sweeper** every 30 s that selects due rows with
`FOR UPDATE SKIP LOCKED` in batches, across tenants, and processes each in its own tenant-scoped
unit of work:

1. `pending reminder` due → emit `ticket.reminder_reached` (the ticket stays in pending reminder).
2. `pending close` due → close.
3. `resolved` past the grace period → close.
4. Every close takes the customer's advisory lock (D10) and re-checks the state, so a customer
   message racing an auto-close lands on exactly one ticket.
5. SLA warnings and breaches (D15). The retention purge runs daily (D18).

**Rationale**: Due times change often (state changes, SLA recomputation). Querying the database is
always correct. Delayed jobs would need cancelling and rescheduling on every change.

**Trade-off**: Up to 30 s of latency on timer events, which is acceptable for reminders, closing
and SLA warnings. Breach timestamps are computed exactly, not from the sweep time.

---

## D12. Job queue and background processing

**Decision**: BullMQ on Redis, with one queue per concern: `notifications`, `email`, `push`,
`webhooks`, `sla`, `automation`, `search-index`, `attachments`, `analytics`, `retention`,
`sweeper`.

- Every job payload includes `tenantId` and `eventId`. Handlers open a tenant-scoped unit of work
  and are idempotent: each handler records `(consumer, event_id)` in `processed_events` and skips
  events it has already processed.
- Retries: exponential backoff (5 attempts by default; webhooks follow D16). After the final
  failure, the job moves to a dead-letter queue. A metric and an alert fire when the dead-letter
  queue is not empty.
- Workers run in the `worker` process role, never inside HTTP requests (principle V).

**Alternatives considered**: pg-boss (PostgreSQL-only, one less dependency). BullMQ was chosen
because Redis is already needed for Socket.IO fan-out, presence and rate limiting, and BullMQ has
mature retry, rate-limit and monitoring support.

---

## D13. Views and counts

**Decision**:
- View conditions are stored as a JSON expression tree validated against a JSON Schema: groups
  (`and` / `or`) of `{ field, operator, value }` over a whitelist of fields and operators
  (FR-075). Relative values (`me`, `unassigned`, `ungrouped`, `within_last: P7D`) are resolved at
  query time.
- `ViewCompiler` turns the tree into a parameterized Kysely expression. The final query is always
  `tenant filter AND ticketAccessFilter(viewer, 'view') AND compiled expression`. Clients never
  send raw query text.
- **Counts**: computed with `COUNT(*)` using the same query (supported by the indexes in the data
  model), cached per (viewer, view) for 30 s, and invalidated by ticket events. The gateway
  debounces `views.counts_changed` hints (500 ms) to affected viewers, who refetch counts.

**Rationale**: Counts depend on each viewer's access, so stored counters would need one per
(viewer, view) and could drift. Event-triggered recounts are always correct and cheap at the
expected scale (≤100k tickets per tenant per year, with indexes leading on tenant, state and
group). This meets the "updated from events" requirement, and each recount is itself the
reconciliation.

**Alternatives considered**: Materialized counters updated from events plus nightly
reconciliation: more code and drift risk for no gain at this scale. Revisit if a count query
exceeds 50 ms at p95.

---

## D14. Search

**Decision**: PostgreSQL full-text search behind a `SearchService` interface:
- a `tsvector` column (`simple` configuration plus unaccent) on tickets (title) and ticket messages
  (body), with GIN indexes;
- `pg_trgm` trigram indexes for customer name, customer email and ticket number prefix;
- tags matched by exact name.

The search indexer consumes message and ticket events to update derived columns where triggers
aren't used. Results always pass through `ticketAccessFilter(viewer, 'view')`, and internal notes
are searchable only by staff (customers have no search).

**Alternatives considered**: OpenSearch or Meilisearch: extra infrastructure, and access
filtering would have to be duplicated in a second system. The interface allows switching later
(principle VIII).

---

## D15. SLA and business hours

**Decision**:
- `business_hours` holds weekly intervals and holidays in the tenant timezone. A calendar service
  built on Luxon computes "add N business minutes to a timestamp".
- `sla_policies` are ordered, and the first policy whose conditions match applies. On
  `ticket.created`, `message.created` (agent public reply or customer message), and state,
  priority or group changes, the SLA consumer recomputes `first_response_due_at`,
  `next_response_due_at`, `resolution_due_at` and the matching warning times in `ticket_sla`.
- Timers start at ticket creation, so time spent ungrouped counts. Pending states pause the
  resolution timer.
- The sweeper (D11) emits `sla.warning` and `sla.breached` once each per target (unique
  constraint on `sla_events`).

**Alternatives considered**: Computing SLA at read time (can't drive notifications or the
Escalated view efficiently).

---

## D16. Webhooks

**Decision**:
- Endpoints must be HTTPS. **SSRF protection**: the resolved IP is checked against private,
  loopback, link-local and metadata ranges at delivery time, not only at registration, and
  redirects are not followed.
- **Signature**: header `ReplyX-Signature: t={unix},v1={hex HMAC-SHA256(secret, t + "." + body)}`.
  Secrets are encrypted at rest (AES-256-GCM with a key from the environment) and shown once when
  created or rotated.
- **Delivery**: from the `webhooks` queue, 10 s timeout, retries with exponential backoff and
  jitter (up to 8 attempts over about 24 h). Each attempt is written to `webhook_deliveries`
  (status, response code, duration; no response bodies over 2 KB). Deliveries are kept for 30 days.
- Suspended tenants' webhooks pause (FR-004). Each delivery carries an event id so receivers can
  deduplicate.

**Rationale**: A standard, Stripe-style scheme that receivers already know how to verify.

---

## D17. Attachments

**Decision**:
- **Storage**: a `FileStorage` interface with two adapters.
  - `local` (**default**): files live on a Docker volume (`replyx-files`) mounted into the `api`
    and `worker` containers at `/data/files`, laid out as
    `{tenantId}/{quarantine|files}/{attachmentId}`. This fits a single VM with no extra service.
  - `s3` (optional, switched by an environment variable): any S3-compatible object store, for
    when files outgrow the VM disk or the app moves to more than one server.

  "S3-compatible" means storage that speaks Amazon S3's file API; many self-hosted and cloud
  products do. It isn't needed on one VM.
- **Upload**: `POST /attachments` (multipart) through the API. The API checks the size limit
  (25 MB) and the allowed type using magic-byte detection (not the file extension), writes the
  file to the quarantine area, and returns an attachment id with `scanStatus: pending`. The id is
  then referenced when the message is sent.
- **Scan**: the `attachments` job calls the `MalwareScanner` interface. The default adapter is
  ClamAV (the `clamav` container). A development-only pass-through adapter marks files clean.
  Clean files move out of quarantine. Infected files are deleted, and the message shows the
  attachment as blocked.
- **Download**: `GET /attachments/{id}/download` runs the policy check ("can see the message"),
  then redirects (302) to `/api/v1/files/{token}`. The token is signed by the API (HMAC over
  tenant, attachment id and expiry, with a key from the environment) and is valid for 15 minutes.
  `/files/{token}` checks the signature, the expiry and that the host's tenant matches, then
  streams the file with `Content-Disposition: attachment` (inline only for safe image types).
  Storage paths never appear in API responses. With the `s3` adapter, the redirect goes to a
  presigned storage URL instead, with the same 15-minute expiry.

**Rationale**: Uploading through the API keeps validation and tenant scoping in one place. A
Docker volume is the simplest production-ready store on one VM, and it is included in the VM
backup (D24).

**Alternatives considered**:
- A self-hosted S3-compatible server (MinIO, Garage, SeaweedFS) in the compose stack: one more
  service to run and back up, with no benefit on a single machine.
- Storing files in PostgreSQL: bloats the database and its backups.

---

## D18. Data retention (clarification 2026-09-24)

**Decision**: A daily `retention` job per tenant deletes closed tickets older than the tenant's
`retention_period` (in batches of 500): messages, attachments (storage objects too), history,
links and tags. It removes the matching search entries and customer-thread content, and writes one
audit entry with counts only. The audit log keeps its own `audit_retention` setting (minimum
1 year, default indefinite).

---

## D19. Rate limiting and abuse protection

**Decision**: Redis-backed sliding-window limiters (`@nestjs/throttler` with Redis storage):
- sign-in: 10 attempts per IP per minute, plus the account lockout (D5);
- sign-in link requests: 5 per email address per hour (FR-012a);
- customer messages: 20 per minute per customer (FR-057), answered with a friendly
  `RATE_LIMITED` error and a `retryAfter` value;
- general API: 600 requests per minute per session.

---

## D20. Notifications pipeline

**Decision**: domain event → `notifications` consumer → recipient resolver → per-channel
delivery.
- The **recipient resolver** starts from owner, group view access, Ungrouped access, mentions and
  subscriptions. It drops the actor, then drops anyone who can no longer view the ticket (via the
  policy service), then applies preferences (master switch, event, channel).
- **Deduplication**: unique `(recipient_id, event_id, channel)` on `notification_deliveries`.
- **Batching**: notifications about customer messages on the same ticket share a
  `group_key = ticket:{id}:customer_messages`. The first creates the in-app entry immediately and
  schedules a 2-minute digest for email and push. Later ones in the window update the in-app
  entry's count instead of creating new entries.
- **Channels**: in-app (a `notifications` row plus a real-time push to `user` rooms), Web Push
  (VAPID, via the `web-push` library, P2), email (SMTP, P2; customers' offline-reply emails in
  P1).
- **Unread state** lives on the server. `notification.read` events sync every session.

---

## D21. Frontend architecture

**Decision**: One Vite app (`apps/web`) with three route areas, code-split so each audience
downloads only its own bundle:
- `/` on the tenant host: the **customer chat** (small bundle, mobile-first).
- `/desk/*` on the tenant host: the **agent/admin workspace**.
- `/` on the console host: the **platform console** (minimal: tenant list, create, suspend,
  support-access sessions).

All three use one design system in `apps/web/src/components` and `src/theme` (MUI with custom
tokens and original layouts, principle XI). Data access goes only through `src/data` hooks that
wrap the orval client. Real-time events update the TanStack Query cache, and a reconnect triggers
catch-up (D8). WCAG 2.2 AA (FR-071a): axe checks in component tests and Playwright, a
keyboard-only e2e pass, and live regions for new messages, typing and notifications.

**Rationale**: The repo's agents own exactly one frontend app (`apps/web`). Route-level splitting
gives the customer a small, separate bundle without a second app to maintain. Tenant-chosen chat
colors are checked for contrast when saved (FR-071a), and the closest compliant shade is
suggested.

**Alternatives considered**: Separate `apps/customer` and `apps/desk` plus `packages/ui`: cleaner
deployment separation, but would need new agent ownership and duplicated build config. It can be
done later by moving route areas out.

---

## D22. Observability

**Decision**:
- **Logs**: nestjs-pino JSON logs with `requestId`, `tenantId`, `userId`, `jobId`/`eventId`.
  Redaction paths cover passwords, tokens, cookies, `authorization`, and message/note bodies
  (principle X).
- **Metrics and traces**: OpenTelemetry SDK. Prometheus metrics include HTTP latency, WebSocket
  connections, relay lag (now − oldest unpublished event), queue depth, dead-letter count, and
  sweeper lag.
- **Error tracking**: Sentry-compatible SDK, enabled by DSN, with the same redaction rules.
- **Health**: `/health/live` and `/health/ready` (database, Redis, storage).

---

## D23. Availability and recovery targets (deferred from clarification)

**Decision** (sized for one VM, D24):
- **Availability**: 99.5% monthly for the API and chat (about 3.6 hours of downtime a month).
  A single VM can't promise 99.9%, because host reboots, OS updates and disk failures take the
  whole service down. Deploys themselves cause a few seconds of downtime, and the web app
  reconnects and catches up (D8).
- **Recovery point**: at most 5 minutes of data loss: PostgreSQL write-ahead-log (WAL)
  archiving plus a nightly base backup, and a nightly snapshot of the files volume, all run by the
  `backup` container (D24). **Backups must go to storage outside the VM** (another server over
  SFTP, a NAS, or any S3-compatible bucket). A backup on the same disk doesn't survive losing
  the VM.
- **Recovery time**: within 4 hours: provision a VM, install Docker, copy the `.env` file, run
  `docker compose up`, and restore the database and files.
- **Scaling**: scale up first (a bigger VM). `api` and `worker` are stateless and Redis holds
  nothing durable, so moving to several servers later only needs a load balancer, a shared
  PostgreSQL and the `s3` file adapter. That is out of scope for now.

---

## D24. Deployment: Docker Compose on the owner's VM

**Decision**: Production runs as one Docker Compose project (`infra/compose.prod.yml`) on the
VM the owner already has. Nothing runs outside Docker except Docker itself.

| Service | Image | Purpose | Exposed |
|---------|-------|---------|---------|
| `caddy` | Caddy + the built web app | HTTPS; serves the web app's static files; proxies `/api` and `/rt` (WebSocket) to `api` | 80, 443 |
| `api` | `replyx-api` | HTTP + WebSocket | internal only |
| `worker` | `replyx-api` (different command) | Outbox relay, jobs, sweeper | none |
| `migrate` | `replyx-api` (one-off) | Runs migrations; `api` and `worker` start only after it succeeds | none |
| `postgres` | `postgres:17` | Database (volume `pgdata`) | internal only |
| `redis` | `valkey/valkey:8` | Queues, fan-out, presence, rate limits | internal only |
| `clamav` | `clamav/clamav` | Malware scanning | internal only |
| `backup` | pgBackRest + restic | WAL archiving, nightly base backup, files-volume snapshot, all sent off the VM | none |

- **TLS and tenant subdomains**: DNS needs one wildcard record (`*.yourdomain` → VM IP) and a
  record for the console host. Caddy uses **on-demand TLS**: it gets a certificate for each
  tenant subdomain the first time someone visits it, but only after asking the API
  (`/internal/tls-allowed?domain=...`, reachable only inside the compose network) whether that
  tenant exists. This works with any DNS provider and needs no DNS API access.
- **Releases**: GitHub Actions builds the `replyx-api` and `replyx-web` images and pushes them to
  GitHub Container Registry (GHCR), tagged with the commit SHA. To deploy on the VM:
  `docker compose pull && docker compose up -d`. To roll back, set the previous tag and run the
  same command. Migrations stay backward compatible for one release, so a rollback never needs a
  down-migration.
- **Configuration and secrets**: one `.env` file on the VM (permissions 600, never committed)
  holds database passwords, the session, file-signing and webhook-encryption keys, and SMTP
  credentials. `.env.example` in the repo lists every variable.
- **Email**: sent through an external SMTP relay (your mail provider or a transactional email
  service), configured in `.env`. Mail sent straight from a VM's IP address is usually marked as
  spam.
- **Firewall**: only ports 22 (SSH), 80 and 443 are open. PostgreSQL and Redis are never
  published.
- **Logs**: Docker's `json-file` driver with rotation (10 MB × 5 files per container). An optional
  `monitoring` compose profile adds Prometheus and Grafana for the metrics in D22.
- **Suggested VM size for the MVP**: 4 vCPU, 8 GB RAM (ClamAV alone uses about 1.5 GB), 100 GB
  SSD, on a Linux distribution with Docker Engine and the Compose plugin.

**Rationale**: One VM running Compose is the simplest production-ready setup for the expected MVP
load (principle VIII), and it matches the owner's hosting.

**Alternatives considered**: Kubernetes (far more to run than one VM needs). Installing services
directly on the host (goes against the Docker-everywhere requirement, and development and
production would drift apart).

---

## D25. Testing strategy

**Decision**:
- **Unit** (Vitest): policy service, role–group access union, ticket state machine,
  conversation router, routing rules, view compiler, recipient resolver, SLA calendar, webhook
  signing.
- **Integration** (Vitest + Supertest + Testcontainers PostgreSQL and Redis): per endpoint,
  success, permission-denied (403), and cross-tenant (404) cases (from the test-automator agent
  contract). Also permission changes taking effect live, real-time catch-up, and attachment
  access.
- **Cross-tenant suite**: generated. It uses Nest's `DiscoveryService` to list every route and
  its registry resource. For each resource a fixture factory creates the resource in tenant A,
  then the suite calls every route as a tenant B user (REST), subscribes as tenant B (real-time),
  searches as tenant B, and requests tenant A attachment downloads. It expects 404, empty
  results, or a rejected subscription. A route whose resource has no fixture fails the suite, so
  new modules cannot skip it (principle VII).
- **RLS test**: queries without `app.tenant_id` return zero rows for every tenant table
  (catalogue-driven).
- **Concurrency**: parallel customer sends (N=50), a send racing auto-close, double assignment,
  double triage.
- **E2E** (Playwright): the nine-step flow in [quickstart.md](quickstart.md#main-flow), plus a
  keyboard-only run and axe checks.
- **Coverage gates**: api ≥ 80%, web ≥ 70% (`scripts/check-coverage.sh`).

---

## D26. Docker-based development

**Decision**: Development runs entirely in Docker Compose (`compose.yaml` at the repository
root). The host needs only Docker Desktop (or Docker Engine) and Git.

- **Services**: `postgres`, `redis`, `mailpit` (catches every outgoing email; web UI on port
  8025), `clamav` (optional `scan` profile; without it files are marked clean), plus the app
  services `api`, `worker` and `web`. The app services run from a shared `dev` image (Node 24 +
  pnpm) with the repository bind-mounted and `node_modules` in named volumes. They run in watch
  mode: Nest restarts on change and Vite hot-reloads the browser.
- **Commands** run inside containers, for example
  `docker compose run --rm api pnpm --filter api migrate`. [quickstart.md](quickstart.md) lists
  them all.
- **Tests**: Testcontainers starts throwaway PostgreSQL and Redis containers, so the test-runner
  container mounts the Docker socket (`/var/run/docker.sock`). Playwright runs in the official
  Playwright image against the running `web` service.
- **The same Dockerfiles** build the production images (multi-stage: `dev`, `build`, `runtime`),
  so development and production differ only in the target stage and the compose file.
- **Windows**: bind mounts from the Windows filesystem are slow, and file watching can miss
  changes. Clone the repository inside WSL 2 (Docker Desktop's default backend) for full speed,
  or set `CHOKIDAR_USEPOLLING=true` in `.env` if the clone stays on a Windows drive.
- **Repo scripts** (`scripts/test-affected.sh`, `scripts/check-coverage.sh`,
  `scripts/generate-api-client.sh`) run unchanged in CI. Locally they run through the `tools`
  service: `docker compose run --rm tools bash scripts/...`.

**Rationale**: The owner wants Docker for both development and deployment, and one set of images
keeps the two environments the same.

**Alternatives considered**: Databases in Docker with Node running on the host (the earlier
plan): faster file watching on Windows, but it is the setup the owner asked to avoid.
