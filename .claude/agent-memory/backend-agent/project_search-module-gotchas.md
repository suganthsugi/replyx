---
name: search-module-gotchas
description: T230/T231 search (migration 0015, apps/api/src/search): extensions come from init.sql, unaccent needs IMMUTABLE wrapper, required-query GET routes break the generated cross-tenant test
metadata:
  type: project
---

- Migration number was 0015 (tasks.md said 0013). `pg_trgm`/`unaccent` already exist in `public` via infra/postgres/init.sql; migration uses `CREATE EXTENSION IF NOT EXISTS`. Generated tsvector columns use `public.replyx_unaccent()` (IMMUTABLE wrapper, apps/api/migrations/0015_search.ts); the columns are NOT in the Kysely table types, queries use `sql` fragments.
- A new GET route with a required query param (GET /search `q`) and a permission whose resource already has a fixture (`ticket.view`) is auto-enrolled in test/cross-tenant/cross-tenant.test.ts, which calls `route.path` with no query and expects 200, so it fails with 400. Fix is in test files (test-automator), not src.
- Smoke-testing in the dev stack: staff sign-in is POST /api/v1/auth/sign-in with `Host: globex.localhost`; `Secure` cookies are not kept by curl's jar over http, so parse Set-Cookie and send `Cookie:`/`X-CSRF-Token` manually. `agent@` lacks ticket.create; use `admin@globex.test` (password-123456). Windows bash curl -d mangles non-ASCII.
- Message sends need `clientMessageId`.
