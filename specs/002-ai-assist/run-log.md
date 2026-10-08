# Run log: 002 AI Assist

## Resume here (2026-10-08)

**Next: US1, starting with T009** (settings backend). Phase 2 (T001–T008) is done. Create a new Jira Story for US1 first.

**Jira**:
- RX-23 (Phases 1–2) is Done. US1 needs a new Story.
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

## Environment notes

- **Phase 2 checkpoint (2026-10-09)**: run `pnpm turbo run lint typecheck test --concurrency=1`; with the default concurrency, web tests time out while the API concurrency suite runs. Lint, typecheck and web (80 files) pass. Known flaky API tests on a cold container, also failing on the pre-002 code: `sla/sla-notifications` "group viewers", and occasionally `notifications/notifications` and `tickets/staff-started` (async waits). They pass on rerun.

- **Python on Windows writes CRLF** in text mode; git normalizes on commit (autocrlf), but scripts that match multi-line text must normalize `
` first.

- **Local Spree for dev**: a local Spree checkout, started with `SPREE_PORT=3100 docker compose up -d` there. ReplyX reaches it at `http://host.docker.internal:3100`, with a read-only key in ReplyX `.env` (`SPREE_DEV_BASE_URL`, `SPREE_DEV_API_KEY`). It has no completed orders yet, so T019 must create one.
- **OpenRouter key**: the user pasted one in chat. Never store it; the user enters keys in the UI. Advise rotating it before T034.
- **Restart api and worker containers** after the env change (`docker compose up -d api worker`) before any browser check.
