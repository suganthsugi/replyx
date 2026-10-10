---
name: notfound-and-jsonb-typing
description: notFound() needs a snake_case resource (a space makes an invalid code and a 500); type typed-jsonb columns as ColumnType<Obj, string, string>
metadata:
  type: project
---
- `notFound('routing rule')` builds code `ROUTING RULE_NOT_FOUND`, which fails the AppError code regex and surfaces as a 500. Pass `'routing_rule'` (apps/api/src/platform-kernel/http/app-error.ts).
- For a jsonb column with its own interface, declare `ColumnType<Obj, string | undefined, string>` (apps/api/src/platform-kernel/db/tables/routing.ts) so the compiler forces `JSON.stringify` on writes; a plain `Generated<Obj>` type-checks an object insert that the pg driver then rejects.
- Validation failures are always 400 `VALIDATION_FAILED` (no 422 in this API), including "referenced group/tag does not exist" (`invalid_value` on the path).
