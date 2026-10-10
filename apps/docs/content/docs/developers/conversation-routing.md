---
title: Conversation routing
description: How a customer's message finds its ticket, stays idempotent under concurrency, and reaches the customer as a ticket-free projection.
---

Customers never see tickets. They have one conversation, and every message
they send is routed to exactly one ticket behind the scenes. This page covers
the router, the projection that keeps ticket data away from customers, the
real-time events, and how the web client uses them.

## The router

`CustomerMessageRouter.accept(ctx, customer, { body, clientMessageId, attachmentIds })`
(`apps/api/src/messaging/customer-message-router.ts`) handles
`POST /customer/messages` in **one transaction**:

1. **Lock the customer.** `pg_advisory_xact_lock(hashtext(tenant_id || customer_id))`
   serializes every send from that customer, and the auto-close sweeper takes
   the same lock. Two concurrent sends can never create two tickets, and a
   message can't land on a ticket that is being closed.
2. **Idempotency.** The insert conflicts on
   `UNIQUE (tenant_id, author_id, client_message_id)`. A repeated
   `clientMessageId` returns the stored message and nothing else happens.
3. **Pick the target ticket.**

   | Situation | Result |
   |-----------|--------|
   | One or more active tickets (`new`, `open`, `pending_reminder`, `pending_close`), not merged | Append to the most recently updated one; `pending_*` moves to `open` (`new` stays `new`) |
   | Latest ticket is `resolved` and `now < auto_close_at` (within the grace period) | Reopen it to `open`, keeping group and owner |
   | Latest ticket is `closed`, or resolved past grace but not swept yet (closed first) | Per the tenant's `after_close_behavior`: `new_follow_up` (default) creates a ticket with origin `follow_up` and a `follow_up_of` link; `reopen_previous` reopens it |
   | No tickets at all, or the last one was purged | Create a ticket with origin `customer_message` |

4. **New tickets** get the next number from `TicketNumberService` (the tenant
   counter row, incremented in the same transaction), a title from the first
   80 characters of the message cut at a word boundary (`titleFrom`), and one
   `TicketRouter.route()` pass. The default `NoRoutingRouter` returns `null`,
   so the ticket stays Ungrouped (Needs Triage). The rule-based router
   implements the same interface.
5. **Store and emit.** The message is inserted, the ticket's state and
   timestamps move through `state-machine.ts` (`last_customer_message_at`,
   `waiting_on = support`), history rows are written, and the outbox gets
   `ticket.created` (list rooms) or `ticket.updated`/`ticket.reopened`,
   `message.created` (the ticket room and the customer's conversation), and
   the customer's new friendly status.

The grace period (`grace_period_hours`, default 72) and
`after_close_behavior` come from `TenantSettingsRepository.conversation()`
(`apps/api/src/tenancy/tenant-settings.ts`).

`test/concurrency/customer-sends.test.ts` checks the lock and the idempotency
together: 50 parallel sends with 10 repeated `clientMessageId`s must give 40
messages on exactly one ticket.

## The customer projection

`apps/api/src/messaging/customer-projection.ts` is the **only** code allowed to
build a payload a customer receives, over HTTP or a socket:

- A public message becomes a `ConversationMessage`: `from` is `me`,
  `support` (agent name and avatar) or `system`; `delivery` is `sent`,
  `delivered` or `read`. `toConversationMessage` **throws** on an internal
  note, so a mistake fails loudly instead of leaking.
- A resolved ticket becomes a `ResolvedMarker` whose id is an opaque hash, not
  the ticket id.
- The conversation state becomes a `FriendlyStatus` (`idle`, `received`,
  `replying`, `answered`) with customer-facing text.

None of these shapes has a field for ticket id, number, state, group, owner,
priority or SLA data. `CustomerConversationService` builds the thread from
`visibility = 'public'` messages only, across all of the customer's tickets,
with a resolved marker after each resolved or closed ticket.

## Real-time events

Customer sockets connect to the `/customer` namespace and are joined to their
own `conversation` stream (`t:{tenant}:conversation:{customerId}`) on connect.
They can't subscribe to anything else.

| Event | Payload |
|-------|---------|
| `conversation.message` | `ConversationMessage`: support replies, and the customer's own messages echoed to their other devices |
| `conversation.delivery` | `{ messageId, delivery }` |
| `conversation.status` | `FriendlyStatus` |
| `conversation.attachment` | `{ messageId, attachment }` when a scan finishes |
| `conversation.typing` | `{ name, avatarUrl, state }`, **ephemeral** |

Persistent events are outbox envelopes with `id` and `seq`. Typing is
ephemeral: it's sent as `ephemeral { type, stream, data }`, has no `seq`, and
is never replayed (`apps/api/src/messaging/conversation-events.ts`). Staff
`typing` on a ticket is forwarded to the ticket's customer unless the agent is
writing an internal note. Customer `customer.typing { state }` goes to staff
viewing the customer's active ticket, and the server picks that ticket, not
the client.

Staff replies go through `POST /tickets/{id}/messages`
(`staff-messages.service.ts`). The first public reply moves `new` to `open`
and sets `waiting_on = customer`. Internal notes produce no customer event and
no email. `OfflineReplyEmailConsumer` emails a customer who has no connected
socket about a public reply, at most once per 2 minutes, when the tenant and
the customer both allow it.

## The web client

The chat lives in `apps/web/src/pages/customer/ChatPage.tsx` and the
components in `apps/web/src/components/chat/`. The components only know the
view types in `components/chat/types.ts`, which have no ticket fields.

`apps/web/src/data/conversation.ts` holds the hooks:

- **`useConversation()`**: an infinite query over `GET /customer/conversation`
  (`before` cursor for older pages; the newest page is first in the cache),
  merged with the local outbox of unsent messages. It seeds the realtime
  cursor with the response's `streamSeq`
  (`RealtimeClient.seedCursor('conversation', seq)`), so a reconnect replays
  only what came after the snapshot.
- **`useSendMessage()`**: gives each message a `clientMessageId` once
  (`crypto.randomUUID()`) and reuses it on **Try again**, so retries are
  deduplicated by the API. A `RATE_LIMITED` answer marks the message failed
  and pauses the composer for `retryAfter` seconds.
- **`useConversationEvents()`**: registers the `conversation` stream for
  resync and patches the cache from `conversation.*` envelopes. Delivery only
  moves forward (a late `delivered` never undoes `read`). Own messages keep
  their `clientMessageId` as the item id, so a bubble stays the same element
  from optimistic to confirmed.
- **`useSupportTyping()` / `useTypingSignal()`**: listen for
  `conversation.typing` through `RealtimeClient.onEphemeral` (cleared after
  10 s or when the reply lands), and send `customer.typing` (`start` at most
  every 10 s, `stop` after 4 s of quiet or on send) through
  `RealtimeClient.send`.
- **`useMarkRead(items)`**: calls `POST /customer/messages/read` up to the
  newest support reply while the page is visible.

Attachments upload through `useAttachmentUploads()`
(`apps/web/src/data/attachments.ts`). It uses XMLHttpRequest for progress,
the one request that bypasses the `http` mutator, but it keeps the same
contract: same origin, CSRF header, and `HttpError`. The composer checks type
and size first (`components/chat/attachment-rules.ts`), and the API still
checks the real bytes.

New support messages, typing and status changes are announced through the
area's live region (`useAnnounce`). History that loads in on scroll is not
announced.
