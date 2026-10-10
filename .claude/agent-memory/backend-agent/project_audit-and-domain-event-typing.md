---
name: audit-and-domain-event-typing
description: Gotchas for audit consumer/service - DomainEvent<Union> does not narrow, audit details key filter, audit_logs column types, TestClient has no .query
metadata:
  type: project
---

- `DomainEvent<A | B>` (jobs/idempotent-handler.ts) is NOT a discriminated union; to switch on `event.type` build `{ [K in T]: DomainEvent<K> }[T]` (see `AuditableEvent` in apps/api/src/audit/audit.consumer.ts).
- `AuditService.sanitizeDetails` drops keys named `messages`, `message`, `content`, `text`, `body`, `note`, `token`... (anchored regex). Use `messageCount`, `ticketCount`, not `messages`/`tickets`-style bare words that match.
- `audit_logs.resource_id` is uuid and `ip` is inet (host() to read); `action` must match `^[a-z][a-z_]*(\.[a-z][a-z_]*)+$`. Statements in one transaction share `occurred_at`, so keyset paging needs the id tie-break and microsecond text timestamps (not JS Date).
- Test `TestClient.get(path)` returns a Promise; put query strings in the path (no `.query()`).
- Bash tool heredocs containing many quotes/backticks failed with "unexpected EOF"; use the Write tool for source files.
