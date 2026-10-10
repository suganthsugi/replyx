---
name: web-test-parallel-flakiness
description: apps/web tests can fail under test-affected.sh's default 40+ isolated workers but pass sequentially; verify before assuming a real regression
metadata:
  type: project
---

`scripts/test-affected.sh` runs `apps/web` specs with vitest's default per-file worker isolation
(seen: "43 workers spawned"), and under that load some already-slow specs (dialog/transition-heavy
RTL tests, lazy route-area loads) intermittently time out or lose the race on `findByRole`, even
with no relevant code changed.

**Why:** confirmed on T183/T184 (tenant settings) — `test-affected.sh` reported
`test/desk/NewTicketDialog.test.tsx` and `test/routes/areas.test.tsx` failing (a
`findByRole` timeout and two elements never appearing) after only [[cross-module-service-export|apps/api changes plus a client regen]] with
brand-new, unrelated files. Re-running just those two files with
`pnpm exec vitest run --no-file-parallelism <files>` inside the same `tools` container passed
18/18. A `git stash` of the touched generated-client files and rerun also passed, ruling out the
change itself.

**How to apply:** if `test-affected.sh` fails only in `apps/web` and the failing specs are unrelated
to the files you touched (especially dialog/transition or lazy-route tests), rerun just those files
with `--no-file-parallelism` before reporting a regression. If they pass, note it as pre-existing
flakiness, not caused by the change, rather than trying to fix unrelated web tests (out of
backend-agent's owned paths anyway).
