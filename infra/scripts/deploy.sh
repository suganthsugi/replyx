#!/usr/bin/env bash
# infra/scripts/deploy.sh -- build the images on this VM from the git checkout and roll the
# production stack (T204, adapted: no registry, images are built here).
#
#   bash infra/scripts/deploy.sh            # git pull --ff-only, then deploy the new HEAD
#   bash infra/scripts/deploy.sh <git-ref>  # deploy a commit, tag or branch
#
# Run it from the repo root on the VM (~/replyx) as a user that may use docker.
# Prerequisite: infra/.env.prod (bash infra/scripts/init-env.sh).
#
# Rollback is the same command with an older ref: it checks out that commit (detached HEAD),
# rebuilds (cached layers make this quick when the image still exists) and redeploys. Migrations
# are forward-only, so a rollback across a schema change needs a restore from the pre-deploy dump
# (see infra/scripts/pg-backup.sh). To deploy the latest again afterwards: `git switch main`.
#
# Images are tagged with the 12-character commit id (IMAGE_TAG); old tags stay on disk for fast
# rollback; list them with `docker image ls 'replyx-*'` and remove old ones with `docker rmi`.
# Secrets are never printed: the env file is only read for the two non-secret values below.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

ENV_FILE="infra/.env.prod"
COMPOSE_FILE="infra/compose.prod.yml"
REF="${1:-}"

log() { printf '==> %s\n' "$*"; }
die() { printf 'deploy: %s\n' "$*" >&2; exit 1; }

# Reads one value from the env file without exporting or echoing anything else.
env_value() {
  local value
  value="$(grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2- || true)"
  value="${value%$'\r'}"
  printf '%s' "$value"
}

command -v docker >/dev/null 2>&1 || die "docker is not installed"
command -v git >/dev/null 2>&1 || die "git is not installed"
command -v curl >/dev/null 2>&1 || die "curl is not installed"
[ -f "$ENV_FILE" ] || die "$ENV_FILE is missing; run: bash infra/scripts/init-env.sh"
if grep -q -e '=__GENERATE_' -e 'CHANGE_ME' "$ENV_FILE"; then
  die "$ENV_FILE still contains placeholders; create it with infra/scripts/init-env.sh"
fi
case "$(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo 600)" in
  600|400) ;;
  *) echo "deploy: warning: $ENV_FILE should be mode 600 (chmod 600 $ENV_FILE)" >&2 ;;
esac
if [ "$(env_value SMTP_HOST)" = "smtp.example.com" ]; then
  echo "deploy: warning: SMTP_HOST is still the placeholder; invitation and reset emails will not be delivered" >&2
fi

# --- Select the revision --------------------------------------------------------------------
git diff --quiet HEAD -- || die "tracked files have local changes; commit or discard them first"
PREVIOUS="$(git rev-parse --short=12 HEAD)"
if [ -n "$REF" ]; then
  log "Fetching and checking out $REF"
  git fetch --tags --prune origin
  if git rev-parse --verify --quiet "${REF}^{commit}" >/dev/null; then
    TARGET="$REF"
  elif git rev-parse --verify --quiet "origin/${REF}^{commit}" >/dev/null; then
    TARGET="origin/$REF"
  else
    die "unknown git ref: $REF"
  fi
  git checkout --detach "$TARGET"
else
  if ! git symbolic-ref -q HEAD >/dev/null; then
    die "HEAD is detached (an earlier rollback?); run 'git switch main' or pass a ref"
  fi
  log "Pulling the current branch"
  git pull --ff-only
fi
IMAGE_TAG="$(git rev-parse --short=12 HEAD)"
export IMAGE_TAG
log "Deploying commit $IMAGE_TAG (previous checkout: $PREVIOUS)"

# --- Compose invocation ---------------------------------------------------------------------
COMPOSE=(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")
# The worker refuses to start in production without a malware scanner (CLAMAV_HOST), so the
# `scan` profile follows that variable.
if [ -n "$(env_value CLAMAV_HOST)" ]; then
  COMPOSE+=(--profile scan)
fi
PORT="$(env_value CADDY_PORT)"
PORT="${PORT:-8081}"

log "Validating the compose file"
"${COMPOSE[@]}" config --quiet

log "Building images"
"${COMPOSE[@]}" build

# Migrations cannot be rolled back, so keep a dump from just before applying them. Skipped on
# the very first deploy, when there is no database yet.
if "${COMPOSE[@]}" ps --status running --services 2>/dev/null | grep -qx postgres; then
  log "Dumping the database before migrating"
  "${COMPOSE[@]}" run --rm --no-deps backup bash /usr/local/bin/pg-backup.sh once
fi

log "Running migrations"
"${COMPOSE[@]}" run --rm migrate

log "Starting the stack"
"${COMPOSE[@]}" up -d --remove-orphans

# --- Wait for readiness through caddy on the loopback port ------------------------------------
URL="http://127.0.0.1:${PORT}/health/ready"
log "Waiting for $URL"
ready=0
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null --max-time 3 "$URL" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 3
done

"${COMPOSE[@]}" ps
if [ "$ready" -ne 1 ]; then
  echo "deploy: the api did not become ready within 3 minutes; last api log lines:" >&2
  "${COMPOSE[@]}" logs --tail 40 api >&2 || true
  die "deploy of $IMAGE_TAG failed; roll back with: bash infra/scripts/deploy.sh $PREVIOUS"
fi

log "Ready. Deployed $IMAGE_TAG"
echo "Roll back with: bash infra/scripts/deploy.sh $PREVIOUS"
