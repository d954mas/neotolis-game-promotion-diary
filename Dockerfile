# syntax=docker/dockerfile:1.7
#
# One image, three roles (D-01, D-15, D-22). The same artifact boots as `app`, `worker`, or
# `scheduler` — selected at runtime by the APP_ROLE env var. SvelteKit's node-adapter
# produces build/server.js which is the single Node entrypoint; the role-dispatch lives
# inside that entrypoint (Plan 01-06 / Plan 01-08 wire it).
#
# Multi-stage:
#   deps    → install pnpm + full deps (incl. devDeps for the build)
#   build   → compile SvelteKit, then `pnpm prune --prod` to strip dev deps
#   runtime → copy build output + production node_modules, run as non-root
#
# Base image: node:22-alpine per D-22 (CONTEXT.md). Distroless was considered and rejected
# for Phase 1 because the alpine base is small enough (~150–200 MB final image) and gives
# us `wget` for HEALTHCHECK without a separate curl install. Revisit if Phase 3 wants sharp
# or another musl-fragile native lib.

# ---------- deps stage ----------
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

# ---------- build stage ----------
FROM deps AS build
COPY . .
# Build-time placeholder env vars so src/lib/server/config/env.ts Zod
# parse succeeds during `pnpm run build` (svelte-kit sync + vite build
# import server modules at analyse time). These ARE NOT secrets — they
# stay in the build stage only; the runtime stage starts fresh from
# node:22-alpine so no build-time ENV propagates to the final image.
# A real deploy injects real env via docker run -e / compose service env.
ENV DATABASE_URL=postgres://placeholder:placeholder@localhost:5432/placeholder \
    BETTER_AUTH_URL=http://localhost:3000 \
    BETTER_AUTH_SECRET=docker-build-placeholder-secret-32-chars-min-len \
    OAUTH_CLIENT_ID=docker-build-placeholder-client-id \
    OAUTH_CLIENT_SECRET=docker-build-placeholder-client-secret \
    OAUTH_DISCOVERY_URL=http://localhost:9090/.well-known/openid-configuration \
    APP_KEK_BASE64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=
RUN pnpm run build
# Prune dev deps so runtime stage carries only what production needs.
RUN pnpm prune --prod

# ---------- runtime stage ----------
FROM node:22-alpine AS runtime
# OCI image labels (D-21 / Plan 02.2-06). These tie the GHCR image to the
# source repo so a self-host operator can `docker inspect` and trace back
# to the code. No runtime effect.
LABEL org.opencontainers.image.source="https://github.com/d954mas/neotolis-diary"
LABEL org.opencontainers.image.licenses="MIT"
WORKDIR /app
# Non-root user (D-22). UID 10001 is well above the alpine reserved range (<1000) and the
# typical container UID grab-bag (1000–9999) so it doesn't collide with host bind-mounts.
RUN addgroup -S app -g 10001 && adduser -S app -G app -u 10001
ENV NODE_ENV=production
COPY --from=build --chown=app:app /app/build ./build
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --from=build --chown=app:app /app/drizzle ./drizzle
USER app
EXPOSE 3000
# Healthcheck binds to /readyz (D-21). Cloudflare Tunnel polls /healthz separately to avoid
# restart loops during slow startup; the container's own healthcheck is the stricter readyz
# so docker-compose dependents wait for migrations + DB before being marked healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --quiet --spider http://localhost:3000/readyz || exit 1
# APP_ROLE dispatch lives inside build/server.js (Plan 01-06 / Plan 01-08).
# Plan 01-06 lands the actual file; this Dockerfile is structurally correct today.
ENTRYPOINT ["node", "build/server.js"]
