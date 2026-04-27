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
RUN pnpm run build
# Prune dev deps so runtime stage carries only what production needs.
RUN pnpm prune --prod

# ---------- runtime stage ----------
FROM node:22-alpine AS runtime
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
