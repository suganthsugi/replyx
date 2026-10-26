# ReplyX

ReplyX is a self-hostable, multi-tenant customer support helpdesk. Customers talk to you through a
chat widget, and your team works the conversations as tickets in a staff desk. Each tenant gets its
own subdomain, and PostgreSQL row-level security keeps tenants' data apart.

## Features

- **Customer chat**: customers sign in by email link and chat with your team or an AI assistant.
- **Staff desk**: triage, assignment, macros, merge and split, custom views, search and notifications.
- **Admin**: roles and groups, routing and automation rules, SLAs and business hours, audit log and
  data retention.
- **AI assist** (optional): reply drafts, an assistant that can look up orders in a connected
  store (Spree), and per-conversation model routing through OpenRouter.
- **Integrations**: signed outbound webhooks and a documented OpenAPI contract.
- **Platform console**: operators create, suspend and support tenants.

## Tech stack

| App            | Path        | Stack                                                                          |
| -------------- | ----------- | ------------------------------------------------------------------------------ |
| API and worker | `apps/api`  | NestJS, PostgreSQL 17 (Kysely), Valkey, BullMQ, Socket.IO                      |
| Web            | `apps/web`  | React, MUI, Vite, React Query, a client generated from `apps/api/openapi.yaml` |
| Docs           | `apps/docs` | Fumadocs on Next.js, exported as static files                                  |

The repository is a pnpm and Turborepo monorepo. Everything runs in Docker Compose.

## Quick start

You only need Docker (with Compose) and Git.

```bash
cp .env.example .env
docker compose up -d --build
docker compose run --rm api pnpm --filter api migrate
docker compose run --rm api pnpm --filter api seed:dev
```

Then open:

| Address                           | What                                                            |
| --------------------------------- | --------------------------------------------------------------- |
| `http://acme.localhost:5173/`     | Customer chat for the seeded tenant `acme`                      |
| `http://acme.localhost:5173/desk` | Staff desk (`agent@acme.test` / `password-123456`)              |
| `http://console.localhost:5173/`  | Platform console (`operator@replyx.test` / `operator-password`) |
| `http://localhost:8025`           | Mailpit, where sign-in links and notification emails land       |
| `http://localhost:4321`           | Documentation site                                              |

These accounts and passwords are development seeds only. See
[Local development](apps/docs/content/docs/developers/local-development.md) for the full guide,
including how to run the tests.

## Documentation

The docs site (`apps/docs`) covers user guides, admin settings, concepts and developer topics:

- [Architecture](apps/docs/content/docs/developers/architecture.md)
- [Local development](apps/docs/content/docs/developers/local-development.md)
- [Deployment](apps/docs/content/docs/developers/deployment.md): a single VM with host nginx, a
  wildcard certificate and Docker Compose

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first, and report
security issues as described in [SECURITY.md](SECURITY.md).

## License

ReplyX is released under the [MIT License](LICENSE).
