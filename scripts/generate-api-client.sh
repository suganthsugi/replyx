#!/usr/bin/env bash
# Regenerates the typed API client (apps/web/src/api/generated/) from apps/api/openapi.yaml with orval.
# Runs automatically when backend-agent stops (SubagentStop hook) and in orchestrator step 2.
set -euo pipefail
cd "$(dirname "$0")/.."

SPEC="apps/api/openapi.yaml"
CONFIG="apps/web/orval.config.ts"

if [[ ! -f "$SPEC" ]]; then
  echo "generate-api-client: $SPEC not found yet — nothing to generate."
  exit 0
fi
if [[ ! -f "$CONFIG" ]]; then
  echo "generate-api-client: $CONFIG not found yet — scaffold apps/web with orval first."
  exit 0
fi

echo "generate-api-client: generating client from $SPEC"
pnpm --filter web exec orval --config orval.config.ts
echo "generate-api-client: done"
