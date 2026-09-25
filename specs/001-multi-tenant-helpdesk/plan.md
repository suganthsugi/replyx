# Implementation Plan: Multi-Tenant Customer Support Platform

**Branch**: `001-multi-tenant-helpdesk` (spec directory; work currently on `main`) | **Date**: 2026-09-24 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-multi-tenant-helpdesk/spec.md`

## Summary

ReplyX is a multi-tenant help desk with two experiences: an agent/admin workspace and a
chat-first customer app, where each customer sees one continuous thread and never sees tickets.
The technical approach is a **NestJS modular monolith** on **PostgreSQL** (tenant-scoped
repositories plus forced row-level security), a **transactional outbox** feeding **Socket.IO**
real-time delivery with cursor-based catch-up and **BullMQ** background jobs, and one **Vite +
React + MUI** web app with code-split customer, workspace and console areas that share one design
system. All authorization flows through one policy service that also produces the access filter
for every list, count and search. Decisions and trade-offs: [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript 5 (strict) on Node.js 24 LTS (`.nvmrc`)

**Primary Dependencies**:
- API: NestJS 11, Kysely, Socket.IO 4 with the Redis adapter, BullMQ, argon2, nestjs-pino,
  OpenTelemetry, Luxon, Nodemailer, web-push (S3 client only if the optional s3 file adapter is enabled)
- Web: React 19, Vite, MUI 7, TanStack Query 5, React Router 7, socket.io-client, orval-generated
  client
- Docs: Astro Starlight
- Monorepo: pnpm workspaces + Turborepo

**Storage**:
- PostgreSQL 17 (system of record; FTS + pg_trgm for search; RLS)
- Redis-compatible store (queues, Socket.IO fan-out, presence, rate limits, caches; nothing that
  must survive)
- Attachments on a Docker volume through a `FileStorage` interface (an S3-compatible adapter is
  optional for later, research D17)

**Testing**: Vitest + Supertest + Testcontainers (API unit, integration, cross-tenant,
concurrency); Vitest + React Testing Library + MSW (web); Playwright (e2e and axe accessibility);
Redocly lint for OpenAPI. All test commands run inside containers (research D26).

**Target Platform**: Docker Compose on the owner's existing Linux VM (Caddy for HTTPS, `api`,
`worker`, PostgreSQL, Valkey, ClamAV, backups; research D24). Development uses the same images
through Docker Compose (D26). Clients are evergreen desktop and mobile browsers.

**Project Type**: Web application (API service + single-page web app + docs site) in a monorepo

**Performance Goals**:
- 95% of messages and ticket changes visible to connected participants within 2 s (SC-002)
- New ungrouped tickets in Needs Triage within 2 s (SC-003)
- Notifications to online users within 2 s (SC-004)
- API p95 < 300 ms for reads and < 500 ms for writes; view counts < 50 ms at p95
- Customer can send a first message within 10 s of opening the chat (SC-001): chat bundle
  < 150 KB gzipped

**Constraints**:
- Tenant isolation on every path (constitution I); one authorization path (II)
- Persist-then-publish and idempotent retries (IV); side effects via events and jobs (V)
- WCAG 2.2 AA (FR-071a)
- No message bodies, passwords or tokens in logs (X)
- One VM: 99.5% availability, recovery point ≤ 5 min (off-VM backups), recovery time ≤ 4 h (research D23)

**Scale/Scope**:
- Up to a few thousand tenants, each with up to ~200 staff and ~100k tickets per year
- Up to 500 concurrently connected users per tenant
- 18 user stories (9 in the P1 MVP), 92+ functional requirements, ~15 API modules, ~40 screens

## Constitution Check

*GATE: must pass before Phase 0 research. Re-checked after Phase 1 design (below).*

| # | Principle | How the plan complies | Status |
|---|-----------|----------------------|--------|
| I | Tenant isolation is absolute | `tenant_id` on every tenant table; repositories require a `TenantContext`; forced RLS as defense in depth; tenant from host with host-only cookies; tenant-qualified Socket.IO rooms; jobs carry `tenantId`; signed download links issued only after a policy check; cross-tenant 404 identical to missing (research D2, D3, D8, D17) | ✅ Pass |
| II | One authorization path | Pipeline: authenticate → resolve tenant → load user → policy `can()` → resource scope → logic. One policy service; the same access filter for list, view, search, count and dashboard; Admin has no bypass (granted through the registry) (D6) | ✅ Pass |
| III | Modules plug in | Module declaration (resources, actions, routes) gets registry sync, tenant-scoped repository base, audit interceptor, standard error and pagination DTOs, and automatic inclusion in the cross-tenant suite (D6, D25) | ✅ Pass |
| IV | Database is the source of truth | Outbox in the same transaction; relay assigns `seq`; clients catch up by cursor; idempotency keys on messages, `processed_events` for consumers, event ids on webhooks (D7, D8, D10, D12) | ✅ Pass |
| V | Side effects are event-driven | Notifications, SLA, automation, webhooks, search indexing, analytics and audit consume events; slow work runs in `worker` (D7, D12) | ✅ Pass |
| VI | Security by default | argon2id; hashed server-side sessions; CSRF double-submit; policy on every route and subscription; validation with whitelisted DTOs; sanitized Markdown; rate limits; magic-byte upload checks, private storage, malware hook; SSRF-safe webhooks; 404 on enumeration (D5, D16, D17, D19) | ✅ Pass |
| VII | Tests guard the critical paths | Unit tests for policy, state machine, router, compiler and recipients; integration tests with 200/403/404 cases per endpoint; generated cross-tenant suite; RLS catalogue test; concurrency tests; Playwright main flow (D25) | ✅ Pass |
| VIII | Simple over clever | Modular monolith; PostgreSQL does search, locks, counters and timers; Redis and Caddy are justified below; no microservices | ✅ Pass (see Complexity Tracking) |
| IX | Clean contracts | Explicit OpenAPI schemas ([contracts/](contracts/)), one error format, separate customer API and projection, 404 rule; storage keys never exposed | ✅ Pass |
| X | Observable, without leaking | pino with request, tenant and user ids and redaction; OpenTelemetry metrics (relay lag, queue depth, dead-letter queue, WebSocket connections); Sentry-compatible errors (D22) | ✅ Pass |
| XI | Original, consistent UX | Original layouts ([UI architecture](#ui-architecture)); one component system for all three areas; customer projection hides ticket concepts | ✅ Pass |
| — | Workflow: commits | Unit commits with one-line messages per `docs/commit-guidelines.md`, done by the `committer` agent | ✅ Pass |

**Result**: no violations. Phase 0 may proceed.

## Project Structure

### Documentation (this feature)

```text
specs/001-multi-tenant-helpdesk/
├── spec.md              # Feature specification (clarified 2026-09-24)
├── plan.md              # This file
├── research.md          # Phase 0: decisions D1–D26
├── data-model.md        # Phase 1: tables, state machine, conversation routing
├── quickstart.md        # Phase 1: run locally + validation scenarios
├── contracts/           # Phase 1: OpenAPI (staff, customer, platform) + real-time + webhooks
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 (/speckit-tasks; not created here)
```

### Source Code (repository root)

```text
package.json                 # workspace root (replaces the legacy Next.js prototype, research D1)
pnpm-workspace.yaml          # apps/*, packages/*
turbo.json                   # lint, typecheck, test, build pipelines (CI already expects it)
compose.yaml                 # development stack: api, worker, web (watch mode), postgres, redis,
                             #   mailpit, tools, clamav (profile "scan") — research D26
.env.example                 # every variable, for development and the VM
infra/
├── compose.prod.yml         # VM stack: caddy, api, worker, migrate, postgres, redis, clamav, backup
├── caddy/Caddyfile          # HTTPS (on-demand TLS per tenant subdomain), static web, /api and /rt proxy
├── backup/                  # pgBackRest + restic config (WAL archive, nightly base + files snapshot)
└── scripts/deploy.sh        # docker compose pull && up -d with a given image tag
.github/workflows/
├── ci.yml                   # existing: lint, typecheck, test, coverage, client freshness
└── release.yml              # build + push replyx-api and replyx-web images to GHCR

apps/api/                    # NestJS modular monolith (backend-agent / test-automator)
├── Dockerfile               # multi-stage: dev (watch), build, runtime (api/worker/migrate)
├── openapi.yaml             # single source of truth, merged from specs/.../contracts
├── migrations/              # SQL migrations (Kysely migrator); RLS policies live here
├── src/
│   ├── main.api.ts          # HTTP + WebSocket process
│   ├── main.worker.ts       # outbox relay, BullMQ consumers, sweeper
│   ├── platform-kernel/     # shared plumbing, not a domain module
│   │   ├── db/              # Kysely, unit-of-work (SET LOCAL app.tenant_id), TenantContext
│   │   ├── outbox/          # outbox writer, relay, processed_events
│   │   ├── realtime/        # Socket.IO gateway, rooms, sync/catch-up
│   │   ├── jobs/            # BullMQ setup, idempotent handler base, dead-letter queue
│   │   ├── http/            # error filter, pagination, validation pipe, CSRF, rate limits
│   │   └── observability/   # pino, OpenTelemetry, redaction
│   ├── identity/            # auth, sessions, sign-in links, invitations, users
│   ├── tenancy/             # tenants, settings, support access, platform console
│   ├── authorization/       # permission registry, policy service, access filters, roles
│   ├── customers/           # customer profiles, customer tags
│   ├── groups/
│   ├── tickets/             # tickets, state machine, links, history, merge/split, triage
│   ├── messaging/           # messages, customer conversation projection, router
│   ├── routing/             # routing rules (TicketRouter) + automation rules
│   ├── notifications/       # recipients, channels, preferences, batching
│   ├── views/               # view compiler, default views, counts
│   ├── tags/
│   ├── attachments/         # upload, scan hook, signed download
│   ├── sla/                 # business hours calendar, policies, due times
│   ├── audit/               # audit consumer + query
│   ├── integrations/        # webhooks, deliveries
│   └── search/              # SearchService (PostgreSQL FTS)
└── test/
    ├── unit/
    ├── integration/         # per-module endpoint tests (200/403/404)
    ├── cross-tenant/        # generated suite over every route and stream
    ├── concurrency/
    └── factories/           # tenant-explicit fixtures

apps/web/                    # Vite + React + MUI (frontend-agent / connector / automator)
├── Dockerfile               # dev (Vite server); build → static files copied into the Caddy image
├── orval.config.ts
├── src/
│   ├── api/generated/       # orval output — never edited by hand
│   ├── data/                # query/mutation hooks, cache keys, socket subscriptions, error mapping
│   ├── theme/               # tokens, MUI theme, tenant brand color handling
│   ├── components/          # shared design system (see UI architecture)
│   ├── pages/
│   │   ├── customer/        # chat, sign-in, profile
│   │   ├── desk/            # workspace: views, ticket, customer, search, notifications
│   │   ├── admin/           # settings sections (under /desk/admin)
│   │   └── console/         # platform operator console
│   └── routes/              # three lazily loaded route areas selected by host and path
├── test/                    # RTL + MSW
└── e2e/                     # Playwright (main flow, a11y, keyboard-only)

apps/docs/                   # Starlight: user guides + developer docs (documentator agents)
```

**Structure Decision**: A pnpm/turbo monorepo with `apps/api`, `apps/web` and `apps/docs`,
matching the agent ownership map and CI that the repository already has. The legacy Next.js
prototype at the root is archived by the first scaffold task (research D1). Domain modules live
side by side under `apps/api/src/`, each exposing a public service and events only.
`platform-kernel/` holds cross-cutting plumbing that modules use and never bypass.

## Security model (summary)

Details live in research.md. This is the index.

| Concern | Mechanism | Ref |
|---------|-----------|-----|
| Tenant resolution | Host subdomain → tenant; session must match; host-only cookies | D2 |
| Data isolation | Scoped repositories + forced RLS, `SET LOCAL app.tenant_id` per unit of work | D3 |
| Authentication | Hashed opaque server-side sessions; argon2id; customer magic links; lockout | D5 |
| Authorization | Registry + single policy service + shared access filter; versioned cache | D6 |
| Live revocation | `access.changed` → gateway prunes rooms, sends `access.revoked` | D6, D8 |
| Customer data minimization | Separate customer API, DTOs and event projection; public-only queries | D9 |
| CSRF / XSS | SameSite=Lax + double-submit token; sanitized Markdown; strict CSP on web | D5 |
| Enumeration / IDOR | 404 for other tenant or no visibility; uniform sign-in and link responses | contracts/README |
| Files | Magic-byte validation, private Docker volume, quarantine + scan, 15-min API-signed download links issued after a policy check | D17 |
| Webhooks | HTTPS only, SSRF IP checks at delivery, HMAC signatures, encrypted secrets | D16 |
| Abuse | Redis rate limits on auth, links, messages and API | D19 |
| Host | Only ports 22/80/443 open; PostgreSQL, Redis and ClamAV only on the internal compose network; secrets in a 600-permission `.env` | D24 |
| Operators | Separate console host and session; tenant data only via time-limited, read-only, audited grants | D3, platform.yaml |
| Audit | Append-only table (UPDATE/DELETE revoked for the app role) | data-model |

## Background jobs (summary)

| Queue / job | Trigger | Idempotency | Ref |
|-------------|---------|-------------|-----|
| Outbox relay | `LISTEN/NOTIFY` + 500 ms poll, single leader | `seq` assigned once; `published_at` | D7 |
| `notifications`, `email`, `push` | Events | Unique (recipient, event, channel) | D20 |
| `sweeper` (30 s) | Repeatable | `FOR UPDATE SKIP LOCKED`, state re-check under the customer lock | D11 |
| `sla` | Events + sweeper | Unique `sla_events` | D15 |
| `automation` (P3) | Events | `processed_events`; loop guard | data-model |
| `webhooks` (P3) | Events | Delivery rows per (webhook, event, attempt) | D16 |
| `attachments` | Upload | Scan status transition is one-way | D17 |
| `search-index`, `analytics` | Events | Upserts | D14 |
| `retention` (daily) | Repeatable | Batch deletes by id | D18 |
| Dead-letter queue | Final failure | Alert when not empty | D12 |

## UI architecture

The design is original (constitution XI) and does not follow Zammad's layout conventions. It is
built around an **inbox + focus** model: a command bar drives navigation, lists are dense and
keyboard-first, and a ticket opens as a focused conversation with properties in a status strip,
not in a sidebar of form fields.

### Shared component system (`apps/web/src/components`)

| Family | Components |
|--------|------------|
| Foundations | tokens (color, type scale, spacing, radius, elevation), `ThemeProvider` with tenant brand accent, icons, `VisuallyHidden`, `LiveRegion` |
| Data display | `DataTable` (virtualized, keyboard row nav), `TicketList`, `TicketRow`, `TicketConversation`, `MessageBubble`, `InternalNoteCard`, `HistoryTimeline`, `Avatar`, `PresenceStack`, `SlaBadge`, `StatePill`, `PriorityMark`, `EmptyState`, `Skeleton` |
| Inputs | `MessageComposer` (reply/note toggle, attachments, mentions, macros), `UserSelector`, `GroupSelector`, `StateSelector` (with date for pending states), `PrioritySelector`, `TagInput`, `DurationInput` |
| Builders | `FilterBuilder` (AND/OR groups), `ViewBuilder`, `PermissionMatrix` (groups × actions + Ungrouped row), `RuleBuilder` (routing and automation), `BusinessHoursEditor` |
| Shell | `CommandBar` (Ctrl/Cmd+K: search, jump to view or ticket, actions), `NotificationCenter`, `Modal`, `Drawer`, `Form` (field, errors, submit states), `ConfirmationDialog`, `Toast`, `ErrorBoundary` |
| Chat (customer) | `ChatThread`, `ChatBubble`, `ResolvedMarker`, `StatusLine`, `TypingDots`, `ChatComposer`, `RatingPrompt` |

Every component handles loading, empty and error states and is tested with axe.

### Information architecture

```text
Customer app  ({tenant}.replyx.app/)
├── Sign in (email → link sent → open link)          [self-sign-up inline when allowed]
├── Chat (the only main screen)
│   ├── thread (scroll up for history, resolved markers)
│   ├── status line + typing
│   └── composer (text, attach)
├── Profile sheet (name, avatar, optional password, email on reply, sign out everywhere)
└── Unavailable screen (tenant suspended)

Workspace  ({tenant}.replyx.app/desk)
├── Inbox
│   ├── View rail: views with live counts (Needs Triage first when permitted)
│   ├── Ticket list (for the selected view)
│   └── Ticket focus (conversation, status strip, history tab, links)
├── Customer (profile, tickets, conversation history)
├── Search (command bar → full results page)
├── Dashboard
├── Notifications (panel + full page)
├── Me (profile, availability, notification preferences)
└── Admin (only the sections the user has permission for)
    ├── Organization: profile & branding, business hours, retention, support access
    ├── People: users, roles (permission matrix), groups
    ├── Work: views, tags, macros
    ├── Automation: routing rules, SLA policies, automation rules
    ├── Notifications: tenant defaults
    ├── Integrations: webhooks
    └── Audit log

Console  (console.replyx.app)
├── Tenants (list, create, suspend, reactivate)
└── Support sessions (open read-only session under an active grant)
```

### Wireframe structure

**Customer chat (phone first; on desktop the same layout is centered, max 720 px wide)**

```text
┌──────────────────────────────┐
│ [logo] Acme Support      (•) │  header: brand, profile button
├──────────────────────────────┤
│   Welcome message card       │
│                    ┌───────┐ │
│                    │ me    │ │  own bubbles right, delivery ✓/✓✓
│ ┌──────────┐       └───────┘ │
│ │(A) Priya │                 │  support bubbles left, agent name + avatar
│ └──────────┘                 │
│ ── Glad we could help… ──    │  resolved marker (+ optional rating chips)
│ …                            │
│ Support is replying ···      │  status line / typing (live region)
├──────────────────────────────┤
│ [📎] Write a message…  [Send]│  composer, sticky
└──────────────────────────────┘
```

**Workspace inbox (desktop; below 1024 px it collapses to one pane at a time)**

```text
┌────────────────────────────────────────────────────────────────────────┐
│ ReplyX  [⌘K Search or jump…]                  (Online ▾)  🔔3  (me)     │
├───────────────┬──────────────────────┬─────────────────────────────────┤
│ VIEWS         │ Needs Triage (4)     │ #1042 My order has not arrived   │
│ ● Needs Tri 4 │ ┌──────────────────┐ │ ┌─ status strip ────────────────┐│
│   Unassign  7 │ │ #1042 Maria L.   │ │ │ Open ▾  Normal ▾  Support ▾   ││
│   My Tick  12 │ │ My order has…  2m│ │ │ Owner: Priya ▾  #refund +  SLA││
│   Waiting   5 │ └──────────────────┘ │ │ 3h12m left  · 👀 Sam viewing   ││
│   …           │ ┌──────────────────┐ │ └───────────────────────────────┘│
│ PERSONAL      │ │ #1041 …          │ │  conversation (customer left,   │
│   + New view  │ └──────────────────┘ │  agents right, notes as tinted   │
│               │                      │  cards)                          │
│ [Dashboard]   │ [Triage ▸] bulk bar  │ ┌ Reply | Internal note ───────┐ │
│ [Admin]       │                      │ │ @mention, /macro, 📎   [Send]│ │
└───────────────┴──────────────────────┴─┴─────────────────────────────┴─┘
```

- **Triage** (Needs Triage): selecting a ticket opens an inline triage bar above the conversation
  with Group (required), Owner, Priority and Tags, and one **Assign** button. That is three
  actions or fewer (SC-005). Keyboard: `G` group, `O` owner, `Enter` assign.
- **Customer panel**: clicking the customer name opens a right-hand drawer over the conversation
  with profile, tags, and open and closed tickets.
- **Role editor**: a two-part page. The top half is the permission list grouped by module
  (checkboxes; new permissions flagged "new"). The bottom half is a `PermissionMatrix` with
  columns View / Create / Edit / Delete and rows for Ungrouped + each group. Admin role shows
  everything locked on.
- **View builder**: a drawer with name, sharing, a `FilterBuilder` with nested AND/OR blocks and
  field/operator/value rows, sort and column pickers, and a live preview count, so a
  three-condition view takes under a minute (SC-015).

### Front-end state and real-time

TanStack Query caches server state. The socket layer in `src/data` applies events to the cache
by stream: on reconnect it sends `sync` with stored cursors, and on `resync_required` it
invalidates queries. `access.revoked` closes affected ticket screens and shows a toast. No
component imports the generated client directly.

## Delivery order

Stories follow the spec's priorities. Each P1 story is demonstrable on its own once the stories it
depends on exist.

| Phase | Stories | Notes |
|-------|---------|-------|
| 0. Scaffold | — | Archive the legacy prototype; turbo workspace; dev `compose.yaml` and Dockerfiles; production `compose.prod.yml`, Caddyfile, backups and the GHCR release workflow; `platform-kernel` (unit of work + RLS, outbox + relay, gateway, jobs, errors, logging); registry + policy skeleton; cross-tenant suite harness; CI green |
| 1. P1 foundation | US2 (tenancy/isolation), US3 (sign-in/users), US4 (roles/groups/access) | Everything else depends on these |
| 2. P1 conversation | US1 (customer chat), US6 (agent work), US5 (triage), US7 (resolution/return) | Main-flow e2e goes green at the end of this phase |
| 3. P1 operations | US8 (default views, real-time, in-app notifications), US9 (audit log) | MVP complete |
| 4. P2 | US10 view builder, US11 routing, US12 SLA + dashboard, US13 search, US14 productivity, US15 notification channels, US16 satisfaction + full profile | Any order after the MVP |
| 5. P3 | US17 automation, US18 webhooks | |

## Post-design Constitution Check

Re-evaluated against the Phase 1 artifacts ([data-model.md](data-model.md),
[contracts/](contracts/), [quickstart.md](quickstart.md)):

- **I**: every tenant-owned table in data-model.md has `tenant_id`, composite foreign keys and
  RLS. The real-time rooms and webhook payloads are tenant-qualified. The platform console reads
  tenant data only through grants. ✅
- **II**: every contract operation names its permission, or ownership for the customer API. The
  403 vs 404 rule is defined once. ✅
- **III**: permission registry table and module declaration pattern; the cross-tenant suite
  discovers routes. ✅
- **IV**: `outbox_events`, `processed_events`, `clientMessageId` uniqueness, and `seq` cursors in
  the real-time contract. ✅
- **V**: every side effect in the job table is event-triggered. ✅
- **VI**: the security model table covers each required protection. ✅
- **VII**: quickstart validation scenarios map to the required test suites. ✅
- **VIII**: extra infrastructure limited to Redis and Caddy, all in one Compose project on one VM (justified below). ✅
- **IX**: contracts use explicit schemas, `additionalProperties: false` on inputs, and one error
  format. The customer API and events are separate projections. All seven OpenAPI files pass
  Redocly validation. ✅
- **X**: redaction list and metrics defined (D22). ✅
- **XI**: original "inbox + focus" layout, shared component list, customer projection. ✅

**Result**: pass. Ready for `/speckit-tasks`.

## Complexity Tracking

Principle VIII asks for a documented reason for any infrastructure beyond the basics. These are
justified additions, not violations.

| Addition | Why needed | Simpler alternative rejected because |
|----------|------------|-------------------------------------|
| Redis-compatible store | Socket.IO multi-instance fan-out, ephemeral presence and typing, rate limits, BullMQ queues | PostgreSQL-only (pg-boss + LISTEN/NOTIFY fan-out) would need custom presence TTLs and room fan-out; Redis is standard and holds nothing durable (D12) |
| Caddy reverse proxy | HTTPS with automatic certificates per tenant subdomain, static web files, WebSocket proxy | nginx + certbot needs a wildcard certificate via a DNS API or per-tenant certbot runs; Caddy's on-demand TLS needs neither (D24) |
| Off-VM backup target | Recovery point ≤ 5 min must survive losing the VM | Backups on the same disk are lost with it (D23) |
| Row-level security in addition to scoped repositories | Constitution I asks for database-level defense in depth | Repository scoping alone leaves no safety net for a missed filter (D3) |
| `@StaffApi()` access kind (constitution II exception, user-approved 2026-09-25) | Sign-out and `/me` act only on the caller's own account and need a staff session but no permission key | A permission key every role must hold adds a grant that can be removed by mistake and lock users out of signing out; the route audit confines `@StaffApi()` to `/auth` and `/me` |
| Separate `worker` process role | Principle V: slow work outside requests; the single outbox relay leader | Running consumers in the API process couples request latency to job load; same image, so no extra codebase (D24) |
