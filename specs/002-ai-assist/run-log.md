# Run log: 002 AI Assist

## Resume here (2026-10-10, second session)

**Next: T034's real-model run. It needs an OpenRouter key re-entered in acme (Admin → AI); see `golden/results.md` for the steps. Everything else is done.**

Status:
- **Ticked**: T001–T033, T035, T036. **Open**: T034 (Jira RX-64, Blocked).
- **T029** (f0c1938): after `docker compose restart api worker web`, `--project desktop-ai --no-deps` passes. Screenshots are in `specs/002-ai-assist/screenshots/` (b6c5be4) and attached to RX-45 (US3) and RX-57 (US4). RX-56, RX-45 and RX-57 are Done.
- **T034**: golden `policy.md`, `questions.md` and the runner `run-golden.mjs` (d970b04); `results.md` holds the dry run and the run steps. Local Spree now has test orders R100201 (paid, not shipped), R100202 (canceled) and R100300 (someone.else@example.com), created with `bin/rails runner` in the ecom `web` container. The dry run (fake AI, real Spree) passed the harness and the store path. The **acme OpenRouter key is gone**: the `ai-assist` e2e `finally` deletes the tenant's key, and it ran on a tenant with the user's real key (last4 0001). A backup of the sealed row was taken first, but restoring it by SQL was refused by the permission classifier, so the user has to paste the key again. Before running that spec on a tenant with a real key, back the key up or point the spec elsewhere.
- **Local Spree from ReplyX containers**: use `http://192.168.65.254:3100` (Docker Desktop host gateway). Rails in development refuses the `host.docker.internal` name (403) but allows IP hosts, so ecom needs no change. Node `fetch` drops a `Host` header, so scripts that call the API by tenant host use `node:http` (as `run-golden.mjs` does). In Git Bash, `docker compose exec ... /repo/...` needs `MSYS_NO_PATHCONV=1`.
- **US3 review item #6 closed**: the dev key with exactly `read_orders`, `read_customers` and `read_fulfillments` reads orders with `expand=items,fulfillments`.
- **T036 final checks (Jira RX-63)**:
  - `turbo run lint typecheck test --concurrency=1`: all pass. API 1396 tests, web 721.
  - Coverage gate `scripts/check-coverage.sh`: passes. API 93.4% lines (needs 80), web 83.3% (needs 70).
  - Fixes made to get there: the complexity factor test pastes long text (ab8da8d), the threshold test uses PageDown (45110a7), the SLA notification tests get a tenant each (policies tied on position leaked between tests, d5fa397), the test sweeper visits only the file's own tenants (whole-database sweeps timed out as the suite grew, 017374e), and the "Searching…" test holds its response (97d4d13).
  - Full e2e (`--workers=2`): 18 of 20 specs pass. Fixes along the way: the ticket row check box is presentational, because axe flagged a checkbox nested in the option (7faed34); the ticket column scrolls on phones, because the 002 header growth squeezed the composer over its own Send button (3fee250); and sign-out-everywhere uses the keyboard on phones (7ef3cb2).
  - Two specs fail on **dev data, not code**: `triage` and `view-builder` assume Manager has no Support access and Agent has no Billing access. Someone edited the Agent, Manager and Support Agent roles in the UI at 11:46–11:47 UTC on 2026-10-10 (see the audit log), giving them those groups. Reset the roles (or reseed) and both should pass.
  - Run e2e with AI off in acme: a leftover Auto-reply mode answers the SLA spec's customer, and the first-response target then shows as met.
  - The deploy notes (27d9a4b) and the 001 superseded note (19634a4) were done earlier.
- `.env` is back to `AI_PROVIDER=fake` and `COMMERCE_PROVIDER=fake`. acme: AI off, no key, store connection saved for `http://192.168.65.254:3100`, and the "Golden: returns, refunds and shipping" policy is loaded.

**US3 review (2026-10-10)**: the reviewer's pass was partial, because it hit its turn limit. Verdict FAIL with 1 major and 7 minors. Fixed:
- the major: badge caption opacity could drop contrast below 4.5:1 (42da0cf, plus a contrast test over light and dark themes and near-threshold accents)
- the customer responder event coming from a non-active ticket (0e8c897)
- the summary failure on the last attempt (a3c80e6)
- the outbound guard resolver injected, with the rebinding and mixed-address tests restored (b8410fa)
- the store removal toast (f0539d3)
- the same-tenant 404 tests (32da95d)

Open:
- **#6**: the Spree key scopes listed in the UI (`read_orders`, `read_customers`, `read_fulfillments`) need confirming against the live store.
- **#8 (declined)**: `COMMERCE_PROVIDER` defaults to fake outside production. This is the same rule as `AI_PROVIDER`; prod compose pins `NODE_ENV=production`, and dev runs with `NODE_ENV` unset.
- Nits not taken: take over replaces a hand-off reason, so drafts resume in Drafts mode; discard writes no audit entry or event; `access-loss.consumer` builds `ResponderService` inline.

Not reviewed: AiUsagePage, the runs and store connection hooks, and the e2e spec.

**US4 review (2026-10-10)**: PASS, with 1 major and 9 minors. Fixed:
- the major: focus kept on move and remove, with stale index-keyed field errors cleared through the new `Form` `resetErrorKey`, no remount after a save, and a clearer empty state (2d5e2a8)
- a screen hand-off records no level (4d2f954)
- defaults are seeded whenever AI is on and no factors exist (82fe93b)
- a routed group change is credited to `ai` in the history (62a5710)

Accepted: a failed route write asks the model again on retry; shape and tag validation errors come back in two rounds. Flaky under full load, passes alone: `tickets/triage.test.ts` "visibleToCaller false".

**US4 decisions (T030)**: factor questions go into the turn's single Jev call as `cx_<key>`, so they never collide with the hand-off questions (the default `frustration` factor is asked separately from the hand-off `frustration`). PUT validation is a strict union per kind. Cross-field issues: `duplicate`, `no_positive_weight` (on `factors`), `not_above_standard` (on `thresholds.advanced`), and `not_found` (on `factors.i.tagId`). Defaults are seeded when the reply mode leaves Off or routing turns on, if the tenant has no factors. The VIP factor is seeded only if a tag named "VIP" exists. The `ai-route` consumer name is `ai-route-trigger`, because consumer and job names share a registry. The route job moves the ticket through `applyLocked` with the `SUPPORT` viewer (moving out of Ungrouped needs no group permission). The group-change history entry is by `system`, plus an `ai_routing` entry by `ai`. `TicketsService` is provided in `AiJobsModule` for the worker.

**US3 decisions**: "customer on unassigned" notifications are suppressed only while the assistant answers in auto mode (`isAssistantAnswering`); drafts mode still pings. Changing the store's origin requires re-entering its key. Spree: expand `items,fulfillments`; `status` is not reliable for completion. A stop after a staff reply shows `stoppedReason: null` (the contract enum has no `agent_replied`). The hand-off notice is English only. The scope signal `ai.responder_scope_changed` is a bare socket event, received through `RealtimeClient.onSignal`. Local Spree has test order R100200 for customer@acme.test, but Spree's Rails host authorization blocks `host.docker.internal` (403), so the running app can't reach it until the user allows that host in `ecom`. A client regeneration once left `apps/web/src/api/generated/` deleted: after regenerating, check for `D` lines.

**Jira**:
- RX-23 (Phases 1–2) is Done. RX-32 is the US1 Story (Done, screenshot attached); its tasks RX-33 to RX-37 are Done.
- RX-39 is the US2 Story (Done, screenshots attached); its tasks RX-40 (T014), RX-41 (T015), RX-44 (T016), RX-42 (T017), RX-43 (T018) are Done.
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
