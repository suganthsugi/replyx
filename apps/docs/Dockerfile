# syntax=docker/dockerfile:1

# apps/docs/Dockerfile
# Builds the `replyx-docs` image: the Fumadocs site exported as static files (`next build` with
# `output: 'export'`) and served by Caddy. TLS is not terminated here: the host nginx owns 443 for
# replyx.example.com and proxies plain HTTP to this container, which compose publishes only on
# 127.0.0.1 (infra/compose.prod.yml, infra/nginx/replyx.conf).
#
# Build context is the repo root:
#   docker build -f apps/docs/Dockerfile -t replyx-docs .

FROM node:24-slim AS docs-build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter docs...
RUN pnpm --filter docs build
# Output: /app/apps/docs/out

FROM caddy:2
COPY apps/docs/Caddyfile /etc/caddy/Caddyfile
COPY --from=docs-build /app/apps/docs/out /srv
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1
