---
name: postgres-rls-gotchas
description: Verified pitfalls when testing infra/postgres/init.sql roles and RLS policies in the postgres:17 image
metadata:
  type: project
---

- Inside the postgres:17 container, `psql -h 127.0.0.1` is **trust** auth, so a wrong password still logs in. Test role passwords from a second container on a shared docker network (`-h <container-name>`) (found while verifying `infra/postgres/init.sql`, 2026-09-24).
- `current_setting('app.tenant_id', true)` returns `''` (not NULL) on a pooled connection once any earlier transaction has run `SET LOCAL app.tenant_id`, so `''::uuid` errors instead of matching no rows. Policies need `NULLIF(current_setting('app.tenant_id', true), '')::uuid` (applies to the T017 helper `enable_tenant_rls` in `apps/api/migrations/0001_helpers.ts`).

**Why:** research D3 assumes "without the context the policy matches no rows". The second pitfall breaks that assumption on reused connections.

**How to apply:** when writing or reviewing RLS policies or DB role tests, use NULLIF, and test auth over the network rather than localhost.
