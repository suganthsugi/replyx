---
name: commerce-connector-gotchas
description: T019 commerce connector (apps/api/src/ai/commerce/) - where Spree v3 field names can be read offline, openapi edit vanished, outbound-guard unit test fails in docker
metadata:
  type: project
---

- Spree 5.5 v3 field names are readable offline in the sibling repo a local Spree checkout: `node_modules/@spree/docs/dist/api-reference/admin-api/{querying,endpoints}.md` (expand keys are `items`, `fulfillments`, not v2 `line_items`, `shipments`) and `apps/storefront/node_modules/@spree/sdk/dist/index-*.d.ts` (Order/LineItem/Fulfillment types). No `admin.yaml` ships there.
- Ransack silently drops non-whitelisted `q[...]` predicates (returns unfiltered list), so the connector must match `order.number` itself.
- `apps/api/openapi.yaml` edits were reverted mid-task once (another agent's checkout). Always `git diff --stat apps/api/openapi.yaml` right before reporting, then re-run orval via `docker compose run --rm -T tools sh -c "pnpm --filter web exec orval --config orval.config.ts"` (no host pnpm needed).
- `test/unit/kernel/outbound-guard.test.ts` (2 tests) fails in the tools container: the `node:dns` vi.mock is not applied, real DNS says `unresolvable`. Pre-existing, not caused by guard users.
- Redocly on Windows: `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/spec" -w /spec redocly/cli lint apps/api/openapi.yaml`; 9 errors on main are pre-existing.
