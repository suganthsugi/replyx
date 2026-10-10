---
name: cross-module-service-export
description: How one domain module exposes a service for a sibling module to call directly (tags -> tickets/customers), matching the existing GROUP_TICKET_STATS token pattern
metadata:
  type: project
---

When a task says "export a small service method that <other in-progress module> can call" (e.g.
T138 tags exporting `assertTagsExist`/`setTicketTags` for T134 tickets), don't wire the caller side
yourself if that module is owned by another concurrent agent — just make the callee easy to
inject: `@Global()` module with `providers: [XService], exports: [XService]`, added to the `shared`
imports list in `apps/api/src/app.module.ts` (see `apps/api/src/tickets/tickets.module.ts`'s
`TicketsModule`/`GROUP_TICKET_STATS`, and `apps/api/src/tags/tags.module.ts`). A global module's
exports are available to every other module in the tree without an explicit `imports: [XModule]`
on the consumer, which is why `GroupsHttpModule` can `@Optional() @Inject(GROUP_TICKET_STATS)`
without importing `TicketsModule`.

**Why:** the consuming module (tickets, customers) is being edited concurrently by another agent
and is off-limits; this keeps the two changes independent and mergeable.

**How to apply:** methods the other module will call should take a `TenantTransaction` (not a
`TenantContext`) and derive the tenant scope from it via a local `requireScope(tx)` helper
(`tenantScopeOf(tx)`, throw if `undefined`) — tenant-scoping rule 4 — so the call joins the
caller's already-open transaction instead of opening a second one. Report the exact exported method
names/signatures in the handback so the other agent (or a later task) knows what's available; it's
normal for the concurrently-written module to have already inlined a duplicate placeholder (e.g.
tickets.repository.ts's own `TicketTagsRepository`) that a later task reconciles with the export.
