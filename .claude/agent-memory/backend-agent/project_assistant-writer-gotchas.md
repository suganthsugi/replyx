---
name: project-assistant-writer-gotchas
description: T020 assistant message writer facts - shared PublicReplyService, null author_id uniqueness, SLA is ticket-row derived, template wording
metadata:
  type: project
---

Staff and assistant public replies share `apps/api/src/messaging/public-reply.service.ts` (`publish(..., { countsAsReply })`); `AssistantMessageWriter` (messaging.module.ts, exported) wraps it. StaffMessagesService is in the api-only MessagingHttpModule, so worker code must use the MessagingModule exports.

**Why:** assistant rows have `author_id` NULL, so `UNIQUE (tenant_id, author_id, client_message_id)` never fires; idempotency is `findAssistantByClientMessageId(ticket, key)`.

**How to apply:** SLA recompute is derived from tickets.first/last_agent_reply_at, so the writer controls SLA; the consumer only skips handoff messages. Don't add description text to openapi.yaml for already-generated schemas (web client freshness check); quote any YAML scalar containing ": ". The triage.test.ts socket timeout in tickets suite is a flake (passes alone).
