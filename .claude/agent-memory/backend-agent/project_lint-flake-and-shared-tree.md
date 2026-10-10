---
name: lint-flake-and-shared-tree
description: eslint in the tools container can die with ENODATA (rerun it); web lint/typecheck can be red from other agents' concurrent files
metadata:
  type: project
---

`docker compose run --rm -T tools pnpm --filter api lint` once failed with `ENODATA: no data available, read` from eslint's `readAndVerifyFile` (bind-mount read of a file another agent was writing). Re-running alone passed clean.

When several agents share the working tree, `pnpm --filter web lint|typecheck` may fail in files you never touched (seen 2026-09-30: `apps/web/e2e/main-flow.spec.ts` no-unsafe-finally, `src/pages/admin/settings/BrandPreview.tsx` TS2362). Confirm with `git diff --stat` that the files are not yours, report them, and don't fix them.

**How to apply:** rerun a flaky lint once before treating it as real; in the handback list unrelated red files separately. Avoid `cat <<'EOF'` heredocs containing quotes plus `node -e` with nested backticks in the Bash tool (they mangled text on 2026-09-30); use the Write/Edit tools for multi-line content.
