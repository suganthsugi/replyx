---
description: "Task list for AI Assist (first cut)"
---

# Tasks: AI Assist (first cut)

**Input**: Design documents from `specs/002-ai-assist/`
**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/ai.yaml](contracts/ai.yaml), [contracts/realtime-events.md](contracts/realtime-events.md), [quickstart.md](quickstart.md)

**Tests**: Included, because constitution VII requires them. Every endpoint gets the success / 403 / cross-tenant 404 triad. Tests follow implementation within each story, and a story is done only when its tests pass.

**Lean process (agreed 2026-10-08)**:
- Tasks are story-sized slices: 36 tasks, compared with 269 in spec 001.
- One reviewer pass per story.
- Jira: one Story issue per user story and one Task issue per task, no sub-tasks. Screenshots only on completed stories.
- One user guide at the end.
- Backend and web run in parallel once T007 has generated the client.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1 AI settings, US2 Policy knowledge, US3 Assistant, US4 Routing and complexity

## Path conventions

| Path | Owner agent |
|------|-------------|
| `apps/api/src/`, `apps/api/migrations/`, `apps/api/openapi.yaml`, `apps/api/package.json` | backend-agent |
| `apps/api/test/` | test-automator |
| `apps/web/src/components/`, `apps/web/src/pages/` | frontend-agent |
| `apps/web/src/data/` | frontend-connector |
| `apps/web/test/`, `apps/web/e2e/` | frontend-automator |
| `apps/docs/` | documentator |
| Repo root, `infra/`, `apps/web/src/routes/` | orchestrator (no specialist owns these) |

`apps/web/src/api/generated/` is regenerated with `bash scripts/generate-api-client.sh` after every task that changes `apps/api/openapi.yaml`. It is never edited by hand.

---

## Phase 1: Setup

- [X] T001 Switch Postgres to pgvector and add env:
  - Image `postgres:17` → `pgvector/pgvector:0.8.7-pg17-trixie` in `compose.yaml`, in both services of `infra/compose.prod.yml`, and in `apps/api/test/support/global-setup.ts`.
  - Add `CREATE EXTENSION IF NOT EXISTS vector;` to `infra/postgres/init.sql` (runs as superuser).
  - Add `REPLYX_SECRETS_KEY` (64 hex chars = 32 bytes), `AI_PROVIDER` (`fake`|`openrouter`, default `fake`), `COMMERCE_PROVIDER` (`fake`|`spree`, default `fake`) and `OPENROUTER_BASE_URL` (default `https://openrouter.ai`) to `.env.example`.
  - Add the one-off production step ("run `CREATE EXTENSION vector` as postgres before migration 0017") to `infra/README.md`. Create that file if it is missing.
- [X] T002 Add `unpdf` and `pgvector` to `apps/api/package.json`, then regenerate `pnpm-lock.yaml` in Docker (`docker compose run --rm tools pnpm install`).

---

## Phase 2: Foundational (blocks all stories)

- [X] T003 Write migration `apps/api/migrations/0017_ai.ts` and the Kysely types in `apps/api/src/platform-kernel/db/tables/ai.ts` (registered in the DB type), exactly per [data-model.md](data-model.md).
  - **Tables**: `ai_settings`, `ai_store_connections`, `ai_complexity_factors`, `ai_policy_documents`, `ai_policy_versions`, `ai_policy_chunks`, `ai_ticket_state`, `ai_turns`, `ai_drafts`, `ai_runs`.
  - **Every table**: `tenant_id`, `enable_tenant_rls` and `grant_app_dml`.
  - **Key constraints**:
    - `reply_mode` in `off|drafts|auto` default `off`
    - `routing_threshold numeric(3,2)` default 0.70 with check 0.50–0.99
    - `ai_policy_chunks.embedding vector(1536)` with an HNSW `vector_cosine_ops` index, plus a generated `search tsvector` using `replyx_search` with a GIN index
    - **UNIQUE (tenant_id, ticket_id, trigger_message_id)** on `ai_turns`
    - partial unique (tenant_id, ticket_id) where `status='open'` on `ai_drafts`
    - index (tenant_id, created_at desc) on `ai_runs`
  - **Changes to existing tables**:
    - `ticket_messages.author_kind` check adds `'assistant'`, plus a new column `metadata jsonb null`
    - `groups.ai_description text null` (≤ 500 chars)
    - `ticket_history` kinds `ai_routing`, `ai_handoff`, `ai_takeover`, `ai_handback`
  - Update `MessageAuthorKind` in `apps/api/src/platform-kernel/db/tables/tickets.ts`.
- [X] T004 [P] Kernel helpers:
  - `apps/api/src/platform-kernel/crypto/secret-box.ts`: AES-256-GCM `seal`/`open`, stored as `v1:<iv>:<tag>:<ciphertext>`, key from `REPLYX_SECRETS_KEY`, plus `last4()`.
  - `apps/api/src/platform-kernel/http/outbound-guard.ts`: https only; the DNS-resolved IP must not be private, loopback or link-local; no redirects; `http`/localhost allowed only when `NODE_ENV=development`.
  - Add `'ai'` to `QUEUE_NAMES` in `apps/api/src/platform-kernel/jobs/queues.ts`.
  - Add pino redaction paths `apiKey`, `authorization` and `x-spree-api-key` in `platform-kernel/observability`.
  - Unit tests in `apps/api/test/unit/kernel/`.
- [X] T005 [P] Provider layer in `apps/api/src/ai/providers/` (research R1, R5):
  - `ports.ts`: `ChatModel`, `DecisionModel` and `EmbeddingModel`, with `ProviderError` kinds `auth|credit|rate_limit|timeout|unavailable|bad_request`.
  - `openrouter/`: `fetch` + zod for chat completions with tools and `json_schema`, `/api/v1/embeddings`, `/api/alpha/decisions` and `/api/v1/key`. Every call sends `provider:{data_collection:"deny"}` and `usage:{include:true}`. Timeouts: chat 20 s, decisions 5 s, embeddings 15 s.
  - `fake/`: scripted responses keyed by markers such as `[fake:handoff]` and `[fake:order R100200]`, plus deterministic embeddings.
  - `catalog.ts`: levels and defaults (Fast `anthropic/claude-haiku-5.5`, Standard `google/gemini-3.1-flash-lite`, Advanced `anthropic/claude-sonnet-5.5`), embedding `openai/text-embedding-3-small`, decision `typesafe/jev-1.13`, and a daily Valkey price cache.
  - The provider is chosen by `AI_PROVIDER`.
  - Unit tests with mocked `fetch` in `apps/api/test/unit/ai/providers/`.
- [X] T006 AI module skeleton in `apps/api/src/ai/`:
  - `ai.module.ts`, registered in the api and worker modules.
  - `ai.permissions.ts` declaring `ai_settings.manage`, `ai_knowledge.manage` and `ai_usage.view`, granted to Admin by default.
  - `runs/ai-runs.recorder.ts`, which writes one `ai_runs` row per provider call (no content; `cost_usd` from the provider when given, else an estimate with `cost_estimated=true`).
  - Event types `ai.policy_version_created`, `ai.policy_version_updated`, `ai.draft_ready`, `ai.paused`, `ai.resumed`, `conversation.responder_changed` and `ai.responder_scope_changed` in `apps/api/src/platform-kernel/outbox/event-types.ts`, with realtime routing per [contracts/realtime-events.md](contracts/realtime-events.md).
- [X] T007 Merge the paths and schemas of [contracts/ai.yaml](contracts/ai.yaml) into `apps/api/openapi.yaml` under tag `ai`, including the `x-changes-to-existing` items:
  - `authorKind: assistant` on Message, and `isAi` in the customer projection
  - `responder` and `ai` on TicketDetail
  - `responder` on the customer conversation
  - `aiDraftId` on POST message
  - `aiDescription` on Group

  Then run `bash scripts/generate-api-client.sh` and commit the generated client.
- [X] T008 [P] Add an "AI" section to the admin navigation in `apps/web/src/pages/admin/AdminLayout.tsx`, with lazy routes `/admin/ai`, `/admin/ai/policies`, `/admin/ai/complexity` and `/admin/ai/usage` in `apps/web/src/routes/WorkspaceArea.tsx`. Each is gated by its permission and starts as a placeholder page in `apps/web/src/pages/admin/ai/`.

**Checkpoint**: migrations run, the client is generated, and `turbo run lint typecheck test` passes.

---

## Phase 3: User Story 1 - Admin turns on AI (P1) 🎯

**Goal**: A tenant saves its own OpenRouter key, tests it, picks the reply mode and the models per level, and AI pauses safely on a bad key or no credit.
**Independent test**: quickstart scenario 1.

- [X] T009 [US1] Settings backend in `apps/api/src/ai/settings/`:
  - **Endpoints**: `GET/PATCH /ai/settings`, `PUT/DELETE /ai/settings/provider-key`, `POST /ai/settings/provider-key/test` and `GET /ai/models`, all requiring `ai_settings.manage`.
  - **Validation**: `routingThreshold` 0.50–0.99; each `models.<level>` must be in the catalog for that level; `apiKey` 8–200 chars, write-only. Responses carry `last4` only.
  - **`AiStatus.isActive(tenantId)`**: true when (mode ≠ off or routing on), a key is set and the tenant is not paused.
  - **Pause**: on provider `auth`/`credit` errors, set `paused_reason`/`paused_at` and emit `ai.paused`, which notifies holders of `ai_settings.manage` once. A successful test or a key replace clears it and emits `ai.resumed`.
  - **Mode or pause changes** emit `ai.responder_scope_changed`.
  - **Audit**: every change is audited.
- [X] T010 [US1] API tests in `apps/api/test/integration/ai/settings.test.ts` and `apps/api/test/cross-tenant/ai-settings.test.ts`:
  - the triad plus cross-tenant 404 for every endpoint
  - the key is never in a response or a log line
  - an invalid model id gives 400
  - the fake provider's `auth` error pauses AI and a later test resumes it
  - while paused, a customer message produces no `ai` job
- [X] T011 [P] [US1] Data hooks in `apps/web/src/data/ai/settings.ts`: settings, models, key save/remove/test, and an `ai.paused`/`ai.resumed` socket handler that updates the settings cache.
- [X] T012 [US1] `apps/web/src/pages/admin/ai/AiSettingsPage.tsx`:
  - provider key field showing "•••• last4", with Replace and Remove
  - Test connection with a plain-language result
  - reply mode radio: Off, Drafts for agents, Auto-reply
  - model select per level showing the price per million tokens
  - "AI paused: <reason>" banner
- [X] T013 [US1] Web tests in `apps/web/test/ai/settings.test.tsx`: renders, saves, the test result, the paused banner, and an axe check.

**Checkpoint**: reviewer pass for US1; Jira Story to Done with a screenshot.

---

## Phase 4: User Story 2 - Policy knowledge (P1)

**Goal**: Admins add, edit and delete policies. A new version replaces the old one atomically and is searchable by meaning and by exact words.
**Independent test**: quickstart scenario 2.

- [X] T014 [US2] Policy API in `apps/api/src/ai/knowledge/`, requiring `ai_knowledge.manage`:
  - **Endpoints**: `GET/POST /ai/policies`, `GET/PATCH/DELETE /ai/policies/{id}`, `POST /ai/policies/{id}/versions`.
  - **Validation**: title 1–200 chars, unique per tenant among non-deleted documents (409 `POLICY_TITLE_TAKEN`). Exactly one of `text` (≤ 200 000 chars) or `attachmentId`; an attachment must be txt, md or pdf, ≤ 10 MB, uploaded by an admin.
  - **On create**: a version starts as `processing` and emits `ai.policy_version_created`.
  - **On delete**: soft-delete the document and hard-delete its chunks in the same transaction.
- [X] T015 [US2] Indexing job and retrieval in `apps/api/src/ai/knowledge/` (research R3, R4):
  - **`ai-index` job** (job id `index:{versionId}`):
    - waits while the attachment scan is pending, and fails with `blocked_by_scan` if blocked
    - extracts text (txt/md as-is, PDF via `unpdf`; empty text fails with `no_extractable_text`)
    - chunks by Markdown headings, then paragraphs, about 3 200 chars with 400 overlap
    - embeds in batches of 64, recording `embedding_model` per chunk
    - in one transaction: inserts the chunks, marks the version `active` and the previous one `superseded`, deletes the old chunks, and sets `active_version_id`
    - emits `ai.policy_version_updated`
  - **`PolicySearch.search(tenant, query)`**: vector top 20 + FTS top 20, fused with Reciprocal Rank Fusion (k=60), returning the top 6 `{ documentTitle, heading, content }`.
- [ ] T016 [US2] API tests in `apps/api/test/integration/ai/policies.test.ts` and `apps/api/test/cross-tenant/ai-policies.test.ts`:
  - the triad and cross-tenant cases
  - while a new version is processing, search returns only old-version chunks; after activation, only new ones
  - a deleted document is never returned
  - tenant A's search never returns tenant B's chunks
  - a PDF with no text fails with `no_extractable_text`
- [X] T017 [P] [US2] Data hooks `apps/web/src/data/ai/policies.ts` (with an `ai.policy_version_updated` handler), plus `apps/web/src/pages/admin/ai/PoliciesPage.tsx` and `PolicyEditor.tsx`:
  - a list with Processing/Ready/Failed status chips that update live
  - a "type text" or "upload file" choice that reuses the existing attachment uploader
  - edit, rename, and delete with confirmation
- [ ] T018 [US2] Web tests in `apps/web/test/ai/policies.test.tsx`: create by text, upload, live status change, delete, and an axe check.

**Checkpoint**: reviewer pass for US2; Jira Story to Done with a screenshot.

---

## Phase 5: User Story 3 - Assistant in the ticket conversation (P1)

**Goal**: Auto-replies and drafts grounded in policies and Spree orders. Hand-off to people, take over and hand back, SLA counting, and a live responder badge.
**Independent test**: quickstart scenarios 3–8 and 10–13.

- [ ] T019 [US3] Commerce connector in `apps/api/src/ai/commerce/` (research R9):
  - **`CommerceConnector` port**: `getOrder(number)` returns `{ number, email, state, shipmentState, completedAt, items[], shipments[{tracking, trackingUrl, state}] }`, plus `test()`.
  - **`SpreeAdminConnector`**: `GET {baseUrl}/api/v3/admin/orders?q[number_eq]=…&expand=line_items,shipments` with header `X-Spree-API-Key`, mapped through zod, 5 s timeout. **Verify the field and expand names against the live Spree 5.5.4 store (`https://store.example.com`) with the owner's read-only key before finishing.**
  - **`FakeCommerceConnector`**: fixtures `R100200` (seeded customer) and `R999999` (another email). Selected by `COMMERCE_PROVIDER`.
  - **Store connection endpoints** `GET/PUT/DELETE /ai/store-connection` and `POST /ai/store-connection/test` (`ai_settings.manage`): the URL must pass the outbound guard (400 `STORE_URL_NOT_ALLOWED`); the key is sealed and shown as last4.
- [ ] T020 [US3] Assistant author and SLA in `apps/api/src/messaging/` and `apps/api/src/sla/` (FR-012, FR-029):
  - **Messages**: add `authorKind 'assistant'` to the message DTOs, with author name "Assistant", and `isAi: true` in the customer projection (`customer-projection.ts`).
  - **Writer**: add an assistant message writer that reuses the staff reply path. A public answer sets `first_agent_reply_at` (if null) and `last_agent_reply_at` and moves `waiting_on` to `customer`. A message with `metadata.handoff=true` skips those.
  - **SLA**: the SLA consumer treats `authorKind in ('staff','assistant') && !metadata.handoff` as a reply.
  - **Notifications**: staff are not notified about assistant messages.
- [ ] T021 [US3] Trigger consumers and turn pipeline in `apps/api/src/ai/assistant/` and `apps/api/src/ai/consumers.ts` (research R6):
  - **`AiTriggerConsumer`** (`IdempotentHandler`, queue `ai`, `message.created`): for a public customer message when `isActive` and mode ≠ off, enqueue an `ai-turn` job with deduplication id `turn:{tenantId}:{ticketId}`, a 3 s delay, `extend + replace`.
  - **`StaffReplyConsumer`**: on a public staff message, set `ai_ticket_state.agent_replied_at`, mark the open draft `sent` (when the reply carried `aiDraftId`) or `superseded`, and emit `conversation.responder_changed` if the responder changed.
  - **`ai-turn` job phases**:
    1. **Read**: a read-only transaction loads the settings, ticket state, the last 20 public messages and the summary. The trigger is the latest customer message.
    2. **Think**: no transaction (T022).
    3. **Write**: one transaction. Lock `ai_ticket_state FOR UPDATE`; re-check mode ≠ off, not stopped, no newer customer message and no staff reply since the read; insert into `ai_turns` (a duplicate key means exit quietly); then write the reply, draft or hand-off.
  - **Context**: summarise messages older than the last 20 with the Fast model into `ai_ticket_state.summary`.
- [ ] T022 [US3] Assistant decision logic in `apps/api/src/ai/assistant/` (research R7, R8):
  - **One Jev call per turn** (state = last 6 messages) with `wants_human` (yes/no), `refund_or_exception` (yes/no) and `frustration` (score: calm/annoyed/angry). Hand off if a yes/no is ≥ 0.7 or angry is ≥ 0.6.
  - **Chat model** at the Fast level (US4 adds the level choice), with tools `search_policies(query)`, `lookup_order(orderNumber)` (argument `[A-Za-z0-9-]{3,32}`; order details only when the order email matches the ticket customer's email case-insensitively, otherwise the `not_found` result) and `handoff(reason)`. At most 3 tool rounds.
  - **Output**: JSON schema `{ reply, confidence, awaiting, resolved }`. Hand off when `confidence < 0.6` or after 2 unresolved turns in a row.
  - **System prompt**: grounded answers only, no promises of refunds, exceptions, discounts or compensation; customer text, policies and orders wrapped in tagged blocks.
  - **Hand-off writer**:
    - set `stopped_reason`
    - add a history entry `ai_handoff`
    - add the tenant tag "AI hand-off", creating it on first use
    - set `waiting_on=support`
    - in auto mode only, post one fixed localized hand-off message with `metadata.handoff=true`
  - **While generating**: the assistant typing presence is on, and one `ai_runs` row is recorded per provider call.
  - **Failures**: on provider `auth`/`credit`, pause the tenant (T009). After the last retry on other errors, hand off with reason `ai_unavailable`.
- [ ] T023 [US3] Drafts in `apps/api/src/ai/drafts/` (research R13):
  - drafts mode upserts the single open `ai_drafts` row and emits `ai.draft_ready`
  - `GET /tickets/{id}/ai-draft` (404 `AI_DRAFT_NOT_FOUND`) and `POST /tickets/{id}/ai-draft/discard`, both with ticket reply access
  - `POST /tickets/{id}/messages` accepts an optional `aiDraftId`
- [ ] T024 [US3] Take over, hand back and responder (research R17, R18):
  - **`POST /tickets/{id}/ai/takeover`** (ticket edit access) goes through `TicketsService.applyLocked`: owner = caller (409 `OWNER_NOT_ALLOWED`), `stopped_reason='taken_over'`, `taken_over_by`, history `ai_takeover`, audit. Taking over again as the same user returns 200 with no change.
  - **`POST /tickets/{id}/ai/handback`** (409 `AI_NOT_IN_AUTO_MODE` / `AI_PAUSED`) clears the stop fields, `unresolved_turns` and the owner, and adds history `ai_handback`.
  - **Responder** (assistant | agent | team, per [data-model.md](data-model.md)): add `responder` and `ai {stopped, stoppedReason, canTakeOver, canHandBack}` to TicketDetail, and `responder` to the customer conversation projection.
  - **Events**: emit `conversation.responder_changed` on owner change, stop, hand back and hand-off; emit `ai.responder_scope_changed` on mode or pause change.
- [ ] T025 [P] [US3] `GET /ai/runs` in `apps/api/src/ai/runs/` (`ai_usage.view`): cursor pagination with `from`, `to` and `purpose` filters, plus totals `{ runs, costUsd }` for the filter.
- [ ] T026 [US3] API tests in `apps/api/test/integration/ai/assistant.test.ts` and `apps/api/test/cross-tenant/ai-assistant.test.ts`, using the fake providers:
  - **Conversation and orders**:
    - "where is my order" then `R100200` gives the status; `R999999` gives the same reply as an unknown number
    - a policy answer
  - **Idempotency**:
    - running the same turn job twice produces one message
    - 3 messages in 2 s produce one reply
  - **Stop rules**:
    - `[fake:handoff]` gives one hand-off message, the tag and the stop
    - after a staff reply there is no auto-reply
  - **Take over and hand back**:
    - takeover sets the owner and stops the assistant; hand back resumes it
    - an in-flight turn is discarded after a takeover
  - **SLA**:
    - an assistant answer meets first response
    - a hand-off message alone does not
  - **Other**:
    - drafts mode creates a draft, the customer sees nothing, and sending with `aiDraftId` marks it sent
    - a paused tenant behaves like Off
    - store connection: the outbound guard rejects private IPs
  - **Isolation**: cross-tenant 404 for the store connection, drafts, takeover/handback and runs.
- [ ] T027 [P] [US3] Data hooks in `apps/web/src/data/ai/`:
  - `storeConnection.ts`, `drafts.ts` (`ai.draft_ready` handler), `takeover.ts` (takeover and handback mutations) and `runs.ts`
  - `responder.ts`: a `conversation.responder_changed` / `ai.responder_scope_changed` handler that updates the ticket detail cache and the customer conversation cache
- [ ] T028 [US3] UI:
  - **`ResponderBadge`** in `apps/web/src/components/ResponderBadge.tsx`: the Assistant variant has an animated shining `linear-gradient` sheen (about 3 s loop) that is static under `prefers-reduced-motion`, with text contrast ≥ 4.5:1 on every stop. The agent variant shows avatar and name; the team variant shows "Support team". `aria-live="polite"` announces "Now replying: …".
  - **Where it appears**: at the top of the ticket conversation in `apps/web/src/pages/desk/ticket/` and the customer chat header in `apps/web/src/pages/customer/`.
  - **Ticket view**: Take over and Hand back to AI buttons per `ai.canTakeOver`/`canHandBack`, and an "AI draft — Use / Discard" bar above the composer.
  - **Threads**: an "Assistant · AI" author chip in the staff and customer threads.
  - **Admin**: a store connection panel in `AiSettingsPage.tsx` and `apps/web/src/pages/admin/ai/AiUsagePage.tsx` (filters, table, totals).
- [ ] T029 [US3] Web and e2e tests:
  - **Web tests** in `apps/web/test/ai/assistant.test.tsx`:
    - the badge variants, with an axe check
    - reduced motion stops the animation
    - takeover/handback buttons
    - draft Use/Discard
    - usage table
  - **Playwright** `apps/web/e2e/ai-assist.spec.ts` (fake providers):
    - the auto-reply order conversation
    - the badge switching on takeover and hand back, on both the agent and customer pages
    - drafts mode Use and send
    - an axe check on the badge

**Checkpoint**: reviewer pass for US3; Jira Story to Done with screenshots of the badge, the draft and the chat.

---

## Phase 6: User Story 4 - Jev routing and complexity (P2)

**Goal**: Tickets that no rule matched are routed by Jev to groups with AI descriptions. The complexity score picks the model level.
**Independent test**: quickstart scenario 9, and the usage list shows the chosen levels.

- [ ] T030 [US4] Backend:
  - **Group AI description**: `aiDescription` on groups (≤ 500 chars, nullable; editing needs `ai_settings.manage`) in `apps/api/src/groups/`.
  - **`ai-route` job** in `apps/api/src/ai/decisions/` (job id `route:{ticketId}`, from `ticket.created`) runs only when:
    - routing is enabled and AI is active
    - the ticket has `origin=customer` and is still ungrouped
    - its history has no `routing` entry

    It asks one `choice` question over active groups that have a description, plus `none`. If the choice is not `none` and its probability is ≥ the threshold, it applies the group via `TicketsService.applyLocked` (only if still ungrouped) and writes history `ai_routing {groupId, confidence}`. On failure the ticket stays in Needs Triage.
  - **Complexity config** `GET/PUT /ai/complexity`:
    - at most 12 factors, at least one weight > 0
    - `key` matches `^[a-z][a-z0-9_]{0,39}$` and is unique
    - choice factors have 2–8 options with `value` 0..1; score factors have 2–7 levels
    - 0 < standard < advanced < 1
    - field-level 400s
    - default factors seeded on the first enable (research R12)
  - **`ComplexityScorer`**: adds the factor questions to the turn's single Jev call and computes Σw·v/Σw → level (Fast if no factors or on failure). The level and score are recorded on `ai_turns` and `ai_runs`.
- [ ] T031 [US4] API tests in `apps/api/test/integration/ai/routing.test.ts` and `apps/api/test/cross-tenant/ai-complexity.test.ts`:
  - a matching rule wins and Jev is not called
  - routing below the threshold leaves the ticket ungrouped
  - manual triage during the job wins
  - an inactive group or one without a description is never chosen
  - complexity validation errors
  - a high-score fixture uses the Advanced level
  - the triad and cross-tenant cases
- [ ] T032 [P] [US4] UI:
  - `apps/web/src/data/ai/complexity.ts` hooks
  - `apps/web/src/pages/admin/ai/ComplexityPage.tsx`: a factor list with add, reorder and remove; type-specific fields; weight sliders; and two threshold sliders with a live preview of the Fast/Standard/Advanced bands
  - routing toggle and threshold on `AiSettingsPage.tsx`
  - an "AI description" field in `apps/web/src/pages/admin/groups/`
- [ ] T033 [US4] Web tests in `apps/web/test/ai/complexity.test.tsx`: add/edit/validate factors, the threshold order error, the group AI description, and an axe check.

**Checkpoint**: reviewer pass for US4; Jira Story to Done with a screenshot.

---

## Phase 7: Polish

- [ ] T034 Golden set: write `specs/002-ai-assist/golden/policy.md` (sample return, refund and shipping policy) and `specs/002-ai-assist/golden/questions.md` (20 questions with expected answer or "hand-off"). Then run the real-provider check in [quickstart.md](quickstart.md) with the owner's OpenRouter key and Spree key, and record the results in `specs/002-ai-assist/golden/results.md`. SC-006 needs ≥ 18/20; SC-007 needs Advanced ≤ 2/20.
- [ ] T035 [P] User guide `apps/docs/src/content/docs/guides/ai-assist.md`, plus a sidebar entry. It covers:
  - setting up an OpenRouter key and a spending cap
  - reply modes
  - policies
  - connecting Spree with a read-only key
  - hand-off, take over and hand back
  - the badge
  - routing and complexity
  - usage
- [ ] T036 Final checks: `docker compose run --rm tools pnpm turbo run lint typecheck test` and the e2e suite pass. Note the deploy steps in `infra/README.md` (pgvector extension, `REPLYX_SECRETS_KEY`). Add a "Superseded by 002" note to the AI line in `specs/001-multi-tenant-helpdesk/spec.md` Assumptions. Record the session in `specs/002-ai-assist/run-log.md`.

---

## Dependencies

- **Setup → Foundational → stories.** T003 needs T001. T005 and T004 run in parallel. T007 needs T003 and T006.
- **US1** needs only Phase 2.
- **US2** needs Phase 2 (and the existing attachments module).
- **US3** needs US1 (key, mode, pause) and US2 (search). T019 and T020 can start alongside US2.
- **US4** needs US1 and plugs into the US3 turn (T022) for the level choice. Routing (part of T030) needs only US1.
- Within a story: backend → API tests ∥ data hooks → UI → web tests.

## Parallel examples

- **Phase 2**: T004 ∥ T005 ∥ T008 (T008 needs nothing from the API).
- **US1**: after T009, T010 (test-automator) ∥ T011 → T012 (connector, frontend).
- **US2 ∥ US3 start**: T014–T015 (knowledge) ∥ T019 (commerce) ∥ T020 (author and SLA).
- **US3**: T025 ∥ T023 once T021 is in. T027 ∥ T026 once T024 is in.
- **US4**: T032 UI ∥ T031 tests after T030.

## Implementation strategy

1. **MVP = Phases 1–5** (US1–US3): a tenant can turn on AI, load policies, and have the assistant answer orders and policy questions with hand-off, takeover and the badge. Ship after the US3 checkpoint.
2. **US4** follows immediately: routing plus the complexity levels.
3. **Polish**: the golden set with real providers, the guide, and deploy notes.

## Notes

- Mark each task `[X]` in this file right after its commit.
- Commits are one-line conventional messages per `docs/commit-guidelines.md` (`type(scope): Txxx Summary`), made by the committer agent.
- The owner must create a read-only Spree secret key (orders and customers) before T019 can verify the live API fields, and an OpenRouter key before T034.
