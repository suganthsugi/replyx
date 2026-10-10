---
name: force-rls-hides-rows-from-plain-psql
description: Direct psql against tenant-scoped tables (ticket_history, tickets, ...) always returns 0 rows unless app.tenant_id is set, even for the table owner
metadata:
  type: project
---

`enable_tenant_rls` (apps/api/migrations/0001_helpers.ts) runs `ALTER TABLE ... FORCE ROW LEVEL
SECURITY`, so RLS applies even to the table owner (`replyx_owner`). A bare
`docker compose exec postgres psql -U replyx_owner -d replyx -c "select ... from ticket_history"`
with no session variable set always returns 0 rows, regardless of whether data exists — this looks
exactly like a missing-write bug but isn't one.

**Why:** Spent a T157/US6 "history returns items: []" bug investigation chasing a phantom write-side
bug because the task's own suggested diagnostic (`select ... from ticket_history ... limit 20`) is
this exact false-negative query. TicketsService.update/TicketHistoryService.record/
ticket-history-query.service.ts were all correct; confirmed by setting
`select set_config('app.tenant_id', '<tenant-uuid>', true)` first, and by hitting the running dev
API directly (sign in, PATCH owner/priority/state as three separate requests like the desk UI does,
GET .../history?limit=50) — history rows and the read endpoint worked every time.

**How to apply:** Before trusting "no rows" from a direct psql query on any RLS-enabled table in
this repo, wrap it in `begin; select set_config('app.tenant_id', '<uuid>', true); select ...;
commit;` (or query via the app / an integration test) first. See [[project_postgres-rls-gotchas]]
for the related `current_setting` NULLIF gotcha in migrations.
