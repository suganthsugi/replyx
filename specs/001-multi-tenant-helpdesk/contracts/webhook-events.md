# Webhook contract (outgoing)

Delivery rules: [research.md D16](../research.md#d16-webhooks). Webhooks are P3.

## Request

```http
POST {endpoint url}
Content-Type: application/json
User-Agent: ReplyX-Webhooks/1
ReplyX-Event-Id: 0192f3c4-...
ReplyX-Event-Type: ticket.assigned
ReplyX-Delivery-Attempt: 1
ReplyX-Signature: t=1790000000,v1=5f2b...e9
```

- `v1` = hex HMAC-SHA256 of `"{t}.{raw body}"` with the endpoint's secret.
- Receivers should reject requests where `t` is more than 5 minutes old, and should deduplicate
  by `ReplyX-Event-Id` (the same event may be delivered more than once).
- Any 2xx response within 10 s counts as success. Anything else is retried with exponential
  backoff (about 1 min, 5 min, 15 min, 1 h, 3 h, 6 h, 12 h; 8 attempts in total).

## Body

```json
{
  "id": "0192f3c4-...",
  "type": "ticket.assigned",
  "occurredAt": "2026-09-24T10:15:02Z",
  "tenant": { "slug": "acme" },
  "data": { }
}
```

| Type | `data` |
|------|--------|
| `ticket.created` | `{ ticket }` |
| `ticket.updated` | `{ ticket, changes: [{ field, old, new }] }` |
| `ticket.assigned` | `{ ticket, previousOwner, owner }` |
| `ticket.closed` | `{ ticket, closedBy: "agent" \| "auto_close" \| "pending_close" \| "merge" }` |
| `message.created` | `{ ticketId, message }` — **public messages only**; internal notes are never sent to webhooks |

`ticket` is `{ id, number, title, state, priority, group: {id, name} | null, owner: {id, name, email} | null, customer: {id, name, email}, tags: [name], createdAt, updatedAt }`.
`message` is `{ id, authorKind, author: {id, name} | null, body, attachments: [{ id, fileName, contentType, sizeBytes }], createdAt }`.
Attachment files are not included. Receivers fetch them through the API with their own credentials.
