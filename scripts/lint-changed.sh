#!/usr/bin/env bash
# Lints only the changed TS/TSX files in apps/api and apps/web. Must stay fast.
# As a PostToolUse hook it reads the hook JSON on stdin and lints the edited file.
# Run manually, it lints all uncommitted changes under apps/.
# Exit 2 sends the lint output back to the agent.
set -uo pipefail
cd "$(dirname "$0")/.."

files=()
if [[ ! -t 0 ]]; then
  payload="$(cat)"
  if [[ -n "$payload" ]]; then
    f="$(printf '%s' "$payload" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write((j.tool_input&&j.tool_input.file_path)||"")}catch{}})' 2>/dev/null || true)"
    if [[ -n "$f" ]]; then
      f="${f//\\//}"                                  # Windows backslashes -> slashes
      root="$(pwd -W 2>/dev/null || pwd)"; root="${root//\\//}"
      f="${f#"$root"/}"                               # make repo-relative
      files+=("$f")
    fi
  fi
fi
if [[ ${#files[@]} -eq 0 ]]; then
  mapfile -t files < <( { git diff --name-only HEAD; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
fi

status=0
for app in api web; do
  app_files=()
  for f in "${files[@]}"; do
    [[ "$f" == apps/$app/* && "$f" =~ \.(ts|tsx)$ && "$f" != */generated/* && -f "$f" ]] && app_files+=("${f#apps/$app/}")
  done
  [[ ${#app_files[@]} -eq 0 ]] && continue
  if ! ls apps/$app/eslint.config.* >/dev/null 2>&1; then
    echo "lint-changed: apps/$app has no eslint config yet — skipping." >&2
    continue
  fi
  out="$(cd "apps/$app" && pnpm exec eslint --no-warn-ignored "${app_files[@]}" 2>&1)" || { echo "$out" >&2; status=2; }
done

if [[ ${#files[@]} -eq 0 ]]; then
  echo "lint-changed: no changed files — nothing to lint."
fi
exit $status
