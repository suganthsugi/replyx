# Contributing to ReplyX

Thanks for helping out. This guide covers how to set up the project, what a good change looks like
and how to get it merged.

## Before you start

- For a bug, open an issue with steps to reproduce, what you expected and what happened.
- For a new feature or a larger change, open an issue first so we can agree on the approach before
  you write code.
- Small fixes (typos, docs, obvious bugs) can go straight to a pull request.

## Development setup

Everything runs in Docker Compose; the host needs only Docker and Git. Follow
[Local development](apps/docs/content/docs/developers/local-development.md) to start the stack,
seed the demo tenants and sign in.

## Making a change

- **API contract first.** Endpoints are described in `apps/api/openapi.yaml`. After editing it, run
  `docker compose run --rm tools bash scripts/generate-api-client.sh` and commit the regenerated
  `apps/web/src/api/generated`. Never edit generated files by hand.
- **Tenant isolation is not optional.** Tenant data is read and written through the tenant-scoped
  repositories, and new tables get row-level security in their migration. Every new endpoint needs
  a success test, a permission (403) test and a cross-tenant (404) test.
- **Accessibility.** UI changes must meet WCAG 2.2 AA: keyboard reachable, labelled controls, and
  loading, empty and error states.
- **Docs.** If the change is visible to users, admins or developers, update the matching page under
  `apps/docs/content/docs`.

The `.claude/skills/` folder holds the project's detailed conventions (API, tenancy, realtime
events, testing, UI). They are written for AI coding agents but are equally useful for people.

## Checks

Run what CI runs before you open a pull request:

```bash
docker compose run --rm tools pnpm turbo run lint typecheck test
docker compose run --rm tools pnpm --filter api test:cross-tenant
```

Coverage must stay at or above 80% for the API and 70% for the web app
(`scripts/check-coverage.sh`).

## Commits

Follow [docs/commit-guidelines.md](docs/commit-guidelines.md):

- One-line messages in the form `type(scope): Summary`, for example
  `fix(tickets): Keep the assignee when a ticket is merged`.
  Types: `feat`, `fix`, `test`, `docs`, `refactor`, `build`, `ci`, `chore`.
- One functional change per commit.
- No `Co-Authored-By` trailers or tool attribution in messages.

## Pull requests

- Keep each pull request focused on one change and describe what it does and how you tested it.
- Include screenshots for UI changes.
- CI must pass before review.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).
