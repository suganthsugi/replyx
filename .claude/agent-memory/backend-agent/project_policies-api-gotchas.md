---
name: policies-api-gotchas
description: T014 policy API (apps/api/src/ai/knowledge/) - openapi yaml colon bug, host pnpm install by generate script, cross-tenant fixture for ai_knowledge needed
metadata:
  type: project
---
- openapi.yaml had `description: Uploaded via ...; txt, md or pdf, ≤ 10 MB` mangled into sibling null keys (unquoted comma/colon text); quote descriptions that contain `:`.
- `bash scripts/generate-api-client.sh` runs a ~4 min host `pnpm install` first; afterwards `git checkout` any generated file that shows only LF/CRLF noise (e.g. model/ticketAllOfOrigin.ts).
- A new `@RequirePermission('x.y')` resource needs a `FIXTURES[resource]` entry in test/cross-tenant/fixtures.ts (test-automator) or 6 generated cross-tenant tests fail with "No cross-tenant fixture for ai_knowledge".
- Kysely: `distinctOn` exists on selectFrom helper results; left-join composite on tenant_id works for file name / creator name.
- Quick smoke: write a temp test in test/integration/ai/, run via `docker compose run --rm -T tools sh -c "cd apps/api && pnpm vitest run <file>"`, then delete it.
