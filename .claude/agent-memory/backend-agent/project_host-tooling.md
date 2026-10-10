---
name: host-tooling
description: Windows host has Node 24 but no pnpm/turbo/psql; Docker Desktop is a per-user install that is usually stopped and must be started first
metadata:
  type: project
---

On the Windows host (checked 2026-09-24), `pnpm` is not on PATH and corepack has no cached pnpm@12.5.1, so `pnpm install --lockfile-only` and `pnpm turbo` can't run offline. There is no host `psql`.

Docker Desktop is installed per-user at `%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe` (not under Program Files) and is usually not running. Start it with `cmd //c start "" "%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe"`, then poll `docker info`. It is ready in about a minute. In Git Bash, set `MSYS_NO_PATHCONV=1` for `-v C:/...:/container/path` mounts.

**Why:** all dev and test work is meant to run in Docker Compose (plan research D26). The host is not set up for pnpm.

**How to apply:** don't claim lockfile regeneration or turbo runs happened on the host. Run pnpm in a `node:24` container with corepack pnpm@12.5.1 (see [[pnpm12-policies]]). On 2026-09-24 the lockfile was regenerated fresh in a container and a frozen install passes. If `ERR_PNPM_OUTDATED_LOCKFILE` shows up again, a manifest changed without the lockfile being regenerated.

OpenAPI lint works on the host through Docker: `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W)":/work -w /work redocly/cli lint --format=summary apps/api/openapi.yaml`, run from the repo root (checked 2026-09-24). With no redocly config it uses the built-in recommended ruleset, so unused components and a missing info.license only produce warnings.

`python`/`python3` on the host is the Windows Store stub and hangs until the tool times out, so don't use it for scripting (checked 2026-09-24). `docker compose config` fails without a root `.env` (compose.yaml uses `env_file: .env` and `${VAR:?}`). To validate without leaving a `.env` in the repo, copy `compose.yaml`, the Dockerfiles, `infra/postgres/init.sql`, and `.env.example` (as `.env`) into the scratchpad and run it there.

Workflow lint works on the host through Docker: `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W)":/repo -w /repo rhysd/actionlint:latest -no-color .github/workflows/ci.yml` (the image bundles shellcheck; the flag is `-no-color`, not `-color=never`) (checked 2026-09-24). Check turbo env pass-through with `pnpm turbo run test --filter=api --dry=json` in the tools service and read `globalCacheInputs.environmentVariables.passthrough`.

`scripts/test-affected.sh` and any apps/api integration test (they use Testcontainers) must run via `docker compose run --rm tools ...`, not `docker compose run --rm api ...` (checked 2026-09-25). The `api` service has no docker.sock mount, so Testcontainers fails with "Could not find a working container runtime strategy"; `tools` (profile `tools`) mounts `/var/run/docker.sock` and sets `TESTCONTAINERS_HOST_OVERRIDE=host.docker.internal`. `typecheck`/`lint` work fine via either service.

`pnpm exec redocly` inside the `tools` container fails (`redocly not found`, it isn't a workspace devDependency); use `docker compose run --rm -T tools bash -c 'npx --yes @redocly/cli lint apps/api/openapi.yaml'` instead (checked 2026-09-26). `bash scripts/generate-api-client.sh` inside `tools` prints an orval warning `#/servers/0/variables/tenant must NOT have unevaluated properties` (pre-existing, from the `description` key on the server variable) but still generates the client successfully — not a sign of a broken edit.
