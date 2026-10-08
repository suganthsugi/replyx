# Run log: 002 AI Assist

## Resume here (2026-10-09)

**Next: US3, starting with T019** (commerce connector; T020 can run alongside). US1 (T009–T013) and US2 (T014–T018) are built, reviewed and fixed. To close Stories RX-32 (US1) and RX-39 (US2), someone must apply migration 0018 to the dev DB (`docker compose run --rm -T tools sh -c "cd apps/api && pnpm migrate"`), restart api/worker/web, check `/desk/admin/ai` and `/desk/admin/ai/policies` in the browser and attach screenshots. **Ask the user before migrating or restarting**: they rejected doing it unprompted.

**Jira**:
- RX-23 (Phases 1–2) is Done. RX-32 is the US1 Story (In Progress, needs the screenshot); its tasks RX-33 to RX-37 are Done.
- RX-39 is the US2 Story (In Progress, needs the screenshot); its tasks RX-40 (T014), RX-41 (T015), RX-44 (T016), RX-42 (T017), RX-43 (T018) are Done.
- Tasks so far: RX-24 (T001), RX-25 (T002), RX-26 (T003), RX-27 (T004), RX-28 (T005), RX-29 (T006), RX-30 (T007), RX-31 (T008), all Done.
- Screenshots: `uploadAttachmentToJiraIssue` via `executeWrite` (phase 1 returns a curl command; run it, then embed the returned id inline in an html comment).
- RX is team-managed: a Task **cannot have a Story as parent** (the API rejects it). Write "Story: RX-n" in the description instead.
- Transitions by name: `In Progress`, `Done` (and `In Review`, `Blocked`).
- cloudId `f83a4d0c-9614-4404-8ea3-98d37ad873b8`.

**Process (lean, agreed with the user)**:
- Commit each task as `type(scope): Txxx Summary` with no co-author line.
- Tick the task in tasks.md and commit (`docs(specs): Txxx Tick Txxx`).
- Jira Task: create it In Progress, add a Done comment, transition to Done.
- One reviewer pass per story.
- Run all checks in Docker: `docker compose run --rm -T tools sh -c "cd apps/api && pnpm typecheck && pnpm lint && pnpm vitest run <paths>"`.

## Done so far

| Task | Commits | Notes |
|---|---|---|
| T001 | 42b4707, 81fc315 | Image is `pgvector/pgvector:0.8.7-pg17-trixie`. It **must be trixie**: the bookworm variant caused a glibc collation-version mismatch on the dev volume. `deploy.sh` creates `vector` as superuser before migrations. The dev DB already has vector 0.8.7. |
| T002 | e9893b1 | unpdf ^1.8.1, pgvector ^0.3.0 |
| T003 | 5ffa4b1 | Migration 0017_ai, applied to dev. The history actor is `ai`; message `metadata` is in `MESSAGE_COLUMNS`. Search full text is `to_tsvector('simple', public.replyx_unaccent(...))`; there is no `replyx_search` config, despite what the plan says. |
| T004 | 784c49b | `platform-kernel/crypto/secret-box.ts` (`SecretBox`, `last4`) and `platform-kernel/http/outbound-guard.ts` (`checkOutboundUrl`, `outboundRequest`, `OutboundRefusedError`; private hosts allowed only when `NODE_ENV=development`). Queue `ai` added. `test/support/env.ts` sets `REPLYX_SECRETS_KEY` and `AI_PROVIDER/COMMERCE_PROVIDER=fake`. |
| T005 | 2d806c7 | `ai/providers/{ports,catalog,provider-from-env}.ts`, `openrouter/`, `fake/`. Credentials are passed per call. The `AI_PROVIDER` symbol is in ports.ts; bind it in T006 via `providerFromEnv()`. There is no price cache: cost comes from the response, or is estimated with `costOf()`. |
| T006 | e7fe7df | `AiModule` is global (api + worker): `AI_PROVIDER`, `AiRunsRecorder.track()` (one `ai_runs` row per call; non-provider errors not recorded), `AiAudience.streamsFor(tx, ctx, permission)` (user streams of holders, else `tenant`). `ai.responder_scope_changed` is a control event: the staff gateway emits signal `ai.responder_scope_changed` to every socket in the tenant room (both namespaces); it has no seq. |
| T007 | 8e85511 | Merged with a text-splicing script (the yaml lib reflows existing descriptions). New fields on existing schemas are optional until the server emits them. Tag `ai` added to the api-conventions skill. |
| T008 | aca68d4 | Admin sections can be nested and grouped (`group: 'AI'`); `sectionFor()` picks the longest match. Page files: `AiSettingsPage`, `PoliciesPage`, `ComplexityPage`, `AiUsagePage` (placeholders). |
| T009 | cd31820, fixes 08d6db2, 316d40f | `ai/settings/` + `AiStatus` (shared). `ai.paused` is a notification type (migration 0018) written by `notifications/direct-notifier.ts`, not the ticket consumer. A connection test pauses/resumes only if the tested key is still the saved one. Removing the key resumes. Threshold: two decimals. `@RateLimit('ai-key-test')`, 10/min per tenant. |
| T010 | 56521b0 | Includes the `ai_settings` cross-tenant fixture (marker = A's last4; the model catalog is global). The "no ai job while paused" check is vacuous until US3; T026 must re-assert it. |
| T011 | e568cb0 | `data/ai/settings.ts`; `useAiSettingsEvents` handles pause/resume. The `user` stream resync keys belong to notifications, so settings refetch on mount/focus. |
| T012 | fca91cb, fix 6bb911e | `AiSettingsPage`; an `ai.paused` notification opens `/desk/admin/ai` (`notificationPage()` in NotificationCenter). |
| T013 | 49542de | `test/ai/settings.test.tsx`. |
| T014 | cb8df48, fixes d587aba, 0bfe49b | `ai/knowledge/ai-policies.*`. Title conflict 409 `POLICY_TITLE_TAKEN` (case-insensitive, unique index). Attachment problems are 400 on `attachmentId`; blocked scan 409 `ATTACHMENT_BLOCKED`. Delete soft-deletes and hard-deletes chunks; versions are kept. `RequireAnyPermission` added: `POST /attachments` takes `ticket.edit` or `ai_knowledge.manage`. `error` is an enum of the five DB codes. |
| T015 | edc1bf7, fix 2e937f4 | `ai-index` job in worker-only `AiJobsModule`; job id `index.{versionId}` (BullMQ rejects `:`). Scan wait: `moveToDelayed` every 15 s, 240 times. Chunk cap 500 → `too_large`; heading-only sections are chunks. A version whose document is deleted mid-job stays `processing` (the CHECK needs an error); nothing reads it. `PolicySearch` is exported from `AiModule`; it skips the embedding (text-only) when paused or without a key. |
| T016 | 206fc51, b45a111 | `ai_knowledge` cross-tenant fixture; `test/support/policies.ts` runs `AiIndexJob` directly. Races are deterministic (delete triggered inside the fake `embed`). |
| T017 | f94892e, fix 1b6d28c | `data/ai/policies.ts` (`policyErrorMessage`, `usePolicyEvents` also refreshes on `ai.policy_version_created`), `PoliciesPage`, `PolicyEditor` (dialogs, no new route), `components/data-display/PolicyStatusChip`. |
| T018 | bda9399, 1b6d28c | `test/ai/policies.test.tsx` (19 tests). |

## US1 review (2026-10-09)

Reviewer FAIL: 1 major (the notification preferences openapi schemas lacked `ai.paused`), 8 minors, 3 nits. All fixed in 08d6db2, 316d40f and 6bb911e. The AI, cross-tenant and notifications API suites pass (174), as do the web AI and notification tests.

## US2 review (2026-10-09)

Reviewer PASS with 2 majors (raw error codes shown in the UI; file upload needed `ticket.edit`), 5 minors and 3 nits. All fixed except nit 10 (version order by transaction start time, accepted). Re-review PASS. API: 144 targeted tests plus the 252-test AI/cross-tenant/authorization/attachments run pass; web `test/ai` passes. The full suite and coverage gate were not run.

## Environment notes

- **Phase 2 checkpoint (2026-10-09)**: run `pnpm turbo run lint typecheck test --concurrency=1`; with the default concurrency, web tests time out while the API concurrency suite runs. Lint, typecheck and web (80 files) pass. Known flaky API tests on a cold container, also failing on the pre-002 code: `sla/sla-notifications` "group viewers", and occasionally `notifications/notifications` and `tickets/staff-started` (async waits). They pass on rerun.

- **Python on Windows writes CRLF** in text mode; git normalizes on commit (autocrlf), but scripts that match multi-line text must normalize `
` first.

- **Local Spree for dev**: a local Spree checkout, started with `SPREE_PORT=3100 docker compose up -d` there. ReplyX reaches it at `http://host.docker.internal:3100`, with a read-only key in ReplyX `.env` (`SPREE_DEV_BASE_URL`, `SPREE_DEV_API_KEY`). It has no completed orders yet, so T019 must create one.
- **OpenRouter key**: the user pasted one in chat. Never store it; the user enters keys in the UI. Advise rotating it before T034.
- **Restart api and worker containers** after the env change (`docker compose up -d api worker`) before any browser check.
