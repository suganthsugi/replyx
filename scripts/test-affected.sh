#!/usr/bin/env bash
# Runs only the tests related to changed files (committed since BASE, plus uncommitted and untracked).
# Usage: scripts/test-affected.sh [BASE]   (default BASE: HEAD, i.e. uncommitted work only)
#   Changes in packages/* (shared code) -> turbo runs `test` in every affected workspace.
#   Changes in apps/api or apps/web      -> `vitest related` on just those files.
set -uo pipefail
cd "$(dirname "$0")/.."

BASE="${1:-HEAD}"
mapfile -t changed < <( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)

if [[ ${#changed[@]} -eq 0 ]]; then
  echo "test-affected: no changed files since $BASE — nothing to test."
  exit 0
fi

status=0
ran=0

if printf '%s\n' "${changed[@]}" | grep -q '^packages/' && [[ -f turbo.json ]]; then
  echo "test-affected: shared packages changed — running turbo for affected workspaces"
  pnpm turbo run test --filter="...[$BASE]" || status=1
  ran=1
fi

for app in api web; do
  [[ -f apps/$app/package.json ]] || continue
  app_files=()
  for f in "${changed[@]}"; do
    [[ "$f" == apps/$app/* && "$f" =~ \.(ts|tsx)$ && "$f" != apps/$app/e2e/* && -f "$f" ]] && app_files+=("${f#apps/$app/}")
  done
  [[ ${#app_files[@]} -eq 0 ]] && continue
  echo "test-affected: apps/$app — tests related to ${#app_files[@]} changed file(s)"
  (cd "apps/$app" && pnpm exec vitest related --run --passWithNoTests "${app_files[@]}") || status=1
  ran=1
done

# Playwright specs are run only when they themselves changed.
e2e=()
for f in "${changed[@]}"; do [[ "$f" == apps/web/e2e/*.spec.ts && -f "$f" ]] && e2e+=("${f#apps/web/}"); done
if [[ ${#e2e[@]} -gt 0 ]]; then
  echo "test-affected: running ${#e2e[@]} changed Playwright spec(s)"
  (cd apps/web && pnpm exec playwright test "${e2e[@]}") || status=1
  ran=1
fi

[[ $ran -eq 0 ]] && echo "test-affected: no testable app changes (apps/api, apps/web) — nothing to run."
exit $status
