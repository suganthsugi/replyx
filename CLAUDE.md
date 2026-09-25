# Commit rules

Follow [docs/commit-guidelines.md](docs/commit-guidelines.md) for every commit: one-line messages, one functionality change per commit (unit commits), and no co-author or AI references.

## Skill catalog

Status: planned = not yet written; ready = in `.claude/skills/<name>/SKILL.md`.

| Name | Status | Purpose | Used by |
|------|--------|---------|---------|
| tenant-scoping | ready | TenantContext, `withTenant`/`withTenantReadOnly`, TenantRepository, RLS migrations via `enable_tenant_rls` | backend-agent, test-automator, reviewer |
| api-conventions | ready | AppError and error format, validation pipe, cursor pagination, route decorators (`@RequirePermission`/`@StaffApi`/`@Public`/`@CustomerApi`/`@OperatorApi`), `openapi.yaml` operationIds and tags, customer vs staff APIs | backend-agent, frontend-connector, reviewer |
| realtime-events | ready | Outbox append, domain event types, relay, Socket.IO rooms and streams, sync catch-up, customer projections | backend-agent, frontend-connector, test-automator |
| testing-conventions | ready | Vitest/Supertest/Testcontainers harness, factories, `asUser`, success/403/cross-tenant-404 triad, cross-tenant fixtures | test-automator, reviewer |
| ui-components | ready | MUI theme and tokens, shared component system, route areas (`AreaShell`), accessibility (loading/empty/error, focus, LiveRegion), no ticket concepts in the customer UI | frontend-agent |
| data-hooks | ready | Wrapping the orval generated client, http mutator and CSRF, query keys, socket stream cache updates, error mapping | frontend-connector |
| web-testing | ready | `renderWithProviders`, RTL role queries, typed MSW handlers, axe checks, Playwright projects, axe fixture and Mailpit | frontend-automator |
| docs-style | planned | Starlight guide/concept/developer page style and sidebar groups | documentator, dev-documentator |
| conventional-commit | ready | Commit one Spec Kit task as `type(scope): Txxx Summary`, staging only the task's files | committer |
| writing-skills | ready | How to write or update a skill in `.claude/skills/` | skill-writer |
| speckit-* | ready | Spec Kit workflow: specify, clarify, plan, tasks, analyze, checklist, converge, implement, constitution, taskstoissues | orchestrator |
