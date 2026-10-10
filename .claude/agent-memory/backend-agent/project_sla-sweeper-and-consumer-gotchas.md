---
name: sla-sweeper-and-consumer-gotchas
description: Constraints hit while building the SLA consumer/sweeper (T223) - positional TicketSweeperJob ctor in tests, outbox time is DB time not Clock, Kysely forUpdate OF, worker-only modules
metadata:
  type: project
---

- `TicketSweeperJob` is built positionally in `apps/api/test/support/jobs.ts` (`new TicketSweeperJob(unitOfWork, outbox, clock, history, queues, platformDb)`); tests are not mine to edit, so extend the sweeper with plain classes (`new SlaSweepRepository(ctx)`, `emitSlaEvents(...)` in `apps/api/src/sla/sla-sweep.ts`) instead of adding constructor params.
- `outbox_events.created_at` (`DomainEvent.occurredAt`) is DB `now()`, not the injected `Clock`; with `TestClock` or the dev offset they differ. Consumers that need a time instant must use `Clock.now()`, never `event.occurredAt`.
- Kysely 0.28 has no `.forUpdate().of(t)`; use `.forUpdate('ticket_sla')` to lock one table of a join (`FOR UPDATE OF`), then `.skipLocked()`.
- Worker-only consumers are registered via a `*JobsModule` added to `workerOnly` in `apps/api/src/app.module.ts`; the api test app can't `service()` them, so probe tests construct them by hand (`new SlaRecomputeService(await service(OutboxService), await service(Clock))`).
- A new outbox event type that should refresh Escalated/view counts has to be added to `ViewCountsConsumer.eventTypes` (`apps/api/src/views/counts-notifier.ts`); it reads groups from `event.streams`, so emit a `tickets:group:*` stream.
- Probe-test trick: a throwaway `test/integration/<x>/probe.test.ts` driving `sweeperJob()` plus `TestClock.advance` verified warn-then-breach once; delete with `rm <file>` (recursive rm is denied by the permission system).
