---
name: review-routing-rules
description: Recurring test-gap pattern seen in the US11 routing rules review (router behaviour changes without event/skip-path tests)
metadata:
  type: project
---

- When a shared router/service gains behaviour (apps/api/src/messaging/customer-message-router.ts now applies tags and puts them in `ticket.created`), check that a test asserts the outbox event payload and each skip path (staff-started, reopened, follow_up). apps/api/test/integration/routing/routing-rules.test.ts checks DB rows only.
- Admin-supplied free text that becomes a regex (apps/api/src/routing/rule-evaluation.ts) was safe: escaped literals joined by `\s+`, phrases capped at 100 chars and 20 per list. Re-check the escaping if the matcher changes.

**Why:** Phase 14 review, 2026-10-01.
**How to apply:** on any story that changes an existing pipeline, grep the tests for the changed event type.
