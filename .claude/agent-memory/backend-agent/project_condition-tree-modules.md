---
name: condition-tree-modules
description: How to build a jsonb condition-tree compiler (views, routing_rules, automation_rules, sla_policies) without ajv
metadata:
  type: project
---

`apps/api` has no `ajv` dependency. data-model.md describes several `jsonb conditions` trees
(views T140, routing_rules, automation_rules, sla_policies) as "validated by JSON Schema", but in
practice they're validated with a recursive `zod` schema (`z.lazy`) mirroring the
`contracts/*.yaml` `ConditionGroup`/`Condition` shape, plus a manual tree-walk for anything a
single JSON Schema can't express (per-field operator whitelist, total leaf-condition count across
the whole tree, max nesting depth). See `apps/api/src/views/condition-schema.ts` +
`view-compiler.ts` (T140) for the pattern: structural zod parse first, then `walk()` for depth/
count/semantic checks, throwing `AppError` via `validationFailed(toDetails(...))` so error shape
matches the rest of the API.

**Why:** ajv isn't installed and api-conventions already mandates zod `.strict()` for all input
validation; reusing it avoids a second validation library for one feature.

**How to apply:** when a later task (automation_rules, routing_rules, sla_policies conditions)
needs "JSON Schema" validation per data-model.md, reuse this same recursive-zod-plus-walk shape
instead of reaching for ajv, unless a reviewer says otherwise.

**Gotcha (T141, caught by a failing `test/integration/realtime/session-expiry.test.ts`):**
Kysely's `insertInto`/`Insertable` typing accepts a plain JS object/array for a `jsonb` column
(e.g. `conditions`, `sort` on `views`), but the `pg` driver does NOT serialize it — it sends
`.toString()` and Postgres rejects it ("invalid input syntax for type json"). Always
`JSON.stringify(...)` the value before inserting into a jsonb column (see
`ticket-history.service.ts` `old_value`/`new_value`, `outbox.service.ts` `payload`/`cause`,
`audit.service.ts` `details`, and now `default-views.contributor.ts`). A raw `sql` template with
an explicit `::jsonb` cast (as in a migration) also needs the value pre-stringified. This bug is
invisible to `tsc`/`eslint` — only an integration test that actually inserts a row catches it.

**Correction (coordinator decision during T140 review):** data-model.md's field whitelist text for
views ("state, priority, group, owner, customer, tags, waiting_on, created_at, updated_at,
last_customer_message_at, sla_status") is incomplete — the default view "My Pending Reminders
Reached" needs `pending_until`, which is now also in `CONDITION_FIELDS`/`FIELD_OPERATORS`
(`before`/`after`/`within_last`, same as the other timestamp fields). `before`/`after` also accept
the relative literal `"now"` (`NOW_LITERAL` in condition-schema.ts), resolved from the compiler's
`now` param, not `Date.now()`. The exact condition for "pending_until before now":
`{ "field": "pending_until", "operator": "before", "value": "now" }`. When a data-model.md
whitelist looks incomplete against its own "Default view conditions" table, flag it rather than
silently implementing only the documented subset.
