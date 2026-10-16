---
title: Local development
description: Run the whole ReplyX stack on your machine with Docker Compose, sign in with the seeded accounts, and run the linters, tests and end-to-end suites the way CI does.
---

Everything runs in containers: Node, pnpm, PostgreSQL, Valkey and Mailpit. The host needs only
**Docker** (Docker Desktop on Windows and macOS, Docker Engine with the Compose plugin on Linux)
and Git. The services are defined in `compose.yaml` at the repository root.

On Windows, clone inside WSL 2 for fast file watching. If the repository stays on `C:\`, set
`CHOKIDAR_USEPOLLING=true` in `.env`. Browsers resolve `*.localhost` to 127.0.0.1, so tenant
subdomains work without editing the hosts file.

## First run

```bash
cp .env.example .env
docker compose up -d --build
docker compose run --rm api pnpm --filter api migrate
docker compose run --rm api pnpm --filter api seed:dev
```

`up` starts `postgres`, `valkey`, `mailpit`, `api` and `worker` (Nest in watch mode), `web` (Vite)
and `docs`. A one-off `install` service runs `pnpm install` into named volumes first. Add
`--profile scan` to run ClamAV too; without it, uploads are marked clean in development.

| Address | What |
|---|---|
| `http://acme.localhost:5173/` | Customer chat of tenant `acme` |
| `http://acme.localhost:5173/desk` | Staff workspace |
| `http://console.localhost:5173/` | Platform console |
| `http://localhost:8025` | Mailpit: sign-in links and notification emails |
| `http://localhost:4321` | This docs site |
| `http://localhost:3000` | The API directly (the web app proxies `/api` and `/rt` to it) |

## Seeded accounts

`seed:dev` (`apps/api/src/tenancy/dev-seed.ts`) creates two tenants, `acme` and `globex`, each with
groups Support and Billing.

| Who | Sign in |
|---|---|
| Platform operator | `operator@replyx.test` / `operator-password` on the console |
| Admin, manager, agent | `admin@acme.test`, `manager@acme.test`, `agent@acme.test` / `password-123456` |
| Customer | `customer@acme.test`: request a sign-in link and open it from Mailpit |

The `globex` tenant has the same shape with `@globex.test` addresses, for checking isolation.

## Everyday commands

```bash
docker compose up -d                  # start
docker compose logs -f api worker     # follow the backend
docker compose down                   # stop (data stays in volumes)
docker compose run --rm tools pnpm install   # after changing a package.json
```

- **Restart after changes** the dev stack doesn't pick up on its own:
  `docker compose restart api worker` after backend changes that watch mode misses, and
  `docker compose restart web` before running end-to-end tests after frontend changes (Vite can
  serve stale modules).
- **New migration**: add `apps/api/migrations/NNNN_name.ts`, then run `migrate` as above. Migrations
  run as `replyx_owner`; the app never holds that role.
- **API contract**: edit `apps/api/openapi.yaml`, then `docker compose run --rm tools bash
  scripts/generate-api-client.sh` and commit the regenerated `apps/web/src/api/generated`.
- **Moving time**: `docker compose run --rm api pnpm --filter api dev:advance-clock --hours 73`
  shifts every running dev process forward (grace periods, pending dates, SLA timers);
  `--reset` puts it back. Refused when `NODE_ENV=production`.

## Tests

The `tools` service has the Docker socket mounted, so API tests start their own PostgreSQL and
Valkey with Testcontainers; they never touch the dev database.

```bash
docker compose run --rm tools pnpm turbo run lint typecheck test   # what CI runs
docker compose run --rm tools bash scripts/test-affected.sh        # only what your changes touch
docker compose run --rm tools bash scripts/check-coverage.sh       # api >= 80%, web >= 70%
docker compose run --rm tools pnpm --filter api test:cross-tenant  # tenant isolation suite
```

End-to-end tests run in the `playwright` profile against the running stack (seed it first):

```bash
docker compose --profile e2e run --rm playwright bash -c 'cd /repo && pnpm --filter web exec playwright test e2e/'
```

The suite shares one sign-in rate limit (10 a minute per IP), so `apps/web/playwright.config.ts`
runs the sign-in-heavy specs one after another. `e2e/a11y.spec.ts` runs axe on every page last.

Other checks:

| Check | Command |
|---|---|
| Customer bundle size | `pnpm --filter web build && pnpm --filter web check:bundle` |
| Performance at plan scale (slow, opt-in) | `docker compose run --rm -e PERF=1 tools bash -c 'cd apps/api && npx vitest run test/perf'` |
| Docs links | `pnpm --filter docs build && pnpm --filter docs check:links` |
| Dependency audit | `docker compose run --rm tools pnpm audit --prod --audit-level high` |

## Where to go next

- [Architecture](/developers/architecture/) for how the pieces fit.
- [Authorization](/developers/authorization/) before adding a route.
- [Deployment](/developers/deployment/) for the production VM.
