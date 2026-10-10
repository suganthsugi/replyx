---
name: pnpm12-behaviour
description: pnpm 12.5.1 (Rust CLI) facts that affect Dockerfiles and installs; how to check them without pnpm on the host
metadata:
  type: reference
---

The repo pins pnpm@12.5.1, which is newer than training data. To check its behaviour, `npm pack pnpm@12.5.1` into the scratchpad and grep `package/CHANGELOG.md` (checked 2026-09-24):
- `pnpm deploy` no longer needs `injectWorkspacePackages` (no `--legacy`). It copies project files using the `files`/pack filter, so copy `dist/` separately.
- Settings are read from `PNPM_CONFIG_*` env vars. pnpm 10's `npm_config_*` and `onlyBuiltDependencies` are replaced by `allowBuilds` in `pnpm-workspace.yaml`, and builds are denied by default.
- Corepack runs pnpm 12 through `bin/pnpm.mjs`, which fetches the native binary on first use. Warm it with `pnpm --version` in the image. Node 24 images still ship corepack.

**How to apply:** use these when writing Docker/CI install steps. Lint a Dockerfile without building it with `docker build --check -f <file> .`. See [[host-tooling]].
