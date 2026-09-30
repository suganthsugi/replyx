#!/usr/bin/env bash
# infra/scripts/pg-backup.sh -- logical PostgreSQL backups for the `backup` service of
# infra/compose.prod.yml (runs inside the postgres:17 image, which provides pg_dump).
#
#   pg-backup.sh loop   sleep until BACKUP_HOUR_UTC every day, then dump (the service command)
#   pg-backup.sh once   dump now and exit (deploy.sh runs this before applying migrations)
#
# Environment: PGHOST, PGUSER, PGPASSWORD, PGDATABASE (libpq), BACKUP_DIR (default /backups),
# BACKUP_KEEP (default 14), BACKUP_HOUR_UTC (default 3).
#
# The dump runs as the `postgres` superuser on purpose: every tenant table uses FORCE ROW LEVEL
# SECURITY, so any role without BYPASSRLS (including replyx_owner) would dump zero rows.
#
# Restore into an empty replyx database (roles come from infra/postgres/init.sql on a fresh
# volume): pg_restore -h postgres -U postgres -d replyx --clean --if-exists <file>.dump
#
# This keeps dumps on the same VM. Off-VM copies (pgBackRest/restic, T203) are deferred.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
BACKUP_HOUR_UTC="${BACKUP_HOUR_UTC:-3}"

log() { printf '%s backup: %s\n' "$(date -u +%FT%TZ)" "$*"; }

dump_once() {
  local stamp file
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  file="${BACKUP_DIR}/replyx-${stamp}.dump"
  # Write to a temp name first so a half-written dump is never counted or restored.
  if pg_dump --format=custom --no-password --file="${file}.partial"; then
    mv "${file}.partial" "$file"
    log "wrote $(basename "$file") ($(du -h "$file" | cut -f1))"
  else
    rm -f "${file}.partial"
    log "pg_dump failed"
    return 1
  fi
  # Keep the newest BACKUP_KEEP dumps.
  # shellcheck disable=SC2012  # names are generated above, never user input
  ls -1t "${BACKUP_DIR}"/replyx-*.dump 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))" | while read -r old; do
    rm -f -- "$old"
    log "pruned $(basename "$old")"
  done
}

seconds_until_next_run() {
  local now target
  now="$(date -u +%s)"
  target="$(date -u -d "today ${BACKUP_HOUR_UTC}:00:00" +%s)"
  if [ "$target" -le "$now" ]; then target=$((target + 86400)); fi
  echo $((target - now))
}

mkdir -p "$BACKUP_DIR"

case "${1:-loop}" in
  once)
    dump_once
    ;;
  loop)
    log "scheduled daily at ${BACKUP_HOUR_UTC}:00 UTC, keeping ${BACKUP_KEEP} dumps"
    while true; do
      sleep "$(seconds_until_next_run)"
      # A failed dump is logged and retried the next day; it must not stop the loop.
      dump_once || true
    done
    ;;
  *)
    echo "usage: pg-backup.sh loop|once" >&2
    exit 2
    ;;
esac
