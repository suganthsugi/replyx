# Real-time contract (Socket.IO)

Transport and delivery decisions: [research.md D7–D8](../research.md#d8-real-time-transport-and-reconnect-catch-up).

## Connection

- URL: `wss://{tenant}.replyx.app/rt` (Socket.IO path `/rt`), namespace `/` for staff and
  `/customer` for customers.
- Auth: the `rx_session` cookie is sent with the handshake. The server resolves the tenant from
  the host and rejects the connection (`connect_error` with `{ code: "UNAUTHENTICATED" }`) if the
  session is missing, expired, belongs to another tenant, or belongs to the wrong audience
  (a customer session on `/` or a staff session on `/customer`).
- The server disconnects a socket with reason `{ code: "SESSION_REVOKED" }` on sign-out-all,
  deactivation or tenant suspension (`{ code: "TENANT_SUSPENDED" }`), and with
  `{ code: "SESSION_EXPIRED" }` when the session idles out (checked every minute).

## Client → server messages

All client messages use Socket.IO acknowledgements: `ack({ ok: true, ... })` or
`ack({ ok: false, error: { code, message } })`.

| Message | Payload | Rules |
|---------|---------|-------|
| `subscribe` | `{ stream: "ticket:{id}" \| "views" \| "user" }` | Policy check. `ticket:{id}` needs view on the ticket's group, otherwise `NOT_FOUND`. `user` and `views` are joined automatically on connect for staff. |
| `unsubscribe` | `{ stream }` | |
| `sync` | `{ streams: [{ stream, afterSeq }] }` | Replays missed events in `seq` order (filtered by current access), then `ack({ ok: true, upToSeq })`. Returns `resync_required` per stream when the cursor is older than retention (7 days). |
| `typing` | `{ ticketId, state: "start" \| "stop" }` | Staff on `/`: needs edit on the group. Ephemeral. |
| `viewing` | `{ ticketId, state: "enter" \| "leave" }` | Staff presence on a ticket (collision awareness). Ephemeral, 30 s heartbeat. |
| `customer.typing` | `{ state }` | Customer namespace only. Shown to staff viewing the active ticket. |

Customers are joined to `conversation` automatically and cannot subscribe to anything else.

## Server → client envelope

Every persistent event (from the outbox) is delivered as:

```json
{
  "id": "0192f3c4-...-uuidv7",
  "seq": 48213,
  "stream": "ticket:0192f...",
  "type": "message.created",
  "occurredAt": "2026-09-24T10:15:02.113Z",
  "actor": { "kind": "user", "id": "0192...", "name": "Priya" },
  "data": { }
}
```

Clients keep the last `seq` per stream and drop events whose `id` they've already applied.
Ephemeral events (`typing`, `presence`) have no `id` or `seq` and are never replayed.

## Streams (rooms)

| Stream | Room | Audience |
|--------|------|----------|
| `user` | `t:{tenant}:user:{userId}` | That staff user: notifications, access changes, assignment to them |
| `views` | `t:{tenant}:views:{userId}` | Count-change hints for that user's views |
| `ticket:{id}` | `t:{tenant}:ticket:{id}` | Staff with view access on the ticket's group |
| `conversation` | `t:{tenant}:conversation:{customerId}` | That customer only (customer projection) |
| `tickets` | `t:{tenant}:tickets:group:{groupId \| ungrouped}` | Staff with view on that group: list updates (ticket.created/updated/moved) |

The gateway joins staff sockets to `tickets:group:*` rooms from their effective access on connect
and recomputes them on `access.changed`.

## Staff events

| Type | Stream(s) | `data` |
|------|-----------|--------|
| `ticket.created` | `tickets:group:*` | `TicketSummary` ([tickets.yaml](tickets.yaml)) |
| `ticket.updated` | `ticket:{id}`, `tickets:group:*` (old and new group) | `{ ticket: TicketSummary, changes: [{ field, old, new }] }` |
| `ticket.removed_from_view` | `tickets:group:{oldGroup}` | `{ ticketId, reason: "moved" \| "deleted" \| "merged" }` — clients drop the ticket and close its screen if the user no longer has access |
| `message.created` | `ticket:{id}` | `Message` (includes internal notes: staff only) |
| `message.moved` | `ticket:{from}`, `ticket:{to}` | `{ messageId, fromTicketId, toTicketId }` |
| `message.read` | `ticket:{id}` | `{ upToMessageId, readAt }` (customer read receipt) |
| `typing` | `ticket:{id}` | `{ user: UserRef \| { kind: "customer", name }, state }` (ephemeral) |
| `presence` | `ticket:{id}` | `{ viewers: [UserRef], typing: [UserRef] }` (ephemeral) |
| `views.counts_changed` | `views` | `{ viewIds: [id] }` — refetch `/views/counts` (debounced 500 ms) |
| `notification.created` | `user` | `Notification` ([operations.yaml](operations.yaml)) |
| `notification.updated` | `user` | `{ id, count }` (burst grouping) |
| `notification.read` | `user` | `{ ids \| "all", unreadCount }` — sync across sessions |
| `access.changed` | `user` | `{ accessVersion }` — refetch `/me` |
| `access.revoked` | `user` | `{ ticketIds?: [id], groupIds?: [id \| null] }` — close screens showing these |
| `availability.changed` | `tickets:group:*` | `{ userId, availability }` (ephemeral) |

## Customer events (`/customer` namespace)

Payloads are the customer projection only (research D9). A contract test asserts that none of
these payloads contain ticket ids, numbers, states, groups, owners, priorities, SLA data or
internal notes.

| Type | `data` |
|------|--------|
| `conversation.message` | `ConversationMessage` ([customer.yaml](customer.yaml)) — own messages (echo to other devices) and support public replies |
| `conversation.delivery` | `{ messageId, delivery: "delivered" \| "read" }` |
| `conversation.status` | `FriendlyStatus` |
| `conversation.resolved` | `ResolvedMarker` plus `{ ratingId? }` |
| `conversation.typing` | `{ name, avatarUrl, state }` (ephemeral) |

## Delivery guarantees

- At least once, in `seq` order per stream, with client dedupe by `id`: effectively exactly once
  for the UI (FR-083, SC-007).
- Events are published only after commit (outbox), so a client never sees something that was
  rolled back.
- Target latency: 95% of events delivered within 2 s of commit (SC-002). Measured by the
  `realtime_delivery_lag_seconds` histogram.
