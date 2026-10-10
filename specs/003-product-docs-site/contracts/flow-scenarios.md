# Contract: Home page flow stages and scenarios

## Stages (in order)

| id | Caption | Links to | AI (neon) |
|---|---|---|---|
| intake | New conversation | `/guides/customer-chat/` | no |
| rules | Routing rules first | `/admin/routing-rules/` | no |
| decision | Decision model picks a group | `/concepts/how-ai-routing-works/` | yes |
| groups | Right team, with confidence | `/admin/roles-and-groups/` | no |
| triage | Not sure? Needs Triage | `/guides/triage/` | no |
| factors | Complexity factors | `/concepts/how-complexity-picks-a-model/` | yes |
| score | Weighted score | `/concepts/how-complexity-picks-a-model/#the-score` | yes |
| levels | Fast · Standard · Advanced | `/guides/ai-assist/#complexity-which-model-answers` | yes |

## Scenarios (loop order)

Weights: frustration 2, several issues 1, technical 1, VIP 1 (Σ 5). Thresholds: Standard ≥ 0.45, Advanced ≥ 0.80. Routing confidence ≥ 0.70.

| # | Message (made up) | Route | Factors (fr, sev, tech, vip) | Score | Level |
|---|---|---|---|---|---|
| 1 | "Where is my order 1042? It said 3 days." | Decision model → **Orders & Shipping** 0.93 | 0.10, 0, 0, 0 | 0.04 | Fast |
| 2 | "Reset my password please" | Rule "Password reset" → **Accounts** (decision model skipped) | 0.25, 0, 0, 0 | 0.10 | Fast |
| 3 | "Export to CSV crashes every time since the update, I've tried twice." | Decision model → **Technical Support** 0.88 | 0.75, 0, 1, 0 | 0.50 | Standard |
| 4 | "Charged twice AGAIN, third time asking. Fix it and refund me." | Decision model → **Billing** 0.81 | 1.0, 1, 0.2, 1 | 0.84 | Advanced |
| 5 | "hi, quick question" | Decision model → best Billing 0.41 < 0.70 → **Needs Triage** | — | — | — |

## Invariants (unit-tested)

1. Every scenario's `expected.score` equals `complexity.score(factors)`, rounded to 2 decimal places, and `expected.level` equals `complexity.level(score)`.
2. A scenario routed by the decision model has `expected.group` equal to its top candidate if confidence ≥ 0.70, and `'Needs Triage'` otherwise.
3. Across the loop, there is at least one each of Fast, Standard, Advanced and Needs Triage, plus at least one rule match. The count of Fast + Standard is greater than the count of Advanced.
4. Every stage `href` resolves (link checker).
5. Messages contain no email addresses, phone numbers, or real-looking names.

## Timing (non-normative)

Each cycle takes about 7 s: intake 0.6 s, rules 0.6 s, decision 1.2 s, groups 0.8 s, factors 1.6 s, score 0.8 s, level 0.8 s, hold 0.6 s. A triage cycle ends after about 4 s. Easing comes from the design-system motion tokens (`cubic-bezier(0.2, 0, 0, 1)`).
