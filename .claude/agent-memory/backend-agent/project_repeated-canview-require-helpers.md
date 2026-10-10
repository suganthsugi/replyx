---
name: repeated-canview-require-helpers
description: tickets/messaging services each define their own private canView/require/SUPPORT access-check trio; follow that convention rather than extracting a shared helper
metadata:
  type: project
---

`tickets.service.ts`, `messaging/staff-messages.service.ts`, `tickets/ticket-links.service.ts` and
`tickets/message-move.service.ts` each define their own private `SUPPORT` sentinel,
`canView(access, groupId)` and a `require*(access, key, groupId)` (404 `notFound('ticket')` when
`decide()` returns `not_found`, 403 `permissionDenied()` on `deny`) instead of importing a shared
helper.

**Why:** this is the established repo convention (already duplicated 2x before I added a 3rd and
4th copy) rather than an oversight — `ticket-dto.ts` does not export these, and messaging already
imports other things from `tickets/ticket-dto.js`, so a shared export would have been easy to add,
but the codebase chose per-file duplication instead (keeps each service's operator/support-session
read-only handling colocated and easy to audit standalone).

**How to apply:** when adding a new tickets/messaging service that needs group-scoped access
checks, duplicate the small `canView`/`require`/`SUPPORT` trio locally rather than extracting a
shared module — matches reviewer expectations and avoids an unnecessary cross-module edit.
