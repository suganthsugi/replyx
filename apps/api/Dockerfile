# syntax=docker/dockerfile:1
#
# replyx-api image (research D24, D26). Build context: the repository root.
#
#   dev     - Node 24 + pnpm (corepack). The repo is bind-mounted at /repo and node_modules
#             live in named volumes, so this stage has no source or dependencies baked in.
#             Default command: API in watch mode. Worker: `pnpm --filter api dev:worker`.
#   build   - Installs from the frozen lockfile, compiles the API (dist/) and the migrations,
#             then `pnpm deploy`s the production dependencies of `api` to /out.
#   runtime - Non-root, production dependencies only. One image, three commands:
#               api      node dist/main.api.js   (default)
#               worker   node dist/main.worker.js
#               migrate  node dist/platform-kernel/db/migrator.js
#             Layout: /app/dist (compiled src/), /app/migrations (compiled migrations/),
#             /app/node_modules, /app/package.json. The migrator finds the migrations at
#             ../../../migrations relative to itself, which is apps/api/migrations in dev
#             (tsx) and /app/migrations here.
#
#   docker build -f apps/api/Dockerfile --target runtime -t replyx-api .

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
# git: repo scripts (scripts/test-affected.sh) run from the `tools` service on this stage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
EXPOSE 3000
CMD ["pnpm", "--filter", "api", "dev:api"]

# ---------------------------------------------------------------------------------------------
FROM base AS build
# Download every locked package first so this layer is cached until the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --filter "api..."

WORKDIR /repo/apps/api
# src/ -> dist/ (tsconfig.build.json, rootDir src): dist/main.api.js, dist/main.worker.js, ...
RUN pnpm run build
# migrations/ -> dist-migrations/ with the same compiler settings as the rest of the API.
# Skipped while the folder has no .ts files yet (tsc fails on an empty input set).
RUN mkdir -p dist-migrations \
 && if find migrations -name '*.ts' 2>/dev/null | grep -q .; then \
      printf '%s' '{"extends":"./tsconfig.json","compilerOptions":{"noEmit":false,"rootDir":"migrations","outDir":"dist-migrations"},"include":["migrations/**/*.ts"],"exclude":[]}' \
        > tsconfig.migrations.json \
      && pnpm exec tsc -p tsconfig.migrations.json; \
    fi

WORKDIR /repo
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter api deploy --prod /out

# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Files stay root-owned and read-only to the `node` user the process runs as.
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/dist-migrations ./migrations
# FILES_DIR for local uploads; a fresh named volume mounted here copies this ownership.
RUN mkdir -p /data/files && chown node:node /data/files
USER node
EXPOSE 3000
CMD ["node", "dist/main.api.js"]
