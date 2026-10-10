---
name: project-ai-drafts-gotchas
description: T023 AI drafts - aiDraftId lives in message metadata, ai module entry point from messaging, throwaway-test trick for unwired controllers
metadata:
  type: project
---

`aiDraftId` on `POST /tickets/{id}/messages` is validated by `assertOpenAiDraft` (`ai/drafts/ai-draft-reference.ts`, called from `StaffMessagesService.insertMessage`) and stored in `ticket_messages.metadata` (not on `MessageDto`, so openapi `Message` is unchanged); `StaffReplyConsumer` reads it back from metadata.

**Why:** the `message.created` payload is the staff `Message` DTO; adding a field would change the generated web client.

**How to apply:** to test a controller the orchestrator hasn't wired yet, `getTestApp({ imports: [ProbeModule] })` with a throwaway `@Module({controllers, providers})` and construct writers with `new X(await service(OutboxService))`. `ai_turns` is unique per trigger message, so a test writing several drafts needs one ticket message per turn (FK `ai_drafts_turn_fk`).
