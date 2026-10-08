# Implementation Plan: AI Assist (first cut)

**Branch**: `002-ai-assist` (spec directory; work on `main`) | **Date**: 2026-10-08 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-ai-assist/spec.md`

## Summary

Add an `ai` module to the existing NestJS modular monolith. Each tenant brings its own OpenRouter key (encrypted at rest). The module has four parts:

- **Assistant:** answers customers, or drafts replies for agents. It rebuilds each turn from the ticket's messages, calls three tools (policy search, Spree order lookup, hand-off) and posts as a new message author kind, `assistant`.
- **Policy knowledge:** versioned documents, chunked and embedded into **pgvector** in the existing PostgreSQL, searched by vector and full text together.
- **Jev routing:** runs after ticket creation for tickets no rule matched.
- **Complexity scoring:** Jev answers the admin-defined factors and the score picks the Fast, Standard or Advanced model level.

All AI work runs in the `worker` process, on a new BullMQ `ai` queue fed by outbox events. It never runs inside the transaction that saves a ticket or message. LLM calls happen outside database transactions. A short write transaction with a uniqueness guard makes every turn idempotent. Providers sit behind small ports (`ChatModel`, `DecisionModel`, `EmbeddingModel`, `CommerceConnector`), so direct Gemini, OpenAI or Claude adapters and other stores can be added later without touching tenant settings. Decisions: [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript 5 (strict) on Node.js 24 LTS (unchanged)

**Primary Dependencies**: Existing stack (NestJS 11, Kysely, BullMQ, Socket.IO, zod, React 19 + MUI 7 + TanStack Query + orval). New:
- `pgvector` extension (database), and the `pgvector` npm helper for Kysely value encoding
- `unpdf` (PDF text extraction in the worker)
- No provider SDKs. OpenRouter (chat, embeddings, decisions, key info) and the Spree Admin API v3 are called with `fetch` and their responses validated with zod (research R1, R9).

**Storage**: PostgreSQL 17 with pgvector (`pgvector/pgvector:0.8.7-pg17-trixie` image in dev, prod and Testcontainers). Policy source files go through the existing `FileStorage` and attachments pipeline. Valkey holds the model price cache and BullMQ deduplication.

**Testing**: Vitest + Supertest + Testcontainers (unchanged), with a `FakeAiProvider` and `FakeCommerceConnector` selected by `AI_PROVIDER=fake` / `COMMERCE_PROVIDER=fake`. CI never calls the network. Web tests use Vitest + RTL + MSW, and Playwright runs with the fake providers. A manual golden-set check with a real key (SC-006, SC-007) is in [quickstart.md](quickstart.md).

**Target Platform**: Unchanged (Docker Compose on the owner's VM). The worker makes outbound HTTPS calls to `openrouter.ai` and to tenant store URLs.

**Project Type**: Web application (existing monorepo: `apps/api`, `apps/web`, `apps/docs`)

**Performance Goals**:
- Auto-reply visible to the customer in ≤ 15 s for 90% of turns (SC-002). Budget: 3 s burst window + ≤ 1 s Jev + ≤ 2 tool rounds + ≤ 8 s model.
- A policy edit is active in ≤ 2 min (SC-003).
- Zero added latency to message send and ticket creation (SC-005).

**Constraints**:
- No LLM or network call inside a database transaction.
- Provider keys and store keys are never logged or returned (last 4 characters only).
- Message bodies are not logged (constitution X).
- Customer and policy text is treated as untrusted data in prompts (research R8).
- Each call has a timeout (chat 20 s, decisions 5 s, embeddings 15 s, store 5 s).

**Scale/Scope**: 4 stories, 28 FRs. One new API module (`ai`), one migration, about 18 endpoints, one new realtime event, 5 admin screens and 2 workspace touches (draft in the composer, Assistant author). Target is 30–40 tasks.

## Constitution Check

*GATE: must pass before Phase 0 research. Re-checked after Phase 1 design (below).*

| # | Principle | How the plan complies | Status |
|---|-----------|----------------------|--------|
| I | Tenant isolation | Every new table has `tenant_id`, `enable_tenant_rls`, and goes through `TenantRepository`. Jobs carry `tenantId` and run inside `withTenant`. Vector search is filtered by tenant in SQL and RLS. Store lookups use only the ticket's own customer email. Cross-tenant tests cover every new endpoint (R14). | ✅ |
| II | One authorization path | New permissions `ai_settings.manage`, `ai_knowledge.manage` and `ai_usage.view` are declared with `definePermissions` and checked by `@RequirePermission`. Draft access reuses the ticket reply access filter. | ✅ |
| III | Modules plug in | The `ai` module declares permissions, a repository, consumers and routes. The only kernel changes are one queue name and one author kind; no tenancy, auth or audit rewrites. | ✅ |
| IV | Database is the source of truth | Assistant messages, drafts, hand-offs and routing are written first, then published through the outbox. The `ai_turns` unique key makes retries idempotent (R6). | ✅ |
| V | Side effects are event-driven | `message.created` and `ticket.created` consumers enqueue `ai` jobs. Slow work (LLM, embeddings, PDF) runs only in the worker. | ✅ |
| VI | Security by default | Keys encrypted with AES-256-GCM (R2). Store URL passes an SSRF guard (R9). Uploads use the existing scan. Prompt-injection rules (R8). Order details are shown only on an email match, and a mismatch looks the same as not found. | ✅ |
| VII | Tests guard critical paths | Customer message routing is untouched except for one async consumer. Tests cover the triad plus cross-tenant for every endpoint, idempotency and burst, the order email check, the hand-off stop rule, and an e2e auto-reply with fake providers. | ✅ |
| VIII | Simple over clever | pgvector inside the existing Postgres instead of a vector DB. No provider SDKs. One queue. Infrastructure change is recorded below. | ✅ (see Complexity Tracking) |
| IX | Clean contracts | [contracts/ai.yaml](contracts/ai.yaml) uses explicit schemas and never returns keys or storage keys. Customer projection exposes only `authorKind: assistant` and the display name. | ✅ |
| X | Observable, without leaking | Each AI call is recorded in `ai_runs` (no content). pino redacts `authorization`, `x-spree-api-key` and `apiKey`. New metrics: `ai_job_duration`, `ai_provider_errors_total{kind}`. | ✅ |
| XI | Original, consistent UX | AI screens are built from the shared component system. Customers see "Assistant" as an author, never ticket concepts. | ✅ |
| — | Workflow | Lean process agreed 2026-10-08: specify → plan → tasks → implement; unit commits per `docs/commit-guidelines.md`. | ✅ |

**Result**: no violations. Phase 0 may proceed.

## Project Structure

### Documentation (this feature)

```text
specs/002-ai-assist/
├── spec.md
├── plan.md              # This file
├── research.md          # Decisions R1–R16
├── data-model.md        # Tables, states, scoring formula
├── quickstart.md        # Setup + validation scenarios (fake and real providers)
├── contracts/
│   ├── ai.yaml          # OpenAPI paths and schemas (tag: ai), merged into apps/api/openapi.yaml
│   └── realtime-events.md
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
compose.yaml, infra/compose.prod.yml       # postgres image → pgvector/pgvector:0.8.7-pg17-trixie
infra/postgres/init.sql                    # CREATE EXTENSION IF NOT EXISTS vector (superuser)
.env.example                               # REPLYX_SECRETS_KEY, AI_PROVIDER, COMMERCE_PROVIDER, OPENROUTER_BASE_URL

apps/api/
├── migrations/0017_ai.ts                  # ai tables, RLS, grants, author kind 'assistant', groups.ai_description
├── openapi.yaml                           # + tag ai, paths from contracts/ai.yaml
├── src/platform-kernel/
│   ├── crypto/secret-box.ts               # AES-256-GCM seal/open with key version (R2)
│   ├── http/outbound-guard.ts             # SSRF-safe URL check for tenant-supplied hosts (R9)
│   └── jobs/queues.ts                     # + 'ai'
├── src/ai/
│   ├── ai.module.ts, ai.permissions.ts
│   ├── providers/                         # ports + adapters
│   │   ├── ports.ts                       # ChatModel, DecisionModel, EmbeddingModel, ProviderError kinds
│   │   ├── openrouter/                    # chat (tools, json), embeddings, decisions, key info, prices
│   │   ├── fake/                          # scripted fakes for tests and e2e
│   │   └── catalog.ts                     # levels → selectable models, defaults, embedding model, Jev version
│   ├── settings/                          # ai_settings + store connection: service, controller, pause state
│   ├── knowledge/                         # documents, versions, chunker, extractor, indexer job, hybrid search
│   ├── commerce/                          # CommerceConnector port, spree-admin connector, fake
│   ├── decisions/                         # Jev question builder, routing job, complexity scorer
│   ├── assistant/                         # turn job: context, tools, guardrails, writer (reply|draft|handoff)
│   ├── drafts/                            # ai_drafts API, consumption consumer
│   ├── runs/                              # ai_runs recorder + list endpoint
│   └── consumers.ts                       # message.created / ticket.created → enqueue ai jobs
├── src/messaging/                         # author kind 'assistant' in DTOs and customer projection
└── test/{unit,integration,cross-tenant}/ai/

apps/web/src/
├── data/ai/                               # hooks over the generated client, draft socket handler
├── pages/admin/ai/                        # AiSettingsPage, PoliciesPage, PolicyEditor, ComplexityPage, AiUsagePage
├── pages/admin/groups/                    # + AI description field
├── pages/desk/ticket/                     # composer shows AI draft (use / discard); Assistant author chip
└── pages/customer/                        # Assistant author label
apps/web/e2e/ai-assist.spec.ts             # auto-reply + drafts with fake providers

apps/docs/src/content/docs/guides/ai-assist.md   # one guide at the end
```

**Structure Decision**: One new domain module, `apps/api/src/ai`, under the constitution's *Integrations* and *Routing & Automation* boundaries. It talks to Tickets and Messaging only through their public services (`TicketsService.applyLocked`, the message writer, history) and domain events. The web app adds one admin section, "AI", in the existing `AdminLayout`.

## Complexity Tracking

| Addition | Why needed | Simpler alternative rejected because |
|----------|------------|-------------------------------------|
| pgvector extension (Postgres image change) | Semantic policy search (FR-010) inside the existing database, with RLS and backups for free | A separate vector DB adds a service, backups and a tenancy layer. Full-text search alone misses paraphrased questions. |
| Outbound calls to tenant-supplied store URLs | Order lookup (FR-018) | No alternative; mitigated by the SSRF guard, timeouts and a read-only key |
| New `ai` BullMQ queue | Separates slow, rate-limited AI jobs from notifications and email, so AI backlog never delays them | Reusing `automation` would mix AI latency into automation SLAs |

## Constitution Check (post-design)

Re-checked after [data-model.md](data-model.md) and [contracts/](contracts/):
- Every new table is tenant-scoped with RLS.
- Keys are write-only in the contract.
- The customer projection exposes only `authorKind`/`isAi`.
- All network work sits in worker jobs outside transactions, guarded by the `ai_turns` unique key.

No new violations. Ready for `/speckit-tasks`.
