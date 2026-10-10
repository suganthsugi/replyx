---
name: quick-migration-verify
description: Fast way to verify a new migration's RLS/constraints/grants without waiting on the full test-affected run
metadata:
  type: project
---

For a schema-only migration task, `bash scripts/test-affected.sh` under `docker compose run --rm tools`
mostly picks up unrelated `apps/web` tests (whatever changed since HEAD in the working tree) and can
take minutes; it doesn't exercise the new tables directly since no service code was added yet.

Faster, direct checks after `pnpm --filter api migrate` applies the new migration (all via
`docker compose exec -T postgres psql -U replyx_owner -d replyx -c "..."`, [[host-tooling]]):
- `\d+ <table>` shows columns/defaults, check constraints, FKs, indexes, and confirms
  "Policies (forced row security enabled)" with the `tenant_isolation` policy text.
- `SELECT table_name, grantee, string_agg(privilege_type, ',') FROM information_schema.role_table_grants
  WHERE table_name IN (...) AND grantee IN ('replyx_app','replyx_platform') GROUP BY 1,2;` confirms
  `grant_app_dml`/`grant_platform_dml` actually landed on the right role.

**Why:** confirmed on T133 (`0009_tags_views.ts`) — this caught and displayed every constraint,
index and the RLS policy directly, in seconds, instead of inferring correctness from a green but
unrelated web test run.

**How to apply:** for any schema-only migration task, run these two checks per new table in addition
to (not instead of) `pnpm --filter api migrate` and typecheck/lint, since `test-affected.sh` may not
prove anything about tables no code yet queries.
