---
name: pnpm12-policies
description: pnpm 12.5.1 gotchas in this repo - minimumReleaseAge auto-edits pnpm-workspace.yaml, unlisted build scripts fail installs; Docker recipe for lockfile work
metadata:
  type: project
---

pnpm 12 enforces a ~24h `minimumReleaseAge`. If a range's floor is a version published within the last day (for example `astro ^7.3.5` on 2026-09-24), `pnpm install --lockfile-only` silently appends `minimumReleaseAgeExclude` to `pnpm-workspace.yaml`. If a stale lockfile already pins such a version, the install fails with ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION.

Any dependency build script that isn't listed under `allowBuilds` in `pnpm-workspace.yaml` makes the install fail with ERR_PNPM_IGNORED_BUILDS. As of 2026-09-24 the list is: true for @swc/core, argon2, esbuild and msgpackr-extract; false for @scarf/scarf, cpu-features, msw, protobufjs, ssh2 and unrs-resolver.

**Why:** hit both of these while regenerating the lockfile on 2026-09-24.

**How to apply:** set range floors to versions at least a day old, and `git diff pnpm-workspace.yaml` after every install. When you add a native dependency, add it to `allowBuilds`. Don't run a real install on the host bind mount. Mount the repo read-only at /src, `tar` it (without node_modules, .git, .next, .claude) into /app, and run `pnpm install --frozen-lockfile` there. See [[host-tooling]] and [[pnpm12-behaviour]].
