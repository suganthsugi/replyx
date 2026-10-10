---
name: ai-responder-gotchas
description: T021-T024 AI assistant facts - test worker has its own fake provider/commerce, lock order, responder helpers, generated-client git noise
metadata:
  type: project
---

- `getTestWorker().module` and `getTestApp()` are separate Nest apps: each has its own `FakeAiProvider` / `FakeCommerceConnector`. Take fakes from the worker module when testing `AiTurnJob`.
- Lock order for anything touching AI state: `TicketsRepository.lock` first, then `ai_ticket_state` (`apps/api/src/ai/assistant/assistant.repositories.ts`).
- Responder helpers are plain functions (`responderSnapshot`, `responderForCustomer` in `ai/assistant/responder.ts`) so classes with fixed positional ctors (AccessLossConsumer) can use `new ResponderService(outbox)` inline.
- Generated web client: after `docker compose run --rm -T tools bash scripts/generate-api-client.sh`, `git status` lists ~400 files as M (stat noise, autocrlf) but `git diff --stat` shows the real change; nothing to revert, check for `D` only.
- Cross-tenant suite currently fails 3 known gaps (store-connection, runs, fixture-per-resource); takeover/handback/ai-draft routes pass.
- `node -e "..."` in double quotes eats backticks (command substitution); write the script to /tmp via `cat > f <<'EOF'` and run it, or use Edit.
