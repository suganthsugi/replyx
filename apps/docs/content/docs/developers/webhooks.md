---
title: Webhooks
description: What ReplyX sends to a webhook endpoint, how receivers verify the signature, how retries and the delivery log work, and how the delivery pipeline is built.
---

A workspace admin registers HTTPS endpoints under **Admin → Webhooks** (or `POST /webhooks`,
permission `webhook.create`) and picks the events each one receives. ReplyX then sends one signed
`POST` per event to every enabled endpoint subscribed to it. This page is for engineers who build
a receiver, and for those who work on the delivery code in `apps/api/src/integrations/webhooks/`.

## Events

| Type | Sent when | `data` |
|---|---|---|
| `ticket.created` | A ticket starts: a customer's first message, a follow-up, or staff starting one | `{ ticket }` |
| `ticket.updated` | State, priority, group, owner, title or tags change | `{ ticket, changes: [{ field, old, new }] }` |
| `ticket.assigned` | The owner changes, including to or from nobody | `{ ticket, previousOwner, owner }` |
| `ticket.closed` | The ticket enters closed | `{ ticket, closedBy }` — `agent`, `auto_close`, `pending_close` or `merge` |
| `message.created` | A customer message or a public reply is added | `{ ticketId, message }` |

**Internal notes are never sent.** `webhookData` (`apps/api/src/integrations/webhooks/webhook-payload.ts`)
returns nothing for a message whose visibility is not `public`, so no delivery row is even
written.

`ticket` is read when the event is consumed:

```json
{
  "id": "0192f3c4-…",
  "number": 1042,
  "title": "Refund for order 5521",
  "state": "open",
  "priority": "normal",
  "group": { "id": "…", "name": "Billing" },
  "owner": { "id": "…", "name": "Ada Agent", "email": "ada@acme.example" },
  "customer": { "id": "…", "name": "Sam Customer", "email": "sam@example.com" },
  "tags": ["refund"],
  "createdAt": "2026-10-16T09:12:44.120Z",
  "updatedAt": "2026-10-16T09:30:02.981Z"
}
```

`message` is `{ id, authorKind, author: { id, name } | null, body, attachments, createdAt }`.
Attachments are listed as `{ id, fileName, contentType, sizeBytes }` without files or links;
fetch them through the API with your own credentials.

## The request

```http
POST /your/endpoint HTTP/1.1
Content-Type: application/json
User-Agent: ReplyX-Webhooks/1
ReplyX-Event-Id: 0192f3c4-7b1e-7c40-9a51-2f0f6c1d9e10
ReplyX-Event-Type: ticket.created
ReplyX-Delivery-Attempt: 1
ReplyX-Signature: t=1792141964,v1=5f2b…e9

{"id":"0192f3c4-…","type":"ticket.created","occurredAt":"2026-10-16T09:12:44.120Z","tenant":{"slug":"acme"},"data":{…}}
```

- The body is built once per event and stored as text on the delivery row
  (`webhook_deliveries.body`, migration `apps/api/migrations/0022_webhooks.ts`), so every
  attempt sends **the same bytes**.
- `ReplyX-Event-Id` equals the body's `id`. The same event can arrive more than once (a retry
  after a timeout that actually succeeded, a recovered job): **deduplicate on it**.
- Any **2xx** within **10 s** counts as delivered. Redirects are not followed, so a 3xx is a
  failure.

## Verifying the signature

`v1` is the hex HMAC-SHA256 of `"{t}.{raw body}"` with the endpoint's signing secret
(`signatureHeader` in `apps/api/src/integrations/webhooks/webhook-signature.ts`). A receiver should:

1. Read the **raw** request body before any JSON parsing.
2. Split the header on `,` into `t` and `v1`.
3. Reject the request when `t` is more than **5 minutes** from its own clock.
4. Compute the HMAC and compare it to `v1` in constant time.

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(secret: string, header: string, rawBody: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const parts = Object.fromEntries(header.split(',').map((part) => part.split('=', 2)));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(nowSeconds - t) > 300 || typeof parts.v1 !== 'string') return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return parts.v1.length === expected.length && timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected));
}
```

`verifyWebhookSignature` in the same file does exactly this and is what the integration tests use.

The secret (`whsec_…`, 32 random bytes) is returned **once**: in the `201` of `POST /webhooks` and
in the response of `POST /webhooks/{id}/rotate-secret`. It is stored sealed with the kernel
`SecretBox` (AES-256-GCM, `REPLYX_SECRETS_KEY`, `apps/api/src/platform-kernel/crypto/secret-box.ts`)
and opened only by the delivery job. After a rotation the next attempt, retries included, is
signed with the new secret.

## Retries and the delivery log

Each attempt is one row in `webhook_deliveries` with `attempt`, `status`, `response_code`,
`duration_ms`, `error` and `next_attempt_at`. `GET /webhooks/{id}/deliveries` lists them, newest
first, for the last 30 days.

| Attempt failed | Next attempt after |
|---|---|
| 1 | 1 minute |
| 2 | 5 minutes |
| 3 | 15 minutes |
| 4 | 1 hour |
| 5 | 3 hours |
| 6 | 6 hours |
| 7 | 12 hours |
| 8 | — the delivery is `gave_up` |

Each delay gets ±10% jitter (`retryDelayMs` in `delivery.job.ts`), so about a day passes between
the first and the last attempt.

| Status | Meaning |
|---|---|
| `pending` | Queued; `next_attempt_at` is when it is due |
| `succeeded` | A 2xx came back |
| `failed` | Anything else; the next attempt is written as `pending` |
| `gave_up` | The 8th attempt failed, or the endpoint was switched off while it waited |

`error` holds a short reason such as `HTTP 503`, `No response within 10 s`,
`Connection failed (ECONNREFUSED)` or `Refused: the host resolves to a private or reserved address`.
Response bodies are never stored.

## SSRF protection

An endpoint URL is chosen by a tenant admin, so a request must never reach ReplyX's own network.
Both checks use the kernel outbound guard (`apps/api/src/platform-kernel/http/outbound-guard.ts`):

- **On save** (`WebhooksService`, `checkOutboundUrl`): https only, no credentials in the URL, no
  private, loopback, link-local or metadata IP literal, no `localhost`. A refusal is a `400` on
  `url` with issue `not_https`, `private_address` or `invalid_url`.
- **On every delivery** (`WebhookTransport`, `outboundRequest`): the host name is resolved inside
  the socket's DNS lookup and **every** address must be public, so a name that later points
  inside (DNS rebinding) is refused at connect time. No redirects, 10 s timeout, responses over
  1 MB are cut off.

In development (`NODE_ENV=development`) http and private addresses are allowed, so a receiver
on `host.docker.internal` works.

## The pipeline

```mermaid
sequenceDiagram
  participant Tx as Ticket / message transaction
  participant Relay as Outbox relay
  participant C as WebhooksConsumer
  participant J as WebhookDeliveryJob
  participant E as Endpoint
  Tx->>Relay: outbox event (same transaction)
  Relay->>C: webhooks queue
  C->>C: body built once, attempt 1 written per subscribed endpoint
  C->>J: job queued after commit
  J->>J: tenant active? claim row (60 s lease)
  J->>E: signed POST via the outbound guard
  E-->>J: status
  J->>J: complete row; on failure write attempt n+1 and queue it delayed
```

- `WebhooksConsumer` (`webhooks.consumer.ts`) is an `IdempotentHandler` on the `webhooks` queue:
  a redelivered event finds its `processed_events` claim and writes nothing. Only the event's
  tenant's endpoints are read (`TenantRepository` plus row-level security), so another tenant's
  endpoints never see the event.
- `WebhookDeliveryJob` (`delivery.job.ts`) claims an attempt by moving `next_attempt_at` 60 s
  ahead, so a duplicate job finds it not due and does nothing. The HTTP request runs outside any
  transaction.
- **Suspended tenants** (FR-004): the job returns `paused` without touching the row.
- `WebhookSweepJob` (`webhook-sweep.job.ts`) runs every minute per active tenant. It queues again
  any pending attempt more than 2 minutes past due: lost jobs, workers that died mid-request,
  attempts held during a suspension. It also deletes deliveries older than 30 days.

## Checklist when adding a webhook event

- [ ] Add the type to `WEBHOOK_EVENTS` (`apps/api/src/platform-kernel/db/tables/integrations.ts`)
  and to the `webhooks_events_known` check in a new migration.
- [ ] Build its `data` in `webhookData`, and decide what must never be sent (internal notes,
  secrets).
- [ ] Add it to `WebhookEvent` in `apps/api/openapi.yaml` and regenerate the web client.
- [ ] Add it to `WEBHOOK_EVENT_OPTIONS` in `apps/web/src/pages/admin/integrations/WebhooksPage.tsx`.
- [ ] Cover it in `apps/api/test/integration/webhooks/webhooks.test.ts`, including a case where
  nothing should be sent.
