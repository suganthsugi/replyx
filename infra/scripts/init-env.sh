#!/usr/bin/env bash
# infra/scripts/init-env.sh -- create infra/.env.prod from infra/.env.prod.example with random
# secrets. Run once on the VM, from anywhere:
#
#   bash infra/scripts/init-env.sh
#
# Refuses to overwrite an existing infra/.env.prod. The file is created with mode 600. Generated
# values are never printed; read them from the file. Optional: OPERATOR_EMAIL=you@example.com
# sets OPERATOR_BOOTSTRAP_EMAIL for the first platform operator.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXAMPLE="$ROOT/infra/.env.prod.example"
TARGET="$ROOT/infra/.env.prod"

command -v openssl >/dev/null 2>&1 || { echo "init-env: openssl is required" >&2; exit 1; }
[ -f "$EXAMPLE" ] || { echo "init-env: $EXAMPLE not found" >&2; exit 1; }
if [ -e "$TARGET" ]; then
  echo "init-env: $TARGET already exists; not overwriting it (delete it yourself to start over)" >&2
  exit 1
fi

umask 077
TMP="$(mktemp "$ROOT/infra/.env.prod.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

alnum24() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-24; }

while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  case "$line" in
    *=__GENERATE_HEX24__) printf '%s=%s\n' "${line%%=*}" "$(openssl rand -hex 24)" ;;
    *=__GENERATE_HEX32__) printf '%s=%s\n' "${line%%=*}" "$(openssl rand -hex 32)" ;;
    *=__GENERATE_ALNUM24__) printf '%s=%s\n' "${line%%=*}" "$(alnum24)" ;;
    OPERATOR_BOOTSTRAP_EMAIL=*)
      printf 'OPERATOR_BOOTSTRAP_EMAIL=%s\n' "${OPERATOR_EMAIL:-${line#*=}}" ;;
    *) printf '%s\n' "$line" ;;
  esac
done < "$EXAMPLE" > "$TMP"

if grep -q '=__GENERATE_' "$TMP"; then
  echo "init-env: an unknown generator marker is left in the example" >&2
  exit 1
fi

chmod 600 "$TMP"
# `ln` fails when the target exists, so a concurrent run cannot overwrite the file either.
ln "$TMP" "$TARGET"

echo "init-env: created infra/.env.prod (mode 600) with generated secrets."
echo "Next: edit SMTP_* in it, then run: bash infra/scripts/deploy.sh"
echo "The first operator signs in at the console host with OPERATOR_BOOTSTRAP_EMAIL and the"
echo "generated OPERATOR_BOOTSTRAP_PASSWORD (both are in infra/.env.prod)."
