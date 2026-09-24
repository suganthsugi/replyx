# syntax=docker/dockerfile:1

# infra/caddy/Dockerfile
# Builds the `replyx-web` image: Caddy (automatic HTTPS, research D24) serving the
# web app's static build output as a single deployable unit.
#
# The `web-build` stage below runs the same install/build steps as the `build`
# target of `apps/web/Dockerfile` (keep the two in sync manually). It is defined
# here, rather than referenced across files, because a plain `docker build` cannot
# `COPY --from` a stage of a *different* Dockerfile — only BuildKit named build
# contexts or `docker buildx bake` can bridge files, and neither is otherwise used
# in this repo. Duplicating the few install/build lines keeps this file
# self-contained for T015's release workflow, which builds
# `ghcr.io/<owner>/replyx-web:<sha>` straight from this Dockerfile.
#
# Build context is the repo root, e.g.:
#   docker build -f infra/caddy/Dockerfile -t replyx-web .
#
# The Caddyfile (site config, copied into this image below `/etc/caddy/`) is added
# in T201; until then this image serves static files with Caddy's default config.

FROM node:24-slim AS web-build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter web...
RUN pnpm --filter web build

FROM caddy:2
COPY --from=web-build /app/apps/web/dist /srv
