---
name: review-recurring-checks
description: Recurring review misses in replyx (checkpoint evidence gaps, env/tooling traps) and how to run checks in this repo
metadata:
  type: project
---

- Host has no usable node_modules; run lint/tests via `docker compose exec -T api sh -c 'pnpm turbo run test lint'` (stack is usually up).
- Checkpoint evidence for Phase 1 omitted `turbo run test`; it failed because apps/web/vitest.config.ts lacked passWithNoTests. Always run the test task yourself, not only lint/typecheck.
- Per-app devDeps drift: apps/web/package.json lacked @vitest/coverage-v8 though scripts/check-coverage.sh needs it (pnpm is strict, api's copy is not visible).
- turbo 2 strict env mode: turbo.json needs passThroughEnv/globalPassThroughEnv for DATABASE_URL_*, TESTCONTAINERS_*, DOCKER_HOST, or tests lose them.
- Runtime images (USER node) need writable dirs pre-created for named volumes, e.g. /data/files in apps/api/Dockerfile.

- Kernel code queries tenant tables on a raw `tx` with RLS as the only tenant filter, e.g. `outbox_events` replay in apps/api/src/platform-kernel/realtime/sync.handler.ts. Grep `tx\.(selectFrom|updateTable|insertInto)` outside TenantRepository.
- Realtime ordering: the relay emitted inside its seq transaction, before commit, and the web client dropped any `seq <= cursor` while a sync replay was still arriving (apps/api/src/platform-kernel/outbox/relay.ts, apps/web/src/data/socket.ts). Check emit-after-commit and buffering during sync.

**Why:** Found in the 2026-09-24 Phase 1 review and the 2026-09-25 Phase 2 review; each would surface only later (CI, T045 Testcontainers, T200 prod).
**How to apply:** Check these on every setup/infra or story review.

- When a service distinguishes 409/403 vs 404 using a *history* table (not the caller's live view grant), check whether the history check uses only the caller's *current* permission — a caller who only recently gained access can probe old tickets/resources they never actually had visibility into and learn a historical fact via the conflict/not-found split. Example: apps/api/src/tickets/triage.service.ts `leftUngrouped()` gates ALREADY_TRIAGED (409, reveals "this ticket existed and left Ungrouped") vs TICKET_NOT_FOUND (404) purely on current `ticket.edit` on Ungrouped, not on whether the caller could see the ticket at the time it left Ungrouped.
- API integration tests run only through `docker compose run --rm -T tools bash -c 'cd apps/api && pnpm exec vitest run <files>'` (needs the docker socket; `exec api` fails with no container runtime). A test that passes alone can fail after another file: apps/api/test/integration/tickets/resolution.test.ts times out on socket events (5 s default in test/support/socket.ts) when run right after test/concurrency/auto-close-race.test.ts. Always run new socket tests after the heavy concurrency files.
- Settings-style forms that init state from the query and compare with `!==` stay dirty after save when the API trims or lowercases (apps/web/src/pages/admin/settings/OrganizationSettingsPage.tsx welcome/color).
- In a TanStack Query mutation's `onError`, a bare `void queryClient.fetchQuery(...)` (no `.catch`) can produce an unhandled promise rejection when the refetch itself 404s (e.g. re-fetching a ticket detail after ALREADY_TRIAGED when the ticket is no longer visible to the caller). Example: apps/web/src/data/triage.ts line ~58. Check mutation onError handlers that re-fetch for a trailing `.catch(() => {})` or equivalent.
- Destructive batch jobs: check the audit record is written in a `finally` (both retention jobs do since 2026-09-30; the confirm-count check is under the settings row lock in settings.service.ts) and that every irreversible setting change (ticket AND audit retention) has a confirm step; confirm dialogs must say deletion happens at the next daily run and the count may grow.
- Shared tree: other agents leave uncommitted edits (e.g. apps/web/src/pages/admin/settings/OrganizationSettingsPage.tsx retention UI) that contaminate targeted web test runs; check `git status` before blaming committed code. The first axe test in test/admin/organization-settings.test.tsx timed out at 20 s (cold start) in a 2026-09-30 run.
- Text built into `to_tsquery` from user input: restricting tokens to `[\p{L}\p{N}]+` in JS is not enough if SQL `unaccent` runs afterwards (`½`, `⑴`, `ʼ` expand to `1/2`, `(1)`, `'`), giving a tsquery syntax error and a 500. Example: apps/api/src/search/search.repository.ts `tsquery()`. Test such chars when a query is unaccented after tokenizing.
- Agents on Windows sometimes write cp1252 bytes (0x85 `…`, 0xB7 `·`) into .tsx, giving invalid UTF-8 and visible U+FFFD in the UI (apps/web/src/components/shell/CommandBar.tsx). Check with `iconv -f UTF-8 -t UTF-8 <file>` on changed web files.
- Web tests mock API error/status fields with human text while the API returns machine codes, so raw codes reach the UI unnoticed: policy `error` is `no_extractable_text` etc. but apps/web/test/ai/policies.test.tsx mocks 'No readable text in this file.' and apps/web/src/pages/admin/ai/PoliciesPage.tsx renders the code. Compare MSW fixtures with the API's real values.
- Staff file uploads (`POST /attachments`) need `ticket.edit`, not the feature's own permission; features that reuse the uploader (apps/api/src/ai/knowledge) break for a custom role holding only the feature key.
- Generated STORED tsvector columns + non-concurrent GIN builds (apps/api/migrations/0015_search.ts) rewrite and lock tickets/ticket_messages; flag on any migration touching big tables.
