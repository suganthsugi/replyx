#!/usr/bin/env bash
# Coverage gate: fails if line coverage is below the threshold.
# Backend (apps/api) >= 80%, frontend (apps/web) >= 70%. Override with API_MIN / WEB_MIN.
# Exits 0 with a notice for any app that has no tests yet.
set -uo pipefail
cd "$(dirname "$0")/.."

API_MIN="${API_MIN:-80}"
WEB_MIN="${WEB_MIN:-70}"
status=0
checked=0

has_tests() {
  find "$1" -path '*/node_modules' -prune -o -path "$1/e2e" -prune -o \
    -type f \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.spec.ts' -o -name '*.spec.tsx' \) -print -quit 2>/dev/null | grep -q .
}

check() {
  local app="$1" min="$2"
  if [[ ! -f "apps/$app/package.json" ]] || ! has_tests "apps/$app"; then
    echo "check-coverage: apps/$app has no tests yet — skipping (threshold ${min}%)."
    return
  fi
  checked=1
  echo "check-coverage: apps/$app — requiring ${min}% line coverage"
  if ! (cd "apps/$app" && pnpm exec vitest run --coverage --coverage.thresholds.lines="$min"); then
    echo "check-coverage: apps/$app FAILED (below ${min}% or tests failing)" >&2
    status=1
  fi
}

check api "$API_MIN"
check web "$WEB_MIN"

[[ $checked -eq 0 ]] && echo "check-coverage: no tests exist yet — gate passes by default."
exit $status
