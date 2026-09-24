# Quickstart: run locally, validate, and deploy to the VM

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

This guide describes how the finished MVP is run and validated. The commands become real as the
scaffold tasks in `tasks.md` land. Everything runs in Docker, both on your machine
([research D26](research.md#d26-docker-based-development)) and on the VM
([research D24](research.md#d24-deployment-docker-compose-on-the-owners-vm)). Design details are
linked, not repeated.

## Prerequisites

- **Docker Desktop** (Windows/macOS) or Docker Engine with the Compose plugin (Linux). Nothing else
  is needed on the host: Node, pnpm, PostgreSQL and Redis all run in containers.
- Git.
- **Windows**: clone the repository inside WSL 2 (for example `\\wsl$\Ubuntu\home\you\replyx`)
  for fast hot reload. If you keep it on `C:\`, set `CHOKIDAR_USEPOLLING=true` in `.env`.
- Browsers resolve `*.localhost` to 127.0.0.1 (Chrome, Edge and Firefox do by default), so
  tenant subdomains work locally without editing the hosts file.

## Local development

First run:

```bash
cp .env.example .env
```

```bash
docker compose up -d --build
```

```bash
docker compose run --rm api pnpm --filter api migrate
```

```bash
docker compose run --rm api pnpm --filter api seed:dev
```

`docker compose up` starts `postgres`, `redis`, `mailpit`, `api` and `worker` (watch mode) and
`web` (Vite with hot reload). Add `--profile scan` to also run ClamAV; without it, uploaded files
are marked clean in development.

Everyday use:

```bash
docker compose up -d
```

```bash
docker compose logs -f api worker
```

```bash
docker compose down
```

After changing dependencies in any `package.json`, reinstall inside the containers:

```bash
docker compose run --rm tools pnpm install
```

The dev seed creates:

| What | Value |
|------|-------|
| Platform operator | `operator@replyx.test` / `operator-password` on `http://console.localhost:5173` |
| Tenant A | slug `acme`: admin `admin@acme.test`, manager `manager@acme.test`, agent `agent@acme.test` (role "Support Agent" with view + edit on group **Support**), customer `customer@acme.test` |
| Tenant B | slug `globex`: same shape with `@globex.test` emails and one existing ticket, used for isolation checks |
| Password for all seeded staff | `password-123456` |
| Routing rule in `acme` | "refund" → group Billing |

Addresses:

- Customer chat: `http://acme.localhost:5173/`
- Agent workspace: `http://acme.localhost:5173/desk`
- Platform console: `http://console.localhost:5173/`
- Mailpit (sign-in links, notification emails): `http://localhost:8025`
- API docs (from `apps/api/openapi.yaml`): `http://localhost:3000/api/docs`

## Main flow

This is the end-to-end scenario (spec User Stories 1, 5, 6 and 7, SC-016). It is automated as
`apps/web/e2e/main-flow.spec.ts` and can be walked through by hand with three browser profiles
(customer, manager, agent).

| # | Action | Expected result |
|---|--------|-----------------|
| 1 | Customer opens the chat, requests a sign-in link, opens it from Mailpit, writes "My order has not arrived", presses Send | Message shows as sent, then "Support has your message". No ticket number anywhere. |
| 2 | Manager has **Needs Triage** open | The ticket appears within 2 s with a live count update, without refreshing. |
| 3 | Manager triages it to **Support** | It leaves Needs Triage. It appears in Support's **Unassigned & Open**. |
| 4 | Agent (Support Agent role) | Gets an in-app notification "New ticket in Support" and replies publicly. |
| 5 | Customer | Sees the typing indicator, then the reply with the agent's name and avatar, live. Customer answers. The agent sees it live. |
| 6 | Agent adds an internal note mentioning the manager | Manager is notified. The customer's chat shows nothing and the customer gets no notification. |
| 7 | Agent resolves the ticket | Customer sees the friendly resolved marker. |
| 8 | Customer replies "thanks" within the grace period | The same ticket reopens (same group and owner). The agent re-resolves in one action. |
| 9 | Fast-forward past the grace period (`docker compose run --rm api pnpm --filter api dev:advance-clock --hours 73`, development only), then the customer writes again | The old ticket is closed. A new ticket is created, linked **follow-up of** the old one, and appears in Needs Triage. The customer still sees one continuous thread. |

## Validation scenarios

| Scenario | How to check | Expected |
|----------|--------------|----------|
| Tenant isolation (US2, SC-010) | `docker compose run --rm tools pnpm --filter api test:cross-tenant` | Every route, subscription, search and attachment path returns 404 / empty / rejected for the other tenant. The suite fails if a route has no fixture. |
| RLS defense in depth | `docker compose run --rm tools pnpm --filter api test -- rls` | Queries without tenant context return zero rows on every tenant table. |
| Guessed ids | As `agent@acme.test`, `GET /api/v1/tickets/{globex ticket id}` | `404 TICKET_NOT_FOUND`, identical to a random uuid. |
| Live permission change (US4, SC-011) | Agent keeps a Support ticket open. Admin removes edit on Support from "Support Agent". | Within 2 s the agent's reply box disables. Their owned Support tickets become unassigned. |
| Double send (SC-006) | `docker compose run --rm tools pnpm --filter api test -- concurrency` | 50 parallel sends with 10 repeated `clientMessageId`s produce 40 messages on exactly one ticket. |
| Auto-close race | Same suite | A message racing the auto-close lands on exactly one ticket. |
| Reconnect catch-up (SC-007) | In the agent workspace, go offline in DevTools, send 3 customer messages, go back online | All 3 appear once, in order. The notification count is correct. |
| Attachments | Customer uploads a 30 MB file, then an `.exe` | `ATTACHMENT_TOO_LARGE`, then `ATTACHMENT_TYPE_NOT_ALLOWED`, each with a clear message. With `--profile scan`, a valid image shows "processing" until scanned. Its download link stops working after 15 minutes. |
| Support access (FR-001a) | Operator opens a support session for `acme` without a grant, then after admin grants 24 h | First: not found. Then: read-only access. A write returns `READ_ONLY_SUPPORT_ACCESS`. The audit log shows each read. |
| Tenant suspension (FR-004) | Operator suspends `acme` while users are connected | Sockets disconnect. Staff sign-in fails. The chat shows "support is unavailable". Data is intact after reactivation. |
| Accessibility (SC-013a) | `docker compose run --rm playwright pnpm --filter web test:e2e -- a11y` | axe reports zero AA violations. The keyboard-only main flow passes. |

## Tests

The `tools` service has the Docker socket mounted, so Testcontainers can start throwaway databases
(research D26).

```bash
docker compose run --rm tools pnpm turbo run lint typecheck test
```

```bash
docker compose run --rm tools bash scripts/test-affected.sh
```

```bash
docker compose run --rm tools bash scripts/check-coverage.sh
```

```bash
docker compose run --rm playwright pnpm --filter web test:e2e
```

Coverage gates: api ≥ 80%, web ≥ 70%. CI (`.github/workflows/ci.yml`) runs the same commands.

## Deploy to your VM

One-time setup on the VM (any recent Linux with Docker Engine and the Compose plugin; suggested
4 vCPU, 8 GB RAM, 100 GB SSD):

1. **DNS**: add an `A` record for `*.yourdomain` and one for `console.yourdomain`, both pointing
   to the VM's public IP. Each tenant then lives at `{slug}.yourdomain`.
2. **Firewall**: allow only 22, 80 and 443.
3. **Files**: copy `infra/compose.prod.yml`, `infra/caddy/`, `infra/backup/` and `.env.example`
   to the VM (for example `/opt/replyx`), rename `.env.example` to `.env`, fill it in, and run
   `chmod 600 .env`. It holds:
   - your domain;
   - the database password;
   - the session, file-signing and webhook-encryption keys (the file explains how to generate
     them);
   - SMTP relay credentials for outgoing email;
   - the off-VM backup target (SFTP server, NAS or bucket).
4. **Registry access**: log in once to GitHub Container Registry, with a token that can read
   packages:

```bash
docker login ghcr.io
```

Deploy or update (images are built by `.github/workflows/release.yml` and tagged with the commit
SHA):

```bash
IMAGE_TAG=<commit-sha> bash infra/scripts/deploy.sh
```

This runs `docker compose pull`, then the one-off `migrate` service, then `docker compose up -d`.
Caddy obtains HTTPS certificates automatically: `console.yourdomain` at start-up, and each tenant
subdomain the first time it is visited (only for tenants that exist). To roll back, run the same
command with the previous tag.

Create the first tenant from the console (`https://console.yourdomain`) with the operator account
set in `.env`.

Check health and backups:

```bash
docker compose -f compose.prod.yml ps
```

```bash
docker compose -f compose.prod.yml exec backup pgbackrest info
```

Practise a restore on a spare VM before going live. A backup that has never been restored is not
proven to work (research D23).
