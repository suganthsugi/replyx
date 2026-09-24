# syntax=docker/dockerfile:1

# apps/web/Dockerfile
# Multi-stage image for the Vite + React web app (research D24, D26). Build context:
# the repository root.
# - `dev`   target: Node 24 + pnpm (corepack) plus git, no source or dependencies
#           baked in — matches apps/api/Dockerfile's `dev` stage. Under compose.yaml
#           (T011) the repo is bind-mounted at /repo and a one-shot `install` service
#           fills named node_modules volumes.
# - `build` target: produces the static `apps/web/dist` output. It is not served
#           directly from here — `infra/caddy/Dockerfile` (T010) defines its own
#           `web-build` stage that runs the same install/build steps and copies
#           `dist` into the Caddy image, which is what ships as `replyx-web` (T015).
#
#   docker build -f apps/web/Dockerfile --target dev   -t replyx-web-dev   .
#   docker build -f apps/web/Dockerfile --target build -t replyx-web-build .

ARG NODE_IMAGE=node:24-slim

# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ENV COREPACK_HOME=/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_CONFIG_STORE_DIR=/pnpm/store
# Pin pnpm from the root package.json `packageManager` field and warm it into the image.
COPY package.json /tmp/pm/package.json
RUN corepack enable \
 && cd /tmp/pm \
 && corepack install \
 && pnpm --version \
 && rm -rf /tmp/pm
WORKDIR /repo

# ---------------------------------------------------------------------------------------------
FROM base AS dev
ENV NODE_ENV=development
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /repo/apps/web
EXPOSE 5173
CMD ["pnpm", "exec", "vite", "--host"]

# ---------------------------------------------------------------------------------------------
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile --filter web...
RUN pnpm --filter web build
# Output: /repo/apps/web/dist
