# Quickstart: AI Assist

## Prerequisites

- The dev stack from spec 001 (`docker compose up -d --build`). Its Postgres image is now `pgvector/pgvector:pg17`.
- **Existing dev volume only**: run `docker compose exec postgres psql -U postgres -d replyx -c "CREATE EXTENSION IF NOT EXISTS vector"` once, then run migrations. New volumes get it from `infra/postgres/init.sql`. Production does the same one-off step before deploying `0017_ai` (add it to the deploy notes).
- `.env`: `REPLYX_SECRETS_KEY` (generate with `openssl rand -base64 32`). For offline work, set `AI_PROVIDER=fake` and `COMMERCE_PROVIDER=fake` (the default in tests and e2e).

## Run the checks

```bash
docker compose run --rm tools pnpm turbo run lint typecheck test
```

```bash
docker compose run --rm playwright pnpm --filter web exec playwright test e2e/ai-assist.spec.ts
```

## Validation scenarios (fake providers)

Sign in to `acme.localhost:5173` as the seeded admin. Data shapes: [data-model.md](data-model.md); endpoints: [contracts/ai.yaml](contracts/ai.yaml).

1. **Settings (US1)**: Admin → AI → paste any key → Test connection → success. Set the mode to **Auto-reply**. Paste the key `fake-invalid`, then send a customer message: the ticket goes to Needs Triage as normal, no assistant message appears, and the admin sees the "AI paused: invalid key" banner.
2. **Policy (US2)**: Admin → AI → Policies → New → type "Returns are accepted within 30 days." The status goes Processing → Ready. Edit it to 14 days and wait for Ready.
3. **Order conversation (US3)**: as the seeded customer, send "Where is my order?". An "Assistant" reply asks for the order number. Send `R100200` (fixture order for this customer): the reply shows status and tracking. Send `R999999` (fixture order of another customer): the reply says it could not find that order.
4. **Return policy (US3)**: send "Can I return it?". The reply says 14 days.
5. **Hand-off (US3)**: send "I want a human". You get one hand-off message, the ticket shows the "AI hand-off" tag and history entry, and a further message gets no assistant reply.
6. **Agent stop (US3)**: on a new ticket, have an agent reply. The next customer message gets no assistant reply.
7. **Drafts (US3)**: switch the mode to **Drafts** and send a message. The agent's ticket shows "AI draft: Use / Discard" and the customer sees nothing. Use → Send: the customer sees the reply authored by the agent.
8. **Burst (US3)**: send 3 messages within 2 seconds. You get exactly one assistant reply.
9. **Routing (US4)**: give the groups Billing and Shipping AI descriptions and turn on AI routing. Send "I was charged twice". The ticket lands in Billing, and history shows "AI routing" with its confidence.
11. **SLA (US3)**: with an SLA policy that has a 1-hour first-response target, the assistant's first answer shows the target as met. A ticket whose only assistant message is the hand-off notice still shows the target running.
12. **Take over / hand back (US3)**: on a ticket the assistant is handling, the agent presses **Take over**. The badge on both the agent view and the customer chat switches from the shining "Assistant" badge to the agent's name, and the next customer message gets no assistant reply. Press **Hand back to AI**: the badge shows "Assistant" again, and the next customer message gets an assistant reply.
13. **Badge with reduced motion**: with the OS "reduce motion" setting on, the Assistant badge is a static gradient. axe reports no contrast issues.
10. **Usage (US3)**: Admin → AI → Usage lists the runs from the steps above, with purpose, model, tokens and cost.

## Real-provider check (manual, before release; SC-006, SC-007)

1. Set `AI_PROVIDER=openrouter` and `COMMERCE_PROVIDER=spree`, and restart api and worker.
2. Save a real OpenRouter key with a small credit limit. Connect the store `https://store.example.com` with a read-only secret key covering orders and customers, created in Spree admin by the owner.
3. Load `specs/002-ai-assist/golden/policy.md` and run the 20 questions in `golden/questions.md` (created in the golden-set task).
4. Expect at least 18 correct answers or hand-offs and no contradictions of the policy. The Usage list should show the Advanced level in at most 2 of 20 turns.
