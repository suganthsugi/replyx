# syntax=docker/dockerfile:1

# apps/web/Dockerfile
# Multi-stage image for the Vite + React web app (research D24, D26).
# - `dev`   target: hot-reloading dev server used by the `web` service in compose.yaml
#           (T011); the repo is bind-mounted over this image at runtime.
# - `build` target: produces the static `apps/web/dist` output. It is not served
#           directly from here — `infra/caddy/Dockerfile` (T010) defines its own
#           `web-build` stage that runs the same install/build steps and copies
#           `dist` into the Caddy image, which is what ships as `replyx-web` (T015).
#
# Build context is the repo root (pnpm workspace), e.g.:
#   docker build -f apps/web/Dockerfile --target dev   -t replyx-web-dev   .
#   docker build -f apps/web/Dockerfile --target build -t replyx-web-build .

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate
WORKDIR /app

# -----------------------------------------------------------------------------
# dev: Vite dev server with HMR, run against the bind-mounted repo (compose.yaml)
# -----------------------------------------------------------------------------
FROM base AS dev
COPY . .
RUN pnpm install --frozen-lockfile --filter web...
WORKDIR /app/apps/web
EXPOSE 5173
CMD ["pnpm", "exec", "vite", "--host"]

# -----------------------------------------------------------------------------
# build: static production build, no dev server or source maps served from here
# -----------------------------------------------------------------------------
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile --filter web...
RUN pnpm --filter web build
# Output: /app/apps/web/dist
