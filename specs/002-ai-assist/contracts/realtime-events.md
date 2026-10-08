# Realtime events added by AI Assist

Same envelope, rooms and catch-up rules as `specs/001-multi-tenant-helpdesk/contracts/realtime-events.md`.

| Event | Room / stream | Payload | Who receives |
|---|---|---|---|
| `ai.draft_ready` | ticket staff stream (same as `message.created` internal notes) | `{ ticketId, draftId }`; the client then calls `GET /tickets/{id}/ai-draft` | Staff with reply access to the ticket |
| `ai.policy_version_updated` | `tenant:admin:ai` (holders of `ai_knowledge.manage`) | `{ documentId, versionId, status }` | Admins on the Policies screen |
| `ai.paused` / `ai.resumed` | holders of `ai_settings.manage` | `{ reason? }` | Admins (banner) |
| `conversation.responder_changed` | ticket staff stream + customer stream (projection drops `ticketId`) | `{ ticketId, responder }` | Staff viewing the ticket; the customer (badge) |
| `ai.responder_scope_changed` | tenant staff + all connected customers of the tenant | `{}`; clients refetch the responder | Everyone with an open conversation |
| `message.created` (existing) | unchanged | `authorKind: "assistant"`, `author: { name: "Assistant" }` | Staff as today; customers through the projection with `isAi: true` |

The assistant's typing indicator reuses the existing typing presence with the pseudo-author `assistant`. It is shown to the customer only in auto mode, from the moment the turn job starts its model call until the message is written or the job ends.
