# Golden-set results

SC-006 needs at least 18 of 20 correct answers or hand-offs. SC-007 needs the Advanced level in at most 2 of 20 turns.

## How to run

1. In `.env`, set `AI_PROVIDER=openrouter` and `COMMERCE_PROVIDER=spree`, then `docker compose up -d api worker`.
2. In acme, Admin → AI: save the OpenRouter key and set the reply mode to **Auto-reply**. Connect the store: for the local Spree, the origin is `http://192.168.65.254:3100` (Docker Desktop's host gateway; Rails in development refuses the `host.docker.internal` name, but allows IP hosts) with the read-only key.
3. Run `docker compose exec -T api node /repo/specs/002-ai-assist/golden/run-golden.mjs` (in Git Bash, prefix `MSYS_NO_PATHCONV=1`). It loads [policy.md](policy.md), closes the customer's active tickets before each question so every question starts its own ticket, and writes the transcript to `golden/last-run.json`.
4. Grade each turn against [questions.md](questions.md) and fill in the table below.

## Real-provider run (OpenRouter + local Spree)

**Not run yet.** The acme OpenRouter key was removed on 2026-10-10 by the `ai-assist` e2e spec, whose cleanup deletes the tenant's provider key (the spec is meant for a tenant with no real key). The key has to be entered again in Admin → AI before this run.

| # | Expected | Reply | Hand-off | Level | Correct |
|---|---|---|---|---|---|
| 1–20 | see questions.md | | | | |

## Dry run (fake AI provider, real Spree), 2026-10-10

This run checks the harness and the Spree path, not answer quality: the fake provider replies from fixed templates. Settings: `AI_PROVIDER=fake`, `COMMERCE_PROVIDER=spree`, store `http://192.168.65.254:3100`, dev key with the scopes `read_orders`, `read_customers` and `read_fulfillments`.

| # | Question | Reply (fake model) | Store path |
|---|---|---|---|
| 1 | Return window | Quotes the policy chunk: 30 days, custom tags not returnable | Policy search (embedding) found the golden policy |
| 9 | R100200 | "complete, tracking number TRK100200" | Own order found, fulfillment tracking read |
| 10 | R100201 | "complete" | Own order found |
| 11 | R100202 | "canceled" | Own order found, canceled state read |
| 12 | R100300 | "couldn't find an order with that number for your account" | Another customer's order is not disclosed |
| 13 | R999999 | "couldn't find an order with that number" | Missing order |
| 14 | No number | "Could you share your order number?" | No lookup |
| 16 | Human please | Generic greeting, no hand-off | The fake model hands off only on its own fixed phrase; the real model is graded on this |

Every turn used the Fast level. Each question landed on a new ticket (#1237–#1244).

Findings:
- The Spree key scopes listed in the UI (`read_orders`, `read_customers`, `read_fulfillments`) are enough: orders with `expand=items,fulfillments` read correctly (US3 review item #6).
- Spree reports `status: "draft"` even for completed orders, so the connector must keep reading `completed_at`, `canceled_at`, `fulfillment_status` and `payment_status`, as it does (the US3 decision that `status` is not reliable).
