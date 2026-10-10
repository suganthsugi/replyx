---
name: shared-cross-module-dto-helpers
description: TagsService (tags.service.ts) and ticket-dto.ts export reusable cross-module read/write helpers; tickets.repository.ts's TicketRow type is not re-exported from ticket-dto.ts
metadata:
  type: project
---

Two modules in `apps/api/src/` expose helpers other modules are meant to call instead of
re-deriving the same joins:

- `apps/api/src/tags/tags.service.ts` (`TagsModule` is `@Global()`, exports `TagsService`):
  `assertTagsExist(tx, tagIds)` (throws `notFound('tag')`, i.e. 404 `TAG_NOT_FOUND` — keep that
  code, don't translate it to a 400 validation error), `setTicketTags`/`setCustomerTags(tx, id,
  tagIds)`, `tagsByTicketIds`/`tagsByUserIds(tx, ids)` → `Map<id, TagDto[]>`. All take a
  `TenantTransaction` already opened by the caller's own `UnitOfWork.withTenant(ReadOnly)` and
  derive the tenant from it, so any module's `tx` can be passed straight through.
- `apps/api/src/tickets/ticket-dto.ts` exports `TicketSummaryDto`, `RefDto`, `PersonRefDto`,
  `toTicketSummary(row: TicketRow, refs: TicketRefs)`, and `TicketRefsRepository` (loads group and
  person names for a set of ticket rows). `toTicketSummary` hardcodes `tags: []` and
  `sla: { status: 'none' }` — overwrite `.tags` yourself (e.g. via `TagsService.tagsByTicketIds`)
  after calling it.

**Why:** T139 (customers module) first duplicated tag joins and ticket-summary building instead of
reusing these; the coordinator asked for a refactor pass to remove the duplication once T138
(tags) landed.

**How to apply:** before writing a join query another module already has a table/DTO for, check
that module's exported service/dto file first. Note `TicketRow` (the parameter type
`toTicketSummary`/`TicketRefsRepository.load` need) lives in `tickets/tickets.repository.ts`, not
`ticket-dto.ts` — a type-only import from there is a reasonable minimal bridge (build your own row
query selecting the same columns tickets.repository.ts's `TICKET_COLUMNS` does, convert `number`
from string), but flag it to the coordinator/orchestrator rather than assuming, since the owning
agent may prefer a re-export instead. See also [[project_cross-tenant-fixtures]].
