---
name: prod-vm-deploy
description: Prod VM stack facts (infra/compose.prod.yml, host nginx + internal Caddy) and traps found while validating it locally
metadata:
  type: project
---

Prod = host nginx (TLS, wildcard *.replyx.example.com) -> 127.0.0.1:8081 Caddy container (HTTP only) -> api. Files: `infra/compose.prod.yml`, `infra/caddy/Caddyfile`, `infra/nginx/replyx.conf`, `infra/scripts/{deploy,init-env,pg-backup}.sh`, `infra/.env.prod.example`.

- The worker's `scannerFromEnv` throws at startup when NODE_ENV=production and CLAMAV_HOST is empty (`attachments/passthrough-scanner.ts`), so "clamav off by default" cannot work; deploy.sh enables profile `scan` whenever CLAMAV_HOST is set.
- pg_dump must run as the `postgres` superuser: tenant tables are FORCE RLS, so replyx_owner dumps 0 rows.
- Compose env: use explicit per-service `environment:` with `${VAR:?}` (not env_file) so `config --env-file infra/.env.prod.example` validates and the owner/retention creds stay in migrate/worker only.
- `.gitignore` has `.env*` so `.env.prod.example` needs its own `!` line. Names in a host nginx site file (log_format, map var, ssl_session_cache zone) must be unique across the whole http{}: prefix `replyx`.
- Local smoke test: `docker compose -p replyxprodtest ... up -d` (the dev stack is also project `replyx`, its pgdata volume would be reused otherwise); Git Bash needs `MSYS_NO_PATHCONV=1` for `docker compose run ... bash /path`.

**Why:** each was found during Phase 12 (2026-09-30). **How to apply:** before changing the prod stack or the worker's startup guards; see [[host-tooling]].
