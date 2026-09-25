---
name: realtime-events
description: Outbox append, event types, stream keys, customer projections, relay/envelopes, /rt gateways, sync, revocation, IdempotentHandler consumers. Use when emitting events or touching outbox/realtime/jobs code.
---

# realtime-events

How state changes become events, jobs and socket pushes. Loaded by backend-agent,
frontend-connector and test-automator. Code: `apps/api/src/platform-kernel/{outbox,realtime,jobs}/`.
For `TenantContext`/`withTenant`/RLS load `tenant-scoping`.

## Rules

1. **Append in the same transaction as the state change.** `OutboxService.append(tx, input)`
   (`outbox/outbox.service.ts`, global `OutboxModule`) takes the `TenantTransaction`; tenant and
   default actor come from the transaction; it returns the UUIDv7 id. Never emit to a socket or
   add a BullMQ job from a service or controller (constitution IV, V).
   ```ts
   // from apps/api/src/identity/session.service.ts
   await this.outbox.append(tx, {
     type: 'session.revoked',
     payload: { userId, sessionIds, reason },
     streams: [`user:${userId}`],
   });
   ```
   Wrong: `this.server.to(room).emit(...)` after commit; `queue.add(...)` in a service

2. **Declare each type once in `DomainEventMap`** (`outbox/event-types.ts`) with its payload;
   `append` is typed by it. Names `<resource>.<past_tense_verb>` snake_case. Exists today:
   `session.revoked`, `access.changed`, `access.revoked`, `tenant.suspended`. Planned (contract):
   `ticket.created|updated|assigned|closed|state_changed|removed_from_view|reminder_reached`,
   `message.created|moved|read`, `notification.created`. Reuse before inventing.
   Wrong: `TicketCreated`, `ticket-created`, `ticket.create`

3. **Stream keys are tenant-less** (`StreamKey`, validated by `isStreamKey` at runtime):
   `user:{uuid}`, `views:{uuid}`, `ticket:{uuid}`, `tickets:group:{uuid|ungrouped}`,
   `conversation:{customerUserId}`, and `tenant` (control stream for `access.changed` /
   `tenant.suspended`: consumed by gateways, never a client room). Rooms are
   `roomFor(tenantId, key)` = `t:{tenantId}:{key}`. A group move lists old and new
   `tickets:group:*` streams. Every event needs at least one stream.
   Wrong: `streams: ['t:acme:ticket:1']`, `ticket:42` (ids are uuids)

4. **Customer streams need a `CustomerProjection`**: `customerPayload: { type: 'conversation.*',
   data }`, required iff a stream is `conversation:*` (`append` throws otherwise, both ways). Built
   by the messaging projector; never contains ticket id/number, state, group, owner, priority, SLA
   or internal notes. Internal notes never get a `conversation:*` stream.
   Wrong: `customerPayload: payload` / `{ ...payload, ticketNumber }`

5. **Relay** (`outbox/relay.ts`, `OutboxRelayModule`, worker only): one leader
   (`pg_try_advisory_lock` on a dedicated platform connection that `LISTEN outbox_new`, 500 ms
   poll, 5 s failover). Per batch in one `PLATFORM_DB` transaction: lock unpublished rows in `id`
   order, assign `seq = max(seq)+1…` (global across tenants, gap-free), set `published_at` and
   enqueue jobs (deduped by job id); **commit**; only then emit envelopes and
   `serverSideEmit('replyx:control', { id, seq, tenantId, type, occurredAt, payload })` for
   `CONTROL_EVENT_TYPES`, so every emitted `seq` is already visible to `sync`. Prunes published
   rows older than 7 days.
   Wrong: relay in the api process; a DB sequence for `seq`; emitting before the batch commits

6. **Envelope** (`Envelope`, `envelopeFor`): Socket.IO event name **`event`** (`ENVELOPE_EVENT`),
   body `{ id, seq, stream, type, occurredAt, actor, data }`. `stream` is the **client stream name**
   from `clientStream()`: `user`, `views`, `conversation`, `tickets` (all group rooms),
   `ticket:{id}`. Customer envelopes (namespace `/customer`) carry the projection's type/data and
   `actor: { kind }` only. Clients dedupe by `id`.
   Wrong: emitting under the event type name (`socket.emit('message.created', …)`)

7. **Gateways** (`realtime/gateway.ts`, api only, `RedisIoAdapter` on path `/rt`): `StaffGateway`
   on `/`, `CustomerGateway` on `/customer`. Handshake resolves the tenant from `Host` and the
   `rx_session` cookie; wrong audience/tenant → `connect_error` `data.code` `UNAUTHENTICATED` (or
   `TENANT_SUSPENDED`). On connect every socket joins `tenantRoom` and `sessionRoom` (control
   targeting); staff also `user`, `views` and viewable `tickets:group:*`; customers their own
   `conversation` only. Acks are `Ack<T>`: `{ ok: true, ... }` or `{ ok: false, error: { code,
   message } }`; anything not visible → `notFoundAck()` (`NOT_FOUND`), never a 403-style code.
   Build contexts with `socketContext(socket)`; handler errors go through `errorAck`.
   ```ts
   // from apps/api/src/platform-kernel/realtime/gateway.ts
   if (!(await this.access.canSeeTicket(socketContext(socket), stream.slice('ticket:'.length)))) {
     return notFoundAck();
   }
   await socket.join(roomFor(socket.data.tenantId, stream));
   return { ok: true };
   ```
   `ticket:*` visibility needs `TICKET_GROUP_LOOKUP` (`socket-context.ts`), `@Optional` in
   `StreamAccess`: the Tickets module (US6) must provide it from a **global** module; until then
   `ticket:*` subscribe/sync is `NOT_FOUND`.
   Wrong: `socket.join(body.room)` without `StreamAccess`

8. **`sync`** (`realtime/sync.handler.ts`): input `{ streams: [{ stream, afterSeq }] }` (client
   stream names, max 50); access is re-resolved now via `StreamAccess.keysFor`; replays `seq >
   afterSeq` as the same envelopes, ack `{ ok: true, upToSeq, resyncRequired: string[] }`. A stream
   is in `resyncRequired` when its cursor predates retention or the backlog exceeds 1000 (client
   refetches REST).

9. **Revocation.** Control events: `session.revoked` → `purgeCache` again, then `closing { code:
   'SESSION_REVOKED' | 'TENANT_SUSPENDED' }` and disconnect of `sessionRoom`s; `tenant.suspended`
   → same on `tenantRoom`. `SessionExpirySweeper` (session-expiry.ts) closes sockets whose session
   idled out with `SESSION_EXPIRED` (sweep every 60 s; call `sweep()` in tests after advancing
   `TestClock`). Clients must handle `closing` before the disconnect.
   `access.changed` → `AccessChangeHandler` recomputes rooms and sends `access.changed` /
   `access.revoked { ticketIds?, groupIds? }` as `user`-stream envelopes. Every access-affecting
   write calls `bumpAccessVersion(tx, tenantId, reason)` in its transaction.

10. **Ephemeral signals** (typing, viewing, availability) go through `PresenceService`
    (`realtime/presence.service.ts`): Redis only, 30 s TTL (`PRESENCE_TTL_MS`), no `id`/`seq`,
    never in the outbox or ticket history.

11. **Consumers extend `IdempotentHandler`** (`jobs/idempotent-handler.ts`) as Nest providers in a
    worker module: set `consumer` (unique), `queue` (from `QUEUE_NAMES` in `jobs/queues.ts`) and
    `eventTypes`; implement `handle(tx, event)`. `process` opens `withTenant` from the **job's**
    `tenantId` and claims `processed_events (consumer, event_id)` in that same transaction.
    Job name = consumer, job id `eventJobId(consumer, eventId)` = `{consumer}.{eventId}`; 5 attempts,
    exponential backoff, then `dead-letter` (ids only).
    ```ts
    // from apps/api/src/audit/audit.consumer.ts
    export class AuditConsumer extends IdempotentHandler<AuditedEvent> {
      readonly consumer = 'audit';
      readonly queue = 'audit' as const;
      readonly eventTypes: readonly Extract<DomainEventType, AuditedEvent>[] = ['session.revoked'];
      protected async handle(tx: TenantTransaction, event: DomainEvent<AuditedEvent>) {
        const entry = auditEntryFor(event);
        if (entry !== undefined) await this.audit.record(tx, entry, { actor: toActor(event.actor) });
      }
    }
    ```
    Non-event jobs extend `JobProcessor` (`jobs/job-processor.ts`). Email: `MailQueue.enqueue(data,
    { dedupeKey })` only **after commit** (`platform-kernel/mail/mail.service.ts`).
    Wrong: claiming `processed_events` in a separate transaction; tenant from `event.payload`

12. **Logs** carry `tenantId`/`eventId`/`jobId` via `runWithLogContext`; never log `payload` or
    `customerPayload`.

## Checklist (before reporting done)
- [ ] State changes clients or consumers care about call `outbox.append(tx, …)` in the same tx
- [ ] New type in `DomainEventMap`; streams are valid `StreamKey`s
- [ ] `conversation:*` streams carry a projector-built `customerPayload`, and only they do
- [ ] No direct emit/`queue.add` from services; mail enqueued after commit
- [ ] Subscriptions/sync go through `StreamAccess`; denial is `NOT_FOUND`
- [ ] Access-affecting writes call `bumpAccessVersion`
- [ ] Consumers extend `IdempotentHandler` with a unique `consumer`; tests cover redelivery
