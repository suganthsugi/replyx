---
name: macros-module-gotchas
description: T236 macros module facts - migration 0016, composite FK SET NULL, apply-macro composition, CRLF test fixtures
metadata:
  type: project
---

Macros live in `apps/api/src/macros/` (migration `0016_macros.ts`, tasks.md says 0014). Sharing reuses `ViewVisibilityRepository.canSee` from views (creator = `ownerId`).

- Composite FK with nullable column needs `ON DELETE SET NULL (created_by)` (PG15+, dev is PG17), plain SET NULL would null `tenant_id`.
- `POST /tickets/{id}/apply-macro` = lock ticket, `StaffMessagesService.insertMessage` (reply), re-lock, `TicketsService.applyLocked` (fields). `TicketsHttpModule` now exports `TicketsService`; `MacrosHttpModule` imports it. Reply and field changes are two history records (two event ids), same tx.
- `apps/api/test/cross-tenant/fixtures.ts` is CRLF; patch it with a node script that normalizes and restores CRLF. Route-name body keys are `Controller.method` (`MacroApplyController.apply`).
- Temp smoke test via `docker compose run --rm -T tools pnpm --filter api exec vitest run <file>` takes ~80 s (migrations rerun in Testcontainers).

**Why:** saves rediscovering the module layout when T237 (merge/split) and T239 tests touch it.
**How to apply:** extend `MacroApplyService` rather than duplicating ticket update logic.
