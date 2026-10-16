# Performance notes (T266)

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) "Performance Goals"

Targets: API p95 < 300 ms for reads and < 500 ms for writes, view counts < 50 ms at p95, customer
bundle < 150 KB gzipped.

## How it was measured (2026-10-17)

- **API**: `PERF=1 pnpm --filter api exec vitest run test/perf` in the `tools` container.
  `test/perf/seed-large-tenant.ts` builds one tenant at the plan's scale: **100,000 tickets** over a
  year (55% closed), **300,000 messages**, 200 staff, 20,000 customers, 8 groups; then `ANALYZE`.
  `test/perf/large-tenant.test.ts` makes 40 requests per endpoint after 3 warm-ups, through the real
  app in-process (Supertest, Testcontainers PostgreSQL 17 and Valkey 8, Docker Desktop on a Windows
  laptop). Times include routing, guards, validation and serialization; not network or TLS.
- **Bundle**: `pnpm --filter web build && pnpm --filter web check:bundle`
  (`apps/web/scripts/check-bundle-size.mjs`): the entry chunk plus everything
  `src/routes/CustomerArea.tsx` loads, statically or lazily, gzipped at level 9.

## Results

| Measurement | p50 ms | p95 ms | Target | |
|---|---|---|---|---|
| PATCH /tickets/{id} (priority) | 63 | 102 | 500 | ✅ |
| POST /tickets/{id}/messages (note) | 55 | 85 | 500 | ✅ |
| GET /tickets/{id} | 48 | 67 | 300 | ✅ |
| GET /tickets/{id}/messages | 77 | 128 | 300 | ✅ (after the fix below) |
| GET /dashboard | 146 | 286 | 300 | ✅ |
| GET /tickets?viewId (agent, 3 groups, 50 rows) | 81 | 174 | 300 | ✅ |
| GET /tickets?viewId (admin, Unassigned & Open, 50 rows) | 120 | 312 | 300 | ⚠️ just over |
| GET /views/counts, cached (admin / agent) | 41 / 36 | 57 / 59 | 50 | ⚠️ just over |
| GET /views/counts, uncached (admin / agent) | 668 / 522 | 1263 / 1533 | 50 | ❌ |
| GET /search?q=refund (title of 1 in 5 tickets) | 360 | 543 | 300 | ❌ |
| GET /search?q=100123 (ticket number) | 535 | 1304 | 300 | ❌ |
| GET /search?q=Perf Customer 4242 (customer name) | 1016 | 1626 | 300 | ❌ |
| GET /search?q=parcel (word in all 300k messages, worst case) | 440 | 1021 | — | recorded |
| Customer bundle | | 220.4 KB | 150 KB | ❌ |

## Fixed during the check

- **Ticket timeline** (`GET /tickets/{id}/messages`): it took over 10 s per request at this scale.
  `MessagesRepository.listForTicket` matched `ticket_id = X OR ticket_id IN (correlated subquery on
  tickets.merged_into_id)`, which PostgreSQL could only run as a scan of every message with a
  ticket lookup per row. It now reads the merged tickets first and uses a plain `IN`, and migration
  `0023_tickets_merged_into_index` adds a partial index on `merged_into_id`. Now p95 128 ms.
- **Customer bundle**: 227.2 KB → 220.4 KB. The customer chat pulled the staff ticket hooks and API
  client in through `data/ai/responder.ts` (`ticketKeys`) and `data/attachments.ts` (the staff
  upload URL). `ticketKeys` moved to `data/ticket-keys.ts` and the staff upload to
  `data/staff-attachments.ts`.

## Open gaps (follow-up work, not done)

1. **Search** misses the read target by 2–5×. The ticket query ORs five `EXISTS`/full-text
   conditions over `tickets` ordered by id (`search.repository.ts`), so the planner can't drive it
   from the GIN and trigram indexes. Likely fix: a `UNION` of candidate ticket ids from each indexed
   source (title tsv, message tsv, number trigram, customer name/email trigram, tag), then the access
   filter and `ORDER BY id DESC LIMIT`.
2. **Uncached view counts** cost about 50–100 ms per view (12–15 views per viewer), against the 50 ms
   target for the whole request. Served counts are cached 30 s (research D13), but a ticket change in
   a group drops the cache for every viewer of that group, so a busy desk recomputes often. Options:
   index the default views' predicates (state/group/owner partial indexes), count only the views on
   screen, or keep per-group counters updated by events. One query with `count(*) FILTER (...)`
   per view was tried and was slower (p95 1.27 s): the ORed filter stops each view using its index.
3. **Cached counts** (57–59 ms) and the admin "Unassigned & Open" list (312 ms) are just over; most
   of the cached time is the access policy and visible-views lookup done on every request.
4. **Customer bundle** is 70 KB over. What remains is the framework: React DOM, MUI with emotion,
   React Router, React Query and socket.io (≈200 KB gzipped before any customer code). Meeting
   150 KB needs an architectural choice (Preact compat, or a customer area without MUI). The check
   script exists but is not a CI gate until that choice is made.
