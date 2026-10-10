---
name: ai-indexer-gotchas
description: T015 AI policy indexer/search gotchas - BullMQ job ids, delayed re-schedule, shell escape corruption, smoke-test recipe
metadata:
  type: project
---

- BullMQ rejects `:` in custom job ids (one colon throws "Custom Id cannot contain :"), so ids are `index.{versionId}` not `index:{versionId}` (`apps/api/src/ai/knowledge/policy-index.job.ts`).
- Long provider work must not run inside an `IdempotentHandler` (it holds the tx): the handler only enqueues a `JobProcessor` job; the processor re-schedules itself with `job.moveToDelayed(Date.now()+ms, job.token)` + `throw new DelayedError()`.
- `ai_policy_versions` CHECK: `(status='failed') = (error IS NOT NULL)`, so abandoning a version of a deleted document means leaving it `processing`.
- Never write `\u0000`/`﻿` through `node -e`/sed from the shell: they land as literal NUL/BOM bytes in the source. Use `String.fromCharCode` and Write/Edit.
- Smoke recipe: throwaway `test/integration/ai/zz-*.test.ts` builds `new AiIndexJob(uow, outbox, audience, status, runs, clock, provider, storage)` from `service(...)`, with a stub `Job` (`opts.attempts`, `attemptsMade`, `token`, `updateData`, `moveToDelayed`); `getTestWorker()` + `drainOutbox()` exercises the real wiring.
