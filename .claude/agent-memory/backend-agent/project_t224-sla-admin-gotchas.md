---
name: t224-sla-admin-gotchas
description: Pitfalls from the SLA admin task (T224) - pnpm filter name, advisory lock exhaustion on bulk recompute, big heredocs failing, settings test pinned to old behaviour
metadata:
  type: project
---

- `pnpm --filter @replyx/api` silently matches nothing (exit 0, no output); the package is named `api`: `pnpm --filter api run typecheck|lint`.
- `SlaRecomputeService.recompute` takes a tx-scoped advisory lock per ticket, so recomputing all open tickets in ONE transaction can exhaust Postgres' lock table; `apps/api/src/sla/sla-reapply.service.ts` pages 100 tickets per transaction, after the config commit.
- Long YAML/JS heredocs in Bash can fail with "unexpected EOF"; write fragments with the Write tool (scratchpad) and apply with a small node script.
- Extending `TicketRefs` (tickets/ticket-dto.ts) is the cheapest way to add per-ticket data to every staff summary/detail: all callers already go through `TicketRefsRepository.load`.
- When a "not accepted yet" behaviour gets implemented, old tests pin it (settings.test.ts `businessHoursId` unrecognized_key, view-compiler.test.ts sla_status matches nothing): list them for test-automator.
