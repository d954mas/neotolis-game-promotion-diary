# Phase 1: Foundation - Research

**Researched:** 2026-04-27
**Domain:** Multi-tenant indie SaaS foundation — bootable Docker image (one image, three roles), Google OAuth via Better Auth + Drizzle, AES-256-GCM envelope encryption, tenant-scope middleware (404 not 403), Paraglide JS 2 i18n scaffold, self-host CI smoke test gate.
**Confidence:** HIGH for the architecture, locked stack, and the eight area-specific recipes below. MEDIUM for two areas where the locked-stack version drift since CLAUDE.md was authored requires planner judgement (`@hono/node-server` 1.x → 2.0.0 published 2026-04-21; `pg-boss` major drift from 10.x to 12.x).

## Summary

Phase 1 lays five non-retroactive foundations: the **three-role single image** (Hono+SvelteKit `app`, pg-boss `worker`, pg-boss `scheduler` — all selected by `APP_ROLE` env), **Google OAuth via Better Auth 1.6.x with Drizzle adapter + database-backed sessions**, **AES-256-GCM envelope encryption** (KEK from env, DEK per row, `kek_version` column from day one), **tenant-scope middleware that returns 404 not 403** on cross-tenant access, and the **self-host CI smoke test that boots the real image** with mocked OAuth and asserts every parity invariant. Trusted-proxy header handling lands here too because the audit log records IP from day one (D-19 in CONTEXT.md) and a stub would record proxy IPs forever.

Critical version-drift findings since the stack was researched: `@hono/node-server@2.0.0` was published 2026-04-21 (six days ago) — pin to `1.19.14` (last 1.x stable) for Phase 1, revisit at Phase 2. `pg-boss` major version is 12.x, not 10.x; the locked CLAUDE.md value of 10.x is two majors stale. CVE-2026-27700 hit Hono's `getConnInfo` for IP spoofing on AWS Lambda ALB — confirms the project's D-19/D-20 decision to roll our own trusted-proxy middleware rather than depend on `getConnInfo`. Better Auth's CLI is `@better-auth/cli` (not `auth@latest` as some older docs say), and it generates Drizzle TypeScript schema (not raw SQL); migrations are then generated/applied with `drizzle-kit`.

**Primary recommendation:** Adopt the eight code-shape sketches below verbatim as the planner's reference patterns; pin versions per the verified table; use `migrate()` from `drizzle-orm/node-postgres/migrator` programmatically at boot (not the `drizzle-kit migrate` CLI); use `Better Auth's` Google provider in production and a fresh `oauth2-mock-server` instance in CI as the dev OAuth IdP; treat the self-host smoke test as the mandatory gate that ships in Phase 1 and locks parity for every later phase.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Repo & Tooling**
- D-01 — Flat single package. One `package.json` at the repo root. SvelteKit lives at `src/routes/` (handles UI + server endpoints via `+page.server.ts` / `hooks.server.ts`). Worker entrypoint is `src/worker/index.ts` and scheduler is `src/scheduler/index.ts`. They share `src/lib/` (db, encryption, schema, services). One `Dockerfile` produces one image whose `ENTRYPOINT` dispatches on `APP_ROLE`. Reason: solo-friendly, matches the "one image → three roles" architecture, no workspace boilerplate.
- D-02 — pnpm. Strict dep resolution (no phantom deps), workspace-friendly even at flat layout, faster CI.
- D-03 — ESLint + Prettier (not Biome). Better `.svelte` coverage via `eslint-plugin-svelte` and `svelte-check`. Slower than Biome but the SvelteKit ecosystem assumes ESLint and the user wants thorough coverage of `.svelte` files.
- D-04 — Vitest. Standard in the SvelteKit/Vite world, watch mode, mocking out of the box. Playwright deferred to a later phase if true e2e is needed.

**Better Auth & User Model**
- D-05 — Database-backed sessions, not JWE cookies. A row in a `sessions` table per login; the cookie carries only `session_id`. Server can invalidate instantly (logout, "sign out from all devices", security incident). Required for the audit log to be honest about active sessions.
- D-06 — UUID v7 for every primary key. `users.id`, `sessions.id`, `audit_logs.id`, and every Phase-2+ table. Time-sortable, enumeration-safe, self-host export friendly. Use `pg` extension or app-side generation; pick during planning based on Drizzle support.
- D-07 — Minimum user record on first sign-in. `users { id, email, name, image_url, google_sub, created_at, updated_at }` only. No empty-`settings` row. Phase 2 owns user-scoped settings.
- D-08 — "Sign out from all devices" ships in Phase 1. Settings button deletes all `sessions` rows for the current `user_id`. Free security win once DB sessions exist; defers nothing.

**Envelope Encryption**
- D-09 — Random DEK per row + KEK-wrapped. `crypto.randomBytes(32)` per secret. AES-256-GCM (12-byte nonce + 16-byte tag) for both DEK→plaintext and KEK→DEK. Both `wrapped_dek` (with own nonce/tag) and `ciphertext` (with own nonce/tag) stored on the secret row. Rotation re-wraps DEKs only — never touches ciphertext payloads.
- D-10 — `kek_version` column on every encrypted row. Server reads `KEK_V1`, `KEK_V2`, … from env; column tells server which KEK to use for unwrap. Rotation procedure: load `KEK_V2`, background job iterates `kek_version=1` rows and re-wraps DEK to `kek_version=2`, then `KEK_V1` env is dropped.
- D-11 — Encryption scope: user-supplied API keys + OAuth refresh tokens (Phase 2). Phase 1 builds and unit-tests the module; the `secrets` table itself arrives in Phase 2. Not encrypted: PII (email, name).
- D-12 — Audit on add / rotate / remove only. Per-decryption logging would produce 100k+ rows/day with no incident-response value. Phase 1 wires up the audit framework so Phase 2 has a ready writer.

**Self-Host CI Gate**
- D-13 — Better Auth test mode for OAuth in CI. Use Better Auth's built-in dev / test provider configured via env flag. No external mock OIDC server. (See research § "Better Auth + OAuth in CI" — note: Better Auth does NOT ship a dedicated dev/test provider; planner must reconcile this — recommended approach is `oauth2-mock-server` from axa-group, which preserves the spirit of D-13 with minimal CI moving parts.)
- D-14 — SaaS-leak detection: grep + runtime checks. (1) CI grep for hardcoded admin emails, telemetry beacon URLs, Cloudflare-only headers without graceful fallback. (2) Smoke test boots image with minimal env (no `CF_*`, no `ANALYTICS_*`) and asserts startup succeeds.
- D-15 — Smoke test asserts: (1) `docker run -e APP_ROLE=app …` boots, `/healthz` 200, `/readyz` 200; (2) `APP_ROLE=worker` boots, prints "worker ready"; (3) `APP_ROLE=scheduler` boots, prints "scheduler ready"; (4) Sign in via Better Auth test mode as user A → land on dashboard; (5) Cross-tenant test: user A's resource as user B → 404; (6) Anonymous → 401 on every protected route.
- D-16 — Postgres in CI: GitHub Actions service container `postgres:16-alpine`. Fresh DB per run, no docker-in-docker. `DATABASE_URL` injected via env.

**i18n**
- D-17 — Paraglide compiled messages, no locale detection in MVP. All UI strings flow through `m.welcome()`-style imports compiled from `messages/en.json`. Server renders English unconditionally. No URL-prefix routing, no `Accept-Language`, no cookie. Adding `ru.json` later is content-only.
- D-18 — Single `messages/en.json` at repo root. Not split by feature in Phase 1.

**Trusted-Proxy & Audit IP**
- D-19 — Trusted-proxy header handling lands in Phase 1. Audit log writes IP from Phase 1; a stub `req.ip` would record proxy IP forever and rewriting old rows is messy. DEPLOY-02 in Phase 6 only formalizes documentation.
- D-20 — `TRUSTED_PROXY_CIDR` env (CIDR list). Comma-separated CIDR list (default empty = trust nothing, real IP = direct socket peer). Middleware walks `X-Forwarded-For` from the right, dropping entries whose source matches a trusted CIDR; first untrusted-source entry is the real client IP. Same mechanism for `CF-Connecting-IP`. SaaS default: Cloudflare ranges + Docker network; self-host bare: empty; self-host behind nginx/Caddy: `127.0.0.1/32` + loopback.

**Health, Docker, Logs**
- D-21 — `/healthz` + `/readyz` separate. `/healthz` always 200 once process is up (liveness). `/readyz` 200 only when DB connection works AND migrations are at the latest. Docker healthcheck uses `/readyz`. Cloudflare Tunnel polls `/healthz` to avoid restart loops.
- D-22 — `node:22-alpine` base, multi-stage build. Stages: `deps` → `build` → `runtime`. Non-root user. Target image size ~150–200 MB. Alpine chosen over `bookworm-slim` because no native-deps requirement is anticipated for Phase 1/2.
- D-23 — Pino, stdout JSON in prod, pretty in dev. `LOG_LEVEL` env (`debug|info|warn|error`, default `info` prod, `debug` dev). `pino-pretty` only in dev (`NODE_ENV=development`). All logs to stdout — Docker / Loki picks up.
- D-24 — Pino redaction paths: `['*.password','*.api_key','*.apiKey','*.access_token','*.accessToken','*.refresh_token','*.refreshToken','*.secret','*.encrypted_*','*.wrapped_dek','*.dek','req.headers.authorization','req.headers.cookie']`. Plus a CI grep / lint rule banning direct `process.env.*` access outside `src/lib/config/`.

### Claude's Discretion

The following are intentionally not locked — planner picks during plan-phase:
- Drizzle config: `drizzle-kit generate` vs `push` (planner picks based on migration story).
- pg pool size and shared-pool strategy with pg-boss (research/STACK.md flagged this; planner tunes).
- Specific `eslint-config-*` package choices and Prettier formatting rules (use community defaults; the user did not express preferences).
- pino-pretty vs pino-trans-stdio configuration knobs; whether to wire transport in worker process.
- Test fixture / factory shape (planner can pick `@faker-js/faker` or hand-rolled).
- Exact non-root user UID inside the image (any unprivileged UID).
- CI provider — assume GitHub Actions unless plan-phase finds reason otherwise.
- `/healthz` / `/readyz` exact response payload format (string "ok" vs JSON envelope — planner picks).

### Deferred Ideas (OUT OF SCOPE)

- Cloudflare Tunnel-specific deploy guide — Phase 6 (DEPLOY docs).
- THIRD_PARTY_LICENSES.md and AGPL CI gate — Phase 6 (PITFALL P14).
- KEK rotation runbook + rehearsal — Phase 6 (PITFALL P20). The mechanism (kek_version, re-wrap job) is built in Phase 1, but the procedure document, the rehearsal, and the operator drill are Phase 6.
- Backups, monitoring, alerting — Phase 6 polish.
- Per-user TOTP / 2FA — already excluded in PROJECT.md; not revived.
- Multi-language UI — i18n structure ready in Phase 1 but additional locales are post-MVP content additions.
- Account deletion flow — Phase 6 (PRIV-04).
- Service-side rate limiting — out of scope for Phase 1; rely on Cloudflare Free WAF.
- Health/ready endpoint authn — `/healthz` and `/readyz` are unauthenticated by design (PRIV-01 explicitly excludes them from "every endpoint refuses anonymous"). Document this exception in plan-phase.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| AUTH-01 | User can sign in to the service with Google OAuth as the only supported login method | § Better Auth integration (Area 2) — Google provider config, redirect URIs per deploy mode |
| AUTH-02 | User can sign out from any page; session is invalidated server-side | § Better Auth integration (Area 2) — D-05 database-backed sessions; D-08 sign-out-all-devices |
| AUTH-03 | First sign-in auto-creates account; existing accounts resume on later sign-ins | § Better Auth integration (Area 2) — Better Auth's `account` table handles `google_sub` linkage; D-07 minimum user record |
| PRIV-01 | All data is private to the user_id; no public dashboard, share link, or read-only viewer in v1 | § Tenant-scope middleware (Area 3) — 404-not-403 pattern; § Cross-tenant integration test (Area 8); PITFALL P18 (privacy creep) |
| UX-04 | All user-facing copy in English; codebase carries i18n structure (locale-aware key lookups) | § Paraglide JS 2 + SvelteKit 2 wiring (Area 7) — D-17/D-18 |
| DEPLOY-05 | CI runs a self-host smoke test on every change — boots image, signs in via OAuth mock, creates a game, runs a poll, asserts no SaaS-only assumptions leak | § Self-host CI smoke test (Area 5) — D-13/D-14/D-15/D-16; PITFALL P13 (parity rot) |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

CLAUDE.md is the authoritative stack lock; the following directives flow into every Phase 1 plan as non-negotiables:

- **Auth surface is Google OAuth only** — no email/password, no GitHub. Reduces auth attack surface.
- **Privacy: private-by-default.** No public dashboards in MVP. All data scoped to `user_id`.
- **Security — at-rest secrets:** API keys envelope-encrypted (KEK from env, DEK per row), write-once in UI (last 4 chars only), never logged, never returned in API responses.
- **Security — transport:** TLS 1.3 + HSTS via Cloudflare in SaaS. No raw HTTP in production.
- **Indie/zero-budget:** every infra component must work on free tier. No paid SaaS dependency in critical path.
- **License: MIT.** AGPL components (Loki, Grafana) only as separate optional services, never embedded.
- **Open-source compatibility:** runs identically in SaaS multi-tenant and self-host single-tenant. Trusted-proxy headers honored so the service works behind any of: bare port, nginx, Caddy, Cloudflare Tunnel.
- **GSD Workflow Enforcement:** before file-changing tools, work goes through a GSD command. No direct repo edits outside a GSD workflow without explicit user override.
- **Locked stack (Phase 1 in scope):** Node 22 LTS, TypeScript 5.6+, Hono 4.12.x, `@hono/node-server` 1.19.x, PostgreSQL 16.x, Drizzle ORM 0.45.x, `pg` 8.13+, pg-boss 10.x, SvelteKit 2.58+ (Svelte 5), Better Auth 1.6.x, `@better-auth/drizzle-adapter` matched, Pino 9.x, zod 3.23+, `@hono/zod-validator` 0.4+, `rate-limiter-flexible` 5.x (memory backend in Phase 1), Paraglide JS 2.x, Vitest 4.x. **Two version-drift findings flagged below for planner reconciliation.**

## Standard Stack

### Core (Phase 1 surface)

| Library | Version (locked / verified) | Purpose | Why Standard |
|---------|-----------------------------|---------|--------------|
| **Node.js** | 22 LTS (≥22.11) | Runtime | LTS until April 2027; native `fetch`, `WebCrypto`, stable ESM; pg-boss v10 minimum is Node 20, v12 is Node 22+. |
| **TypeScript** | 5.6+ | Language | Required for Drizzle's inferred types and Better Auth's typed config. Strict mode catches the multi-tenant `user_id` mistakes that destroy SaaS. |
| **Hono** | 4.12.15 (verified `npm view hono version`) | Backend HTTP framework | Web-standards Request/Response, ~14 KB. CVE-2026-27700 (IP spoof in Lambda ALB) fixed in 4.12.2+ — current is well past. |
| **@hono/node-server** | **1.19.14 (recommend; not 2.0.0 — see drift note below)** | Node adapter for Hono | Last 1.x is 1.19.14 (2026-04-13). 2.0.0 was published 2026-04-21, six days before this research. Untested at production scale. |
| **PostgreSQL** | 16.x | Database | Postgres 16 is the current production target; `SKIP LOCKED`, partitioning, JSONB. |
| **Drizzle ORM** | 0.45.2 (verified) | ORM + query builder | TypeScript-first, schema-as-code, generates readable SQL migrations. Pin to 0.45 for MVP per CLAUDE.md (1.0 still beta). |
| **drizzle-kit** | matched to drizzle-orm | Migration generation/application | `drizzle-kit generate` for SQL, `drizzle-kit check` for branch-merge commutativity. |
| **pg (node-postgres)** | 8.20.0 (verified; ≥8.13 required) | Postgres driver | Used under the hood by both Drizzle and pg-boss. One driver across ORM and queue. |
| **pg-boss** | **10.x (locked) — but current is 12.18.1** (see drift note below) | Job queue + scheduler | Phase 1 only declares queues + writes the role-dispatcher; Phase 3 actually uses workers. Drift is recoverable but planner must decide. |
| **SvelteKit** | 2.58.0 (verified) | Frontend full-stack | Svelte 5 runes (`$state`, `$derived`) stable; SvelteKit 2 supports them. |
| **Svelte** | 5.55.5 (verified) | UI runtime | Svelte 5 with runes. |
| **Better Auth** | 1.6.9 (verified `npm view better-auth version`) | Authentication | Lucia v3 deprecated 2025-03; Better Auth is the de-facto SvelteKit successor in 2026. Native Google OAuth, Drizzle adapter, server-only session cookies. |
| **`@better-auth/cli`** | matched | Schema generation tool | Generates Drizzle TypeScript schema for Better Auth tables. **Note:** older docs reference `npx auth@latest generate` — current is `npx @better-auth/cli@latest generate`. |
| **Pino** | **9.x (locked) — current is 10.3.1** (minor drift; Phase 1 uses 9.x for config compatibility) | Structured logging | Fastest Node logger; redaction config is critical for D-24. |
| **zod** | 3.23+ | Runtime validation | Validate inbound bodies, env config, and (Phase 2+) external API responses. |
| **`@hono/zod-validator`** | 0.4+ | Hono request validation | Adapter that ties zod schemas into Hono routes with type inference. |
| **rate-limiter-flexible** | 5.x | Rate limiting | Tier-aware rate limits. Phase 1 uses `RateLimiterMemory`; Phase 6 / SaaS scale-out switches to `RateLimiterPostgres`. |
| **Paraglide JS** | 2.16.1 (verified `@inlang/paraglide-js`) | i18n compiler | Officially recommended by Svelte for SvelteKit. Compile-time tree-shaken messages. |
| **dotenv** | 16.x | Env loading (dev only) | Production reads from real env (Docker / systemd). |

### Drift findings the planner MUST reconcile

| Lib | CLAUDE.md locked | npm registry today | Phase 1 recommended action |
|-----|-------------------|---------------------|----------------------------|
| `@hono/node-server` | 1.19.x | 2.0.0 (2026-04-21) — 6 days old | Pin **1.19.14** for Phase 1 (last 1.x). Re-evaluate 2.0.0 at Phase 2 once it has burn-in. |
| `pg-boss` | 10.x | 12.18.1 | **Flag for the user.** Phase 1 only *declares queues and the worker/scheduler entrypoints* (no live polling), but the API surface for `boss.stop()`, `createQueue()`, `work()` differs. Recommend the planner write Phase 1 plan against pg-boss 10.x as locked but raise an explicit "lock review" task at Phase 3 start before workers are wired. |
| `pino` | 9.x | 10.3.1 | Minor drift, no breaking change for our use. Pin 9.x as locked. |
| Local dev env | Node 22 LTS required | Local machine has Node 20.15.0 | Docker images (alpine-22) are correct; local dev runs Node 20 fine for SvelteKit + Vitest. Document `.nvmrc` with `22` as the project requirement. |

### Encryption (envelope: KEK in env, DEK per row)

| Library | Version | Purpose | Confidence |
|---------|---------|---------|------------|
| **Node.js `node:crypto`** (built-in) | runtime | AES-256-GCM for both KEK→DEK wrap and DEK→plaintext encrypt | HIGH |

No third-party crypto library. Per CLAUDE.md "What NOT to Use": `crypto-js` is unauthenticated and slow; `bcrypt`/`argon2` are wrong primitives (passwords, not encryption). Per ARCHITECTURE.md anti-pattern AP-6: `app` does NOT keep the KEK as a module-level constant — it loads on the secret-write path only and discards.

### Development Tools

| Tool | Version | Purpose |
|------|---------|---------|
| **Vitest** | 4.1.5 (verified) | Unit + integration tests; native ESM, Vite-shared config |
| **`@vitest/coverage-v8`** | matched | Coverage reporter for the cross-tenant matrix |
| **tsx** | 4.x | Dev TypeScript runner; one-off scripts (e.g. KEK rotation) |
| **Docker** | 26.x (verified `docker --version`) | Container build (multi-stage) + compose for self-host |
| **pnpm** | 9.x | Package manager (D-02). Not yet installed locally — `npm install -g pnpm` step needed. |

### Installation (Phase 1 surface, recommended pin set)

```bash
# Core runtime + framework
pnpm add hono@4.12.15 @hono/node-server@1.19.14 @hono/zod-validator@0.4
# Database
pnpm add drizzle-orm@0.45.2 pg@8.20
pnpm add -D drizzle-kit@latest @types/pg
# Job queue (Phase 1 = role-dispatcher only; pg-boss declared but not yet driving workers)
pnpm add pg-boss@10
# Auth
pnpm add better-auth@1.6.9
pnpm add -D @better-auth/cli
# Logging + ops
pnpm add pino@9 pino-pretty@11
# Validation
pnpm add zod@3.23
# i18n
pnpm add @inlang/paraglide-js@2.16.1
# Frontend (SvelteKit; same package.json per D-01)
pnpm add @sveltejs/kit@2.58 svelte@5 vite@5 @sveltejs/adapter-node@5
# Dev / test
pnpm add -D vitest@4 @vitest/coverage-v8 typescript@5.6 tsx@4 @types/node@22
pnpm add -D eslint@9 eslint-plugin-svelte@2 prettier@3 svelte-check@4
# Self-host CI smoke test (CI-only)
pnpm add -D oauth2-mock-server@7  # for D-13 OAuth mock
```

### Alternatives Considered (and rejected)

| Instead of | Could Use | Why we rejected for Phase 1 |
|------------|-----------|------------------------------|
| Better Auth 1.6 | Lucia v3 | **Deprecated 2025-03** — repository is a learning resource. |
| Better Auth 1.6 | Auth.js (NextAuth) | Framework-shaped around Next; weaker SvelteKit + Drizzle story. |
| Better Auth 1.6 | Roll-your-own session cookies + `googleapis` OAuth | Tempting but session rotation, CSRF, account-linking are real work. Better Auth bundles these. |
| Drizzle 0.45 | Prisma 7 | Heavier dev loop; Drizzle generates readable SQL migrations. |
| pg-boss | BullMQ | Requires Redis; kills "Postgres-only single-VPS" story. |
| pg-boss | graphile-worker | Smaller community; fewer cron / DLQ primitives out of the box. |
| Postgres RLS as primary tenant scope | Convention + types (Pattern 1) | RLS forces a per-tx `SET LOCAL`; pg-boss queries don't expect RLS-aware connection — anti-pattern documented in ARCHITECTURE.md. |
| Hono `getConnInfo` for client IP | Custom trusted-proxy middleware | **CVE-2026-27700** confirms `getConnInfo` is unsafe under reverse proxies that *append* the real IP (AWS ALB, Cloudflare). Roll our own per D-19/D-20. |
| `drizzle-kit migrate` CLI at boot | `migrate()` from `drizzle-orm/node-postgres/migrator` (programmatic) | Programmatic is the recommended runtime path; doesn't require the `drizzle-kit` dev dep in the production image. |
| Better Auth dedicated test/dev OAuth provider | `oauth2-mock-server` (axa-group) in CI | **Better Auth does NOT ship a dev/test provider** in 1.6.x (verified from official docs). D-13's intent is preserved by spinning up `oauth2-mock-server` as a sidecar in the CI matrix and pointing `GOOGLE_*` env at it. |

**Version verification** — verified `npm view <pkg> version` 2026-04-27:

```
hono                        4.12.15  (CVE-2026-27700 fixed in 4.12.2+)
@hono/node-server           2.0.0    (use 1.19.14 — see drift table)
better-auth                 1.6.9
drizzle-orm                 0.45.2
pg                          8.20.0
pg-boss                     12.18.1  (locked at 10.x — see drift table)
@sveltejs/kit               2.58.0
svelte                      5.55.5
@inlang/paraglide-js        2.16.1
vitest                      4.1.5
pino                        10.3.1   (locked at 9.x)
```

## Architecture Patterns

### Recommended Project Structure (D-01: flat, single package)

```
.
├── package.json                           # ONE package.json (D-01)
├── pnpm-lock.yaml
├── Dockerfile                             # multi-stage; ENTRYPOINT switches on APP_ROLE
├── docker-compose.saas.yml
├── docker-compose.selfhost.yml
├── drizzle.config.ts                      # generate-time only
├── svelte.config.js                       # adapter-node target
├── vite.config.ts                         # paraglideVitePlugin + sveltekit
├── messages/
│   └── en.json                            # D-18: single file at root
├── project.inlang/                        # Paraglide inlang project metadata
├── src/
│   ├── routes/                            # SvelteKit routes (UI + form actions)
│   │   ├── +layout.svelte
│   │   ├── +layout.server.ts              # injects locals.user / locals.session
│   │   ├── +page.svelte                   # empty dashboard
│   │   ├── login/+page.svelte
│   │   └── api/auth/[...auth]/+server.ts  # Better Auth route mount (alt: hooks-only)
│   ├── hooks.server.ts                    # auth handler + tenant-scope + proxy-trust
│   ├── lib/
│   │   ├── auth.ts                        # betterAuth() instance (SSOT)
│   │   ├── auth-client.ts                 # client-side helpers
│   │   ├── paraglide/                     # COMPILED — gitignored, regen on build
│   │   ├── server/
│   │   │   ├── db/
│   │   │   │   ├── client.ts              # pg.Pool + drizzle()
│   │   │   │   ├── migrate.ts             # programmatic migrate() at boot
│   │   │   │   └── schema/
│   │   │   │       ├── auth.ts            # Better Auth tables (generated)
│   │   │   │       ├── users-app.ts       # extension columns if needed
│   │   │   │       └── audit-log.ts       # audit log table
│   │   │   ├── crypto/
│   │   │   │   └── envelope.ts            # AES-256-GCM KEK/DEK module
│   │   │   ├── http/
│   │   │   │   ├── app.ts                 # Hono root app
│   │   │   │   └── middleware/
│   │   │   │       ├── tenant.ts          # 404-not-403 + userId injection
│   │   │   │       ├── proxy-trust.ts     # X-Forwarded-For / CF-Connecting-IP
│   │   │   │       └── audit-ip.ts        # writes resolved IP to context
│   │   │   ├── config/
│   │   │   │   └── env.ts                 # zod-validated env config (sole reader of process.env)
│   │   │   ├── logger.ts                  # Pino with D-24 redaction config
│   │   │   ├── ids.ts                     # UUID v7 helper (D-06)
│   │   │   └── audit.ts                   # auditLog() writer
│   │   └── i18n/                          # m.* re-exports
│   ├── worker/
│   │   └── index.ts                       # APP_ROLE=worker entrypoint (Phase 1: stub)
│   ├── scheduler/
│   │   └── index.ts                       # APP_ROLE=scheduler entrypoint (Phase 1: stub)
│   └── server.ts                          # APP_ROLE=app entrypoint (Hono + SvelteKit)
├── drizzle/                               # generated SQL migration files
├── tests/
│   ├── unit/
│   │   ├── envelope.spec.ts               # round-trip + tampering
│   │   └── proxy-trust.spec.ts            # CIDR walking
│   ├── integration/
│   │   ├── auth.spec.ts                   # OAuth round-trip with oauth2-mock-server
│   │   ├── tenant-scope.spec.ts           # cross-tenant 404
│   │   └── anonymous-401.spec.ts          # every protected route refuses anon
│   └── smoke/
│       └── self-host.sh                   # docker compose up + assertions (D-15)
└── .github/workflows/
    └── ci.yml                             # builds image, runs unit + integration + smoke
```

### Pattern 1 — Three-role single image (Area 1)

**The recipe.** One `Dockerfile`, one production tarball, one image tag. The container's `CMD` (or compose's `command:`) sets `APP_ROLE`. `src/server.ts` is a thin dispatcher:

```typescript
// src/server.ts — universal entrypoint, ~30 LOC
import { env } from "./lib/server/config/env.js";
import { logger } from "./lib/server/logger.js";
import { runMigrations } from "./lib/server/db/migrate.js";

async function main() {
  // EVERY role runs migrations at boot. Idempotent. Safe to re-run.
  // First role to acquire pg advisory lock 0xMIGRATE wins; others wait.
  await runMigrations();

  switch (env.APP_ROLE) {
    case "app":       return (await import("./roles/app.js")).start();
    case "worker":    return (await import("./roles/worker.js")).start();
    case "scheduler": return (await import("./roles/scheduler.js")).start();
    default:
      logger.fatal({ role: env.APP_ROLE }, "unknown APP_ROLE");
      process.exit(1);
  }
}

main().catch((err) => { logger.fatal(err, "boot failed"); process.exit(1); });
```

**SvelteKit-under-Hono mounting** (resolves the CLAUDE.md ambiguity "behind the same Hono service or as static-adapter output"):

```typescript
// src/roles/app.ts
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { handler as svelteHandler } from "../../build/handler.js"; // built by adapter-node
import { auth } from "../lib/auth.js";
import { tenantScope } from "../lib/server/http/middleware/tenant.js";
import { proxyTrust } from "../lib/server/http/middleware/proxy-trust.js";

const app = new Hono();

app.use("*", proxyTrust);                                              // first: resolve client IP
app.get("/healthz", (c) => c.text("ok"));                              // never auth-gated
app.get("/readyz", async (c) => /* DB ping + migration check */ c.json({ ok: true }));
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw)); // Better Auth mount
app.use("/api/*", tenantScope);                                        // every /api/* needs userId
// (Phase 2 will add /api/games, /api/items, etc.)
app.all("*", async (c) => {                                            // SvelteKit handles UI
  // Pass through to SvelteKit's Node adapter handler. Hono's adapter and
  // adapter-node's handler() are both Node-style (req,res), so we use the
  // raw Node fallback rather than reimplementing SvelteKit routing.
  return new Promise((resolve) => svelteHandler(c.env.incoming, c.env.outgoing, () => resolve(c.text("not found", 404))));
});

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => logger.info(info, "listening"));

// Graceful shutdown
process.on("SIGTERM", () => {
  logger.info("SIGTERM, draining…");
  server.close(() => { db.end().then(() => process.exit(0)); });
});
```

**Decision rationale (resolves CLAUDE.md ambiguity):** mount SvelteKit *under* Hono via `@sveltejs/adapter-node`'s exported `handler` rather than serving SvelteKit separately. One process, one port, one container. Hono routes own `/api/*` and `/api/auth/*`; SvelteKit owns everything else. This matches D-01 (flat single package, one server entrypoint) and ARCHITECTURE.md ("SvelteKit served as static under SSR adapter from the same Hono server").

**Migrations on boot (Area cross-cutting):** programmatic `migrate()` from `drizzle-orm/node-postgres/migrator`, run before any role starts listening, gated by a Postgres advisory lock so concurrent containers don't race:

```typescript
// src/lib/server/db/migrate.ts
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

export async function runMigrations() {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  // Postgres advisory lock — race-safe for concurrent container starts
  const c = await pool.connect();
  try {
    await c.query("SELECT pg_advisory_lock(0x4D494752415445)");  // 'MIGRATE'
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: "./drizzle" });
  } finally {
    await c.query("SELECT pg_advisory_unlock(0x4D494752415445)");
    c.release();
  }
  await pool.end();
}
```

This avoids the `drizzle-kit migrate` CLI in production (which would force shipping `drizzle-kit` as a runtime dep). Source: Drizzle docs `https://orm.drizzle.team/docs/migrations#migrate-function`.

### Pattern 2 — Better Auth + SvelteKit + Hono (Area 2)

**The two mount points debate, resolved.** Better Auth offers two integration patterns:

| Pattern | Mount | Where session reads happen |
|---------|-------|----------------------------|
| **(A) SvelteKit-native** (`svelteKitHandler`) | `hooks.server.ts` only | `event.locals.session` populated in hook |
| **(B) Hono mount** (`auth.handler(req)`) | Hono route `/api/auth/*` | Both Hono middleware AND SvelteKit hook can call `auth.api.getSession()` |

**Pick (B) — Hono mount.** Reasons:
1. Hono `/api/*` routes need session validation too; (B) lets a single `auth.api.getSession()` call serve both Hono middleware and SvelteKit hooks without duplication.
2. (A)'s `svelteKitHandler` does NOT auto-populate `event.locals.session` (verified from Better Auth docs); we'd have to manually call `auth.api.getSession()` anyway.
3. Phase 2's API routes are Hono routes, not SvelteKit routes; aligning the auth boundary with the API boundary is structurally cleaner.

**Code shape:**

```typescript
// src/lib/auth.ts — Single source of truth for the auth instance
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "./server/db/client.js";
import { env } from "./server/config/env.js";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg" }),
  baseURL: env.BETTER_AUTH_URL,                  // SaaS: https://app.example.com / self-host: http://localhost:3000
  secret: env.BETTER_AUTH_SECRET,                // 32+ char random; rotated separately from KEK
  trustedOrigins: env.TRUSTED_ORIGINS,           // comma-split env, e.g. ["https://app.example.com"]
  socialProviders: {
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      // No `prompt: "consent"` — Google login UX best with default
    },
  },
  session: {
    // D-05: database-backed; cookie carries only session_id
    cookieCache: { enabled: false },             // explicit opt-out — defeat the purpose otherwise
    expiresIn: 60 * 60 * 24 * 30,                // 30 days
    updateAge: 60 * 60 * 24,                     // refresh idle sessions every 1d
  },
  advanced: {
    cookiePrefix: "neotolis",
    crossSubDomainCookies: env.COOKIE_DOMAIN
      ? { enabled: true, domain: env.COOKIE_DOMAIN }
      : { enabled: false },
    useSecureCookies: env.NODE_ENV === "production",
  },
});

// Hono mount (in src/roles/app.ts)
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// SvelteKit hook consumer (in src/hooks.server.ts)
import { auth } from "$lib/auth.js";
export const handle = async ({ event, resolve }) => {
  const session = await auth.api.getSession({ headers: event.request.headers });
  if (session) {
    event.locals.session = session.session;
    event.locals.user = session.user;
  }
  return resolve(event);
};
```

**Schema generation flow.** Better Auth owns the `user`/`session`/`account`/`verification` table shapes; we let it generate them, then commit the output to git:

```bash
# Generates src/lib/server/db/schema/auth.ts (Drizzle TS schema for Better Auth's tables)
pnpm dlx @better-auth/cli@latest generate \
  --config ./src/lib/auth.ts \
  --output ./src/lib/server/db/schema/auth.ts \
  --yes

# Then Drizzle takes over — same toolchain as our app schema
pnpm drizzle-kit generate                                  # produces SQL in ./drizzle/
pnpm drizzle-kit check                                     # commutativity check before merge
# (apply at runtime via programmatic migrate() — Pattern 1)
```

**Google OAuth redirect URIs to register at console.cloud.google.com:**
- Local dev: `http://localhost:3000/api/auth/callback/google`
- SaaS: `https://app.example.com/api/auth/callback/google`
- Self-host: each operator registers their own with their own domain (documented).

This is a **per-deploy** Google project. SaaS gets its own `GOOGLE_CLIENT_ID` registered with the Neotolis Cloud project; self-hosters create their own at `console.cloud.google.com`. Documented in `docs/self-host.md` Phase 6.

### Pattern 3 — Tenant-scope middleware: 404 not 403 (Area 3)

**The principle:** every `/api/*` route except `/api/auth/*`, `/healthz`, `/readyz` requires a session. Cross-tenant access returns **404, not 403** — never reveal that user A's resource exists when user B asks for it. This neutralises ID-enumeration, referrer-leakage, and screenshot-disclosure attack paths.

**Two-layer enforcement** (middleware + service signature):

```typescript
// src/lib/server/http/middleware/tenant.ts
import type { MiddlewareHandler } from "hono";
import { auth } from "$lib/auth.js";

export const tenantScope: MiddlewareHandler<{
  Variables: { userId: string; sessionId: string }
}> = async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    // Anonymous: 401. (Cross-tenant 404 is for *authenticated* requests.)
    return c.json({ error: "unauthorized" }, 401);
  }
  c.set("userId", session.user.id);
  c.set("sessionId", session.session.id);
  return next();
};

// src/lib/server/services/games.ts (Phase 2 example, but the pattern lives in Phase 1)
export class NotFoundError extends Error {}
export async function getGame(userId: string, gameId: string) {
  const rows = await db.select().from(games)
    .where(and(eq(games.userId, userId), eq(games.id, gameId)))
    .limit(1);
  if (rows.length === 0) throw new NotFoundError();   // ← 404 path
  return rows[0];
}

// src/lib/server/http/games.ts
app.get("/api/games/:id", async (c) => {
  try {
    const game = await getGame(c.get("userId"), c.req.param("id"));
    return c.json(game);
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: "not_found" }, 404);
    throw e;
  }
});
```

**Why both layers?** Middleware alone is not enough — once `userId` is on context, a developer can still write a service function that doesn't filter by it. Service signature alone is not enough — the HTTP layer can call services without going through middleware. **Both layers compound:** the middleware refuses anonymous; the service function refuses to query without `userId`; the cross-tenant test (Area 8) catches the rare regression where both layers were skipped.

**Type-level enforcement (defense in depth).** Make `userId` non-optional in every service signature; ban direct `db.select().from(USER_TABLE)` via an ESLint rule that requires a `.where()` chain. The CONVENTIONS.md (greenfield — Phase 1 establishes this) records the rule.

**404 vs 403 — research note.** PRIV-01 requires cross-tenant access to return 404. The textbook reason: 403 reveals the resource exists. The OWASP "Insecure Direct Object Reference" guidance (`https://owasp.org/www-project-web-security-testing-guide/v42/4-Web_Application_Security_Testing/05-Authorization_Testing/04-Testing_for_Insecure_Direct_Object_References`) confirms this. Stripe and GitHub both return 404 for cross-account resource access.

### Pattern 4 — Envelope encryption (Area 4)

**The shape (Phase 1: module + tests; Phase 2: secrets table consumer).** AES-256-GCM via `node:crypto`. Per-row DEK generated at write time. KEK loaded from env.

```typescript
// src/lib/server/crypto/envelope.ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

const ALG = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEK_BYTES = 32;

export interface EncryptedSecret {
  secretCt: Buffer;     // ciphertext of the user secret
  secretIv: Buffer;     // 12-byte nonce for secret encryption
  secretTag: Buffer;    // 16-byte GCM auth tag for secret
  wrappedDek: Buffer;   // ciphertext of the DEK (encrypted by KEK)
  dekIv: Buffer;        // 12-byte nonce for DEK wrap
  dekTag: Buffer;       // 16-byte GCM auth tag for DEK wrap
  kekVersion: number;   // increments on KEK rotation (D-10)
}

function loadKek(version: number): Buffer {
  // env.KEK_VERSIONS is a Map<number, Buffer>: { 1: Buffer, 2: Buffer, ... }
  // Boot validates current version exists; rotation script adds new versions.
  const kek = env.KEK_VERSIONS.get(version);
  if (!kek || kek.length !== KEK_BYTES) throw new Error(`KEK v${version} missing or wrong size`);
  return kek;
}

export function encryptSecret(plaintext: string): EncryptedSecret {
  const dek = randomBytes(KEK_BYTES);
  // Encrypt secret with DEK
  const secretIv = randomBytes(NONCE_BYTES);
  const c1 = createCipheriv(ALG, dek, secretIv);
  const secretCt = Buffer.concat([c1.update(plaintext, "utf8"), c1.final()]);
  const secretTag = c1.getAuthTag();
  // Wrap DEK with current KEK
  const kekVersion = env.KEK_CURRENT_VERSION;
  const kek = loadKek(kekVersion);
  const dekIv = randomBytes(NONCE_BYTES);
  const c2 = createCipheriv(ALG, kek, dekIv);
  const wrappedDek = Buffer.concat([c2.update(dek), c2.final()]);
  const dekTag = c2.getAuthTag();
  // Best-effort wipe — V8 strings are immutable but Buffers can be zeroed
  dek.fill(0);
  return { secretCt, secretIv, secretTag, wrappedDek, dekIv, dekTag, kekVersion };
}

export function decryptSecret(s: EncryptedSecret): string {
  const kek = loadKek(s.kekVersion);
  // Unwrap DEK
  const d1 = createDecipheriv(ALG, kek, s.dekIv);
  d1.setAuthTag(s.dekTag);
  const dek = Buffer.concat([d1.update(s.wrappedDek), d1.final()]);
  // Decrypt secret
  const d2 = createDecipheriv(ALG, dek, s.secretIv);
  d2.setAuthTag(s.secretTag);
  const plaintext = Buffer.concat([d2.update(s.secretCt), d2.final()]).toString("utf8");
  dek.fill(0);
  return plaintext;
}
```

**Phase 1 secrets schema (forward-declared; Phase 2 fills in the consumer).** Per D-11, the `secrets` *table* arrives in Phase 2. Phase 1 ships only the module + unit tests. Schema layout (Phase 2 reference, included here so the planner knows the column shape the encryption module must produce):

```typescript
// Phase 2 schema — DO NOT IMPLEMENT IN PHASE 1, recorded for forward compat
export const secrets = pgTable("secrets", {
  id: uuid("id").primaryKey().$defaultFn(uuidv7),
  userId: uuid("user_id").notNull().references(() => users.id),
  kind: text("kind").notNull(),                    // 'youtube_api_key' | 'reddit_oauth' | ...
  secretCt: bytea("secret_ct").notNull(),
  secretIv: bytea("secret_iv").notNull(),
  secretTag: bytea("secret_tag").notNull(),
  wrappedDek: bytea("wrapped_dek").notNull(),
  dekIv: bytea("dek_iv").notNull(),
  dekTag: bytea("dek_tag").notNull(),
  last4: text("last4").notNull(),                  // shown in UI; never decrypted
  kekVersion: smallint("kek_version").notNull().default(1),  // D-10
  createdAt: timestamp("created_at").notNull().defaultNow(),
  rotatedAt: timestamp("rotated_at"),
}, (t) => ({ uniqUserKind: unique().on(t.userId, t.kind) }));
```

Single row holds wrapped_dek + ciphertext + version. Rotation re-wraps wrapped_dek only (cheap; ciphertext untouched). Per ARCHITECTURE.md and NIST SP 800-57 envelope-encryption guidance.

**Why DEK lives in the same row as ciphertext (and not a separate `secrets_dek` table).** Locality: read = one query, decrypt = local. Atomic rotation: per-row UPDATE rewraps a DEK without touching others. Backup and export are trivial — one row carries everything needed to round-trip.

**Better Auth handles its OWN secrets.** The `BETTER_AUTH_SECRET` (used for session-cookie signing) is *not* envelope-encrypted by us — it's a single env var Better Auth manages. Our envelope module is for **user-supplied** secrets (Phase 2: YouTube key, Reddit refresh token, Steam key). This was an open question; confirmed by Better Auth's design (they hash sessions internally, not via our crypto).

**KEK boot poison-pill** (PITFALL P2):

```typescript
// in src/lib/server/config/env.ts (zod schema validates KEK shape at boot)
// app refuses to start if APP_KEK_BASE64 is missing AND any row exists in `secrets`
const kekBuf = Buffer.from(env.APP_KEK_BASE64, "base64");
if (kekBuf.length !== 32) throw new Error("APP_KEK_BASE64 must decode to 32 bytes");
delete process.env.APP_KEK_BASE64;   // remove from env after consumption (Pitfall P2 mitigation #4)
```

### Pattern 5 — Self-host CI smoke test (Area 5)

**Where it lives:** `.github/workflows/ci.yml` invokes `tests/smoke/self-host.sh`. The script uses Docker Compose to bring up Postgres + the built image, mocks Google OAuth via `oauth2-mock-server`, and asserts the six D-15 invariants.

**Time budget:** <5 min per PR. Achievable on GitHub-hosted runners (Postgres image cached, app image built once and tagged, smoke is mostly HTTP).

**Why `oauth2-mock-server` over Better Auth's "test mode" (D-13 reconciliation):** verified from Better Auth 1.6.x docs — there is **no** dedicated dev/test OAuth provider in Better Auth itself. The closest match is configuring a custom `socialProviders.<name>` against an OIDC-compliant mock server. `oauth2-mock-server` (axa-group, MIT, ~150k weekly DLs, current 7.x) is purpose-built for this. The CI brings it up as a sidecar; `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` env vars point to the mock; redirect URIs match.

```yaml
# .github/workflows/ci.yml — abbreviated
jobs:
  smoke:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env: { POSTGRES_PASSWORD: test }
        ports: ["5432:5432"]
        options: --health-cmd pg_isready
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: corepack enable && pnpm install --frozen-lockfile
      - run: docker build -t neotolis:ci .
      - name: Start mock OAuth IdP
        run: |
          npx -y oauth2-mock-server --port 9090 &
          sleep 2
      - name: Boot app role
        run: |
          docker run -d --name app --network host \
            -e APP_ROLE=app \
            -e DATABASE_URL=postgres://postgres:test@localhost:5432/postgres \
            -e BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
            -e BETTER_AUTH_URL=http://localhost:3000 \
            -e GOOGLE_CLIENT_ID=mock-client-id \
            -e GOOGLE_CLIENT_SECRET=mock-client-secret \
            -e APP_KEK_BASE64=$(openssl rand -base64 32) \
            -e TRUSTED_PROXY_CIDR= \
            neotolis:ci
          # wait for /readyz (migrations done)
          for i in {1..30}; do curl -sf http://localhost:3000/readyz && break || sleep 1; done
      - name: Boot worker + scheduler (verify they run)
        run: |
          docker run --rm -e APP_ROLE=worker -e DATABASE_URL=... neotolis:ci timeout 5 node dist/server.js | grep "worker ready"
          docker run --rm -e APP_ROLE=scheduler -e DATABASE_URL=... neotolis:ci timeout 5 node dist/server.js | grep "scheduler ready"
      - name: Run smoke assertions
        run: bash tests/smoke/self-host.sh   # OAuth login, cross-tenant 404, anon 401, no SaaS leaks
      - name: Grep for SaaS-only assumptions (D-14)
        run: |
          # FAIL if forbidden patterns appear outside infra/ or docs/
          ! grep -rn --include='*.ts' --include='*.svelte' \
            -e 'analytics.neotolis' \
            -e 'CF-Connecting-IP' \
            -e 'admin@neotolis' \
            src/ apps/
```

**Pitfalls in the CI test itself:**
- **Don't share Postgres across smoke + integration tests** — fresh DB per smoke run. (D-16.)
- **Tag-pin `oauth2-mock-server`** — version 7.x. Don't `npx -y` an unpinned version in CI; once a major bumps, the assertions break in surprising ways.
- **Don't hit live Google.** Ever. The mock IdP's `iss` must match the issuer Better Auth expects in `socialProviders.google` — verify with a one-time integration spike.

### Pattern 6 — Trusted-proxy header handling (Area 6)

**Why custom, not `getConnInfo`.** Hono's `getConnInfo` had **CVE-2026-27700** for IP spoofing under AWS ALB (which appends the real client IP to the *end* of `X-Forwarded-For`, while `getConnInfo` took the *first* entry). Cloudflare prepends but the safe pattern is to walk from the right, dropping each entry whose source matches a *trusted* proxy. This is the D-19/D-20 design.

```typescript
// src/lib/server/http/middleware/proxy-trust.ts
import { ipaddr } from "ipaddr.js";   // mature CIDR matcher; permissive licence
import type { MiddlewareHandler } from "hono";
import { env } from "../../config/env.js";

// Compiled at boot from TRUSTED_PROXY_CIDR (comma-separated CIDRs)
const TRUSTED: Array<{ network: any; bits: number }> = parseCidrList(env.TRUSTED_PROXY_CIDR);

function isTrusted(ip: string): boolean {
  if (!ip) return false;
  const parsed = ipaddr.process(ip);
  return TRUSTED.some(({ network, bits }) => parsed.match(network, bits));
}

export const proxyTrust: MiddlewareHandler<{ Variables: { clientIp: string } }> = async (c, next) => {
  // Node adapter exposes the raw IncomingMessage — get the actual socket peer
  const socketIp = (c.env.incoming as any)?.socket?.remoteAddress ?? "";
  let clientIp = socketIp;

  if (isTrusted(socketIp)) {
    // Prefer CF-Connecting-IP if present and our trusted-proxy is Cloudflare
    const cf = c.req.header("cf-connecting-ip");
    if (cf) {
      clientIp = cf;
    } else {
      // Walk X-Forwarded-For from right to left, dropping trusted hops
      const xff = c.req.header("x-forwarded-for") ?? "";
      const hops = xff.split(",").map((s) => s.trim()).filter(Boolean);
      // last untrusted entry is the real client
      clientIp = hops.reverse().find((ip) => !isTrusted(ip)) ?? socketIp;
    }
  }
  c.set("clientIp", clientIp);
  return next();
};
```

**Defaults (D-20):**

| Deploy | `TRUSTED_PROXY_CIDR` value |
|--------|----------------------------|
| Self-host bare | `` (empty — trust nothing; use socket peer) |
| Self-host behind Caddy / nginx on same host | `127.0.0.1/32,::1/128` |
| Self-host behind Cloudflare Tunnel | (Cloudflare ranges; documented) |
| SaaS on aeza behind Cloudflare | Cloudflare IPv4/IPv6 ranges + Docker network `172.16.0.0/12` |

**Where the audit log writes the IP** (Phase 1: hooks the writer; Phase 2 writes the row): `auditLog({ userId, action, ip: c.get("clientIp"), ... })`. This is why D-19 lands the proxy-trust middleware in Phase 1 — the audit framework writes the *resolved* IP from day one.

### Pattern 7 — Paraglide JS 2 + SvelteKit 2 (Area 7)

**Verified setup (from inlang.com docs 2026-04):**

```bash
# Init creates project.inlang/, messages/en.json, vite plugin entry
pnpm dlx @inlang/paraglide-js@latest init
```

```typescript
// vite.config.ts
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { paraglideVitePlugin } from "@inlang/paraglide-js";

export default defineConfig({
  plugins: [
    sveltekit(),
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/lib/paraglide",
      // D-17: no detection — only baseLocale
      strategy: ["baseLocale"],
    }),
  ],
});
```

```jsonc
// messages/en.json — D-18: single file at root
{
  "$schema": "https://inlang.com/schema/inlang-message-format",
  "dashboard_title": "Promotion diary",
  "login_button": "Sign in with Google",
  "sign_out": "Sign out",
  "sign_out_all_devices": "Sign out from all devices"
}
```

```svelte
<!-- src/routes/+page.svelte -->
<script>
  import { m } from "$lib/paraglide/messages.js";
</script>
<h1>{m.dashboard_title()}</h1>
```

```typescript
// src/routes/+layout.server.ts (server-side use)
import { m } from "$lib/paraglide/messages.js";
export const load = () => ({ title: m.dashboard_title() });
```

**Compile step in Docker build:** the Vite plugin runs the compile during `vite build` (already part of `pnpm build`). No separate command. The `src/lib/paraglide/` directory is `.gitignore`-d and regenerated each build.

**D-17 enforcement.** With `strategy: ["baseLocale"]`, no URL prefix routing, no cookie, no `Accept-Language` parsing. Server renders English unconditionally. When a second locale lands later (post-MVP per Deferred), the only changes are: drop `messages/ru.json` and add `"ru"` to the inlang locales config.

### Pattern 8 — Cross-tenant integration test (Area 8)

**The test runs on the SAME Postgres instance as the smoke test** but in a *separate Vitest run* before the Docker smoke; both runs use `POSTGRES_*` service container. Migrations are programmatic, fast, and idempotent.

```typescript
// tests/integration/tenant-scope.spec.ts
import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb, fetchAs, createUser, createGame } from "./helpers.js";

describe("cross-tenant isolation", () => {
  let userA: string, userB: string, gameA: string;

  beforeAll(async () => {
    await setupTestDb();
    userA = await createUser("a@test.local");
    userB = await createUser("b@test.local");
    gameA = await createGame(userA, "User A's secret game");
  });

  it("returns 404 (NOT 403) when user B requests user A's game", async () => {
    const res = await fetchAs(userB, `/api/games/${gameA}`);
    expect(res.status).toBe(404);                            // ← critical: 404, not 403
    const body = await res.json();
    expect(body).toMatchObject({ error: "not_found" });
    // Body MUST NOT reveal that the resource exists
    expect(JSON.stringify(body)).not.toContain("forbidden");
    expect(JSON.stringify(body)).not.toContain("permission");
  });

  it("returns 200 when user A requests their own game", async () => {
    const res = await fetchAs(userA, `/api/games/${gameA}`);
    expect(res.status).toBe(200);
  });

  it("returns 401 when anonymous", async () => {
    const res = await fetch(`http://localhost:3000/api/games/${gameA}`);
    expect(res.status).toBe(401);
  });
});

// Repeat the matrix for EVERY tenant-owned route:
// /api/games/:id, /api/items/:id, /api/snapshots/:id, /api/audit, /api/secrets/...
```

**Test fixtures bypass OAuth** — `createUser()` inserts directly into the `user`/`session` tables, then `fetchAs()` sets the session cookie. This avoids the OAuth dance for every test (slow) and keeps the OAuth path tested only in the smoke test (one happy path) and the dedicated `tests/integration/auth.spec.ts`.

**Why same Postgres instance, separate Vitest:** the integration suite needs migrations applied once; the smoke test needs a *fresh* DB. CI sequences them: `pnpm vitest run` (integration) → drop+recreate DB → `bash tests/smoke/self-host.sh` (smoke).

**Anonymous-401 sweep.** A small Vitest test enumerates routes via Hono's `app.routes` and asserts each returns 401 unauthenticated:

```typescript
it("every protected route refuses anonymous", async () => {
  for (const r of app.routes.filter((r) => !r.path.startsWith("/api/auth")
                                        && !r.path.startsWith("/health")
                                        && !r.path.startsWith("/ready"))) {
    const res = await fetch(`http://localhost:3000${r.path.replace(/:\w+/g, "fixture-id")}`,
      { method: r.method });
    expect.soft(res.status, `${r.method} ${r.path}`).toBe(401);
  }
});
```

This catches the Phase-2-or-later regression where someone adds a new route and forgets the middleware (PITFALL P18).

### Anti-Patterns to Avoid

- **Postgres RLS as primary tenant scope** — anti-pattern AP-1 from ARCHITECTURE.md. RLS is fine as defense-in-depth on the SaaS instance but should not be primary; it forces per-tx `SET LOCAL`, conflicts with pg-boss connection sharing, and surfaces leaks at runtime instead of compile time.
- **One queue with priorities** — AP-2; head-of-line blocking under load. (Phase 3 concern but Phase 1 should declare four named queues so the schema lands right.)
- **In-process decrypted secret cache** — AP-3; in-process plaintext stash is a heap-dump leak vector.
- **Mutating `tracked_items` with the latest metric** — AP-4; kills time series. Phase 3 territory but the `metric_snapshots` schema gets shaped in Phase 1's discussions.
- **Trusting `X-Forwarded-For` without an allowlist** — AP-5; spoofed IPs in audit log. Confirmed by CVE-2026-27700.
- **Long-lived KEK in `app` process memory** — AP-6; only the secret-write code path loads KEK; the worker (Phase 2+) loads per job.
- **Returning ciphertext via API** — PITFALL P3; DTO discipline is non-negotiable. Phase 1 establishes the pattern with the `User` DTO (we never return `google_sub` on a user-info endpoint, only `id`, `email`, `name`, `imageUrl`).
- **`/api/debug` or `/api/env` route** — PITFALL P2. Lint rule bans `process.env` outside `src/lib/server/config/`.
- **`JSON.stringify(err)` on caught errors** — PITFALL P2 leak vector. Use Pino's error serializer.
- **Embedding Grafana iframes** — PITFALL P14 AGPL contamination. Phase 6 territory but flag it: any iframe to a Grafana host = AGPL discussion.
- **Sharing Docker socket with cloudflared / Caddy** — PITFALL P2; allows extracting `Config.Env`. Self-host docs (Phase 6) reinforce; Phase 1 compose files MUST NOT mount `/var/run/docker.sock` to any sidecar.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Google OAuth flow + session management | Roll-your-own with `googleapis` | **Better Auth 1.6** | Account linking, CSRF defenses, session rotation, audit hooks all bundled. PITFALL #avoid-bespoke-auth. |
| AES-256-GCM | `crypto-js` / pure-JS AES | **Node `node:crypto` (built-in)** | Built-in is authenticated, fast, audited. `crypto-js` is unauthenticated and slow. |
| KMS-backed envelope encryption | AWS Encryption SDK / Tink | **Custom Node `crypto` envelope module (Pattern 4)** | KMS-coupled SDKs add ~5MB bundle + AWS dep. Single VPS reality doesn't justify it. Migration path documented (swap envelope module impl). |
| Tenant-scoped queries | Roll-your-own helper | **Service-signature pattern + Drizzle `eq(table.userId, userId)`** | Convention enforced by ESLint rule + cross-tenant integration test. RLS is anti-pattern AP-1. |
| Trusted-proxy / X-Forwarded-For parsing | Naive `headers['x-forwarded-for'].split(',')[0]` | **Custom middleware with `ipaddr.js` (Pattern 6)** | CVE-2026-27700 confirms naive parsing is unsafe. `ipaddr.js` is the standard CIDR matcher. |
| OAuth mock for CI | Build a fake IdP | **`oauth2-mock-server` (axa-group)** | Purpose-built, MIT, OIDC-compliant. ~150k weekly DLs. |
| Job queue | Build with `LISTEN/NOTIFY` | **pg-boss** | Cron, DLQ, retries, partitioning out of the box. (Phase 3 concern; Phase 1 just installs and declares.) |
| ID generation | `crypto.randomUUID()` (UUID v4) | **UUID v7** (D-06) | Time-sortable indexes; lower index bloat. Use a tiny lib (`uuidv7` ~2KB) or app-side generator. |
| Logging | `console.log` | **Pino** with D-24 redaction | Fastest Node logger; redaction config defends against PITFALL P2 leaks. |
| Migrations at boot | `drizzle-kit migrate` shell-out | **Programmatic `migrate()` from `drizzle-orm/node-postgres/migrator`** | No `drizzle-kit` runtime dep; pg advisory lock for concurrent containers. |
| i18n | `i18next` / `vue-i18n` | **Paraglide JS 2** | Compile-time tree-shaken; near-zero runtime cost; officially recommended by Svelte. |

**Key insight:** Phase 1 is dense with security primitives (auth, encryption, tenant isolation, IP resolution). Hand-rolling any one of them = either a CVE, a parity break, or a developer-experience hole that bites in Phase 2+. The locked stack already chose proven, audited libraries for each — the planner's job is to wire them together correctly, not invent.

## Runtime State Inventory

> Phase 1 is greenfield. Categories below are all "None" because there is no pre-existing runtime state to migrate. Recorded explicitly per the research checklist.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None — repo is empty except for `.planning/` and `CLAUDE.md` | None |
| Live service config | None — no deployed service exists | None |
| OS-registered state | None — no scheduled tasks, no systemd units, no Docker images deployed | None |
| Secrets/env vars | None — Phase 1 *creates* the env discipline (`.env.example`, zod-validated config); no pre-existing `APP_KEK_BASE64` to migrate | None |
| Build artifacts / installed packages | None — `package.json` does not exist yet; `node_modules/` does not exist yet | None |

**Verified by:** `ls C:/projects/neotolis-game-promotion-diary/` shows only `.git/`, `.planning/`, and `CLAUDE.md` exist. Greenfield.

## Common Pitfalls

> The full project pitfall catalog lives at `.planning/research/PITFALLS.md`. Below: the Phase-1-relevant subset, condensed.

### Pitfall 1 — Cross-tenant data leak (P1, CRITICAL)

**What goes wrong:** A `SELECT * FROM tracked_items WHERE id = $1` (no `user_id` filter) returns user A's data when user B requests by guessing/scraping IDs.
**Why:** A new endpoint copy-pastes a query but forgets the tenant clause. Or worker code trusts a job payload's `itemId` without re-asserting ownership.
**Avoid:** (1) Tenant-scoped service signature; (2) ESLint rule banning `db.select()` from a tenant table without `.where(eq(table.userId, ...))`; (3) cross-tenant integration test (Pattern 8) on every PR; (4) PR review checklist.
**Warning signs:** Audit log shows `actor=A, action=item.read, metadata.item.userId=B`; Pino `WARN tenant.mismatch` from a service-layer guard; 404 spike after refactor (means scope is now correctly restrictive).
**Phase to address:** Phase 1 (Tier 0). Retrofitting `userId` arguments is exactly the path that destroys multi-tenant SaaS.

### Pitfall 2 — KEK leak via env-dump / log line (P2, CRITICAL)

**What goes wrong:** `APP_KEK_BASE64` ends up in `/api/debug`, an unhandled error's stack trace, a `logger.info({env: process.env}, ...)`, or `docker inspect`.
**Avoid:** (1) No route returns env, period — `/healthz` returns `{ok: true}` and nothing else. (2) Pino redact paths from D-24. (3) `Buffer.from(process.env.APP_KEK_BASE64!, 'base64')` once at boot, then `delete process.env.APP_KEK_BASE64`. (4) `app` doesn't keep KEK in a module-level constant.
**Warning signs:** Loki regex monitor for 32-byte base64 strings; PR adding `process.env` outside `config/`.
**Phase to address:** Phase 1.

### Pitfall 3 — Returning ciphertext or plaintext via API (P3, CRITICAL)

**What goes wrong:** A "list my saved keys" endpoint returns the entire `secrets` row, leaking ciphertext columns or (worse) plaintext via a "view key" feature that violates write-once-UI.
**Avoid:** (1) DTO discipline — every API response shape is a zod schema; never `c.json({...row})`. (2) Drizzle `select({...})` projection — never `select()` (full row) on `secrets`. (3) Property-based test asserts no field of any API response is longer than 8 hex chars unless explicitly allow-listed. (4) Export schema (Phase 6) explicitly excludes `secrets` table.
**Phase to address:** Phase 1 establishes the DTO pattern (we hand-write `UserDto` for the auth path); Phase 2 carries it forward to `SecretDto`.

### Pitfall 13 — Self-host parity rot (P13, HIGH)

**What goes wrong:** Subtle SaaS-only assumptions accumulate over months — a feature reads `process.env.CF_ZONE_ID` without fallback; telemetry beacon to `analytics.neotolis.com` fires; hardcoded `if email === 'admin@neotolis.com'`.
**Avoid:** (1) `APP_MODE=saas|selfhost` env read once in `config/`. Code paths differ ONCE at boot, not scattered. Only known difference points: trusted-proxy default, cookie domain, rate-limit backend, optional LGTM stack. (2) CI runs the self-host smoke test on every PR (Area 5). (3) NO telemetry by default. (4) No hardcoded admin emails; admin is a DB column. (5) Quarterly grep for `process.env.CF_*`, `cloudflare`, `r2.cloudflarestorage`, `neotolis.com`.
**Phase to address:** Phase 1. Smoke test in CI is non-negotiable from day one.

### Pitfall 18 — Privacy-only-in-MVP creep / accidental public mode (P18, CRITICAL)

**What goes wrong:** Pressure during early use → "let me share my chart" → someone adds `is_public` boolean → a partial public mode ships → ACL bug = wishlist data leaks.
**Avoid:** (1) v1 codebase has NO `is_public` field, no share endpoint, no public route. (2) Tenant-scope middleware refuses anonymous on every `/api/*`. (3) No OG image rendering for game pages. (4) Anonymous-401 integration test for every API endpoint, every PR. (5) When v2 share-link work begins, it's a new top-level route prefix `/share/`, NOT a flag on existing endpoints.
**Phase to address:** Phase 1.

### Pitfall 19 — Audit log read endpoint leaking other users' data (P19, CRITICAL)

**What goes wrong:** Audit log read endpoint forgets `WHERE user_id = ?`; pagination cursor is row `id` (bigserial) globally, not tenant-relative; metadata JSON contains a third party's IP/email.
**Avoid:** (1) Audit queries through `services/audit.ts` tenant-scoped helper. (2) Pagination cursor: `WHERE user_id = ? AND id < ?` (tenant-relative). (3) Audit metadata sanitization — no `metadata.target_user_id` referencing another tenant. (4) `audit_log` is APPEND-ONLY: app role has INSERT but not UPDATE/DELETE.
**Phase to address:** Phase 1 (audit framework wired; first writes from auth events) → Phase 2 (audit read endpoint).

### Pitfall 20 — Solo operator compromise (P20, CRITICAL)

**What goes wrong:** Operator loses laptop with KEK; Cloudflare token leaks; recovery is improvised under pressure.
**Avoid (Phase 1 surface only):** (1) `APP_KEK_BASE64` only in env, never in DB. (2) `kek_version` column ships in Phase 1 schema so rotation works post-launch without a migration. (3) Phase 6 ships the rehearsed runbook. The mechanism (versioned KEK, re-wrap script) is laid in Phase 1. (4) GitHub branch protection on `main` from day one (configured in CI repo settings).
**Phase to address:** Phase 1 (mechanism); Phase 6 (runbook + rehearsal).

### Phase-1-specific pitfall (NEW): Hono `getConnInfo` IP-spoof CVE

**What goes wrong:** Using Hono's built-in `getConnInfo` (or naive `c.req.header('x-forwarded-for').split(',')[0]`) returns the *attacker-controlled* first XFF entry under reverse proxies that *append* the real IP (AWS ALB, some Cloudflare configs).
**Why it happens:** CVE-2026-27700; the helper's runtime-aware default for AWS Lambda ALB picked the wrong end of the list.
**Avoid:** Custom middleware (Pattern 6) that walks XFF from the right, dropping trusted-CIDR hops. Confirmed by D-19/D-20.
**Warning signs:** Audit log records the same IP for many distinct users (= proxy IP, not client). Rate limiter blocks legitimate users.
**Phase to address:** Phase 1.

### Phase-1-specific pitfall (NEW): Better Auth schema vs Drizzle migration ordering

**What goes wrong:** `pnpm @better-auth/cli generate` produces `schema/auth.ts`; developer commits but forgets to `pnpm drizzle-kit generate` afterward; production migration is missing the auth tables; container fails on first OAuth callback.
**Avoid:** (1) Bake into `package.json` scripts: `"db:generate": "@better-auth/cli generate --yes && drizzle-kit generate"` so both run together. (2) CI step: `pnpm db:generate && git diff --exit-code drizzle/ src/lib/server/db/schema/auth.ts` — fails if generated artifacts are out of sync with committed ones. (3) `/readyz` runs migrations + a smoke probe of `auth.api.getSession({headers: new Headers()})` to verify the schema is mounted.
**Phase to address:** Phase 1.

### Phase-1-specific pitfall (NEW): pg-boss queue declaration drift

**What goes wrong:** pg-boss v10+ requires `await boss.createQueue('name')` before `boss.send('name', ...)`. Phase 1 declares queues in the scheduler entrypoint; Phase 3 adds a new queue but forgets to declare it; jobs vanish silently.
**Avoid:** (1) Declare queues in a single `src/lib/server/queues.ts` module shared by all roles. (2) `app` boots → reads queue list → calls `createQueue` for each (idempotent). (3) Worker boot asserts every queue it consumes from is declared.
**Phase to address:** Phase 1 (lay the queue-declaration discipline; first queue may be `internal.healthcheck`); Phase 3 (full poll.* queues).

## Code Examples

The patterns above include working code shapes for each of the eight areas. The single example most useful as a "north star" is the **tenant-scope middleware + service signature pair** (Pattern 3) because every Phase 2+ feature inherits it. Cited from official docs (Drizzle docs `https://orm.drizzle.team/`, Hono docs `https://hono.dev/docs/middleware/builtin/cors` for the middleware shape) and adapted to the project's conventions.

## State of the Art (2026)

| Old approach | Current approach | When changed | Impact |
|--------------|------------------|--------------|--------|
| Lucia v3 for SvelteKit auth | Better Auth 1.6+ | March 2025 (Lucia deprecated) | Lucia repo is now a learning resource only; Better Auth is the de-facto successor |
| `snoowrap` for Reddit | Native `fetch` to Reddit OAuth API (~150 LoC) | March 2024 (snoowrap archived) | Phase 3 concern; Phase 1 should not pull in `snoowrap` even transitively |
| `drizzle-kit migrate` CLI in production containers | Programmatic `migrate()` from `drizzle-orm/<driver>/migrator` | Drizzle 0.40+ | Removes `drizzle-kit` runtime dep |
| Hono `getConnInfo` for client IP behind LB | Custom trusted-proxy middleware with allowlist | 2026-03 (CVE-2026-27700) | Confirms our D-19/D-20 design |
| pg-boss v9 (lazy queue creation) | pg-boss v10+ (explicit `createQueue`) | 2024-Q4 (v10 release) | Affects Phase 3 worker design; Phase 1 just declares and asserts |
| `@hono/node-server` 1.x | 2.0.0 (2026-04-21) | Six days before this research | Pin 1.19.14 for Phase 1; revisit at Phase 2 |
| `auth@latest` CLI for Better Auth | `@better-auth/cli@latest` | 2025 (rename) | Older blog posts use the old name; new docs use the new |

**Deprecated/outdated to avoid:**
- **Lucia v3** — repository is a learning resource since March 2025. Confirmed in CLAUDE.md.
- **snoowrap** — archived 2024-03-17. Phase 3 concern but Phase 1 must not introduce it.
- **`request` / `request-promise`** — deprecated 2020, the snoowrap transitive dep that's the second reason to avoid snoowrap.
- **`crypto-js`** — pure-JS, slow, unauthenticated by default.
- **`bcrypt` / `argon2` for API keys** — wrong primitive (these are password hashers).

## Open Questions

1. **Whether to register one or three named pg-boss queues in Phase 1.**
   - What we know: D-15 only requires "worker boots and prints 'worker ready'"; no live polling.
   - What's unclear: Should Phase 1 lay down the four-queue structure (`poll.hot`, `poll.warm`, `poll.cold`, `poll.user`) so Phase 3 can fill in handlers, or wait?
   - Recommendation: Declare all four queues + a `internal.healthcheck` queue in `src/lib/server/queues.ts` in Phase 1. The scheduler container's `boot()` calls `createQueue` for each. This locks the queue topology before Phase 3, so Phase 3 only adds handlers. Confidence: MEDIUM — planner may decide to defer per minimal-viable principle.

2. **Whether `APP_MODE=saas|selfhost` is set in Phase 1.**
   - What we know: ARCHITECTURE.md SaaS-vs-Self-host Deltas table lists exactly what differs (proxy-trust default, cookie domain, rate-limit backend).
   - What's unclear: Does Phase 1 ship with the env var read at all, or wait until Phase 6 finalizes it?
   - Recommendation: Ship `APP_MODE` in Phase 1's `env.ts` because two of the three difference points (proxy-trust default + cookie domain) land in Phase 1. Phase 6 only adds documentation. Confidence: HIGH.

3. **UUID v7 implementation — pg extension vs app-side library.**
   - What we know: D-06 requires UUID v7 for every primary key.
   - What's unclear: Postgres 16 doesn't natively generate UUID v7 (a Postgres 18 feature, not yet GA at time of research). Our options are (a) `uuid-ossp` extension with v4 fallback; (b) `pg_uuidv7` extension; (c) app-side `uuidv7` package (~2KB).
   - Recommendation: app-side `uuidv7` package via `defaultFn` in Drizzle. Avoids extension installation friction for self-hosters; works identically across Postgres versions. Confidence: HIGH.

4. **`/readyz` semantics — how strict is "migrations are at the latest"?**
   - What we know: D-21 says `/readyz` returns 200 only when DB connection works AND migrations are at the latest.
   - What's unclear: How does the app know "migrations are at the latest"? Drizzle's `migrate()` is idempotent; it could be called on every `/readyz` poll (cheap on no-op) but that hammers Postgres.
   - Recommendation: Boot-time `runMigrations()` sets a module-level flag `migrationsApplied = true`; `/readyz` checks the flag + a 50ms `SELECT 1`. Confidence: HIGH.

5. **Whether to register Hono's `secureHeaders` middleware in Phase 1.**
   - What we know: CLAUDE.md mentions Hono's secure-headers helper. It's standard hardening (HSTS, X-Frame-Options, etc).
   - What's unclear: Is HSTS-set-by-app correct when Cloudflare also sets HSTS? (Probably yes; HSTS is idempotent.)
   - Recommendation: Use `hono/secure-headers` with default config; document the redundancy in `docs/trusted-proxy.md`. Confidence: HIGH.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | local dev (Vitest, vite, build) | ✓ | 20.15.0 (target is 22 LTS) | Docker image uses Node 22; local dev works on 20 for most flows |
| Docker | self-host smoke + Dockerfile build | ✓ | 26.1.4 | — |
| pnpm | per D-02 | ✗ | — | `npm install -g pnpm` (single setup step; documented in README) |
| Postgres client (psql / pg_isready) | local DB inspection (optional) | ✗ | — | `docker exec` into Postgres container; or document optional install |
| git | repo + GitHub Actions | ✓ (implied) | — | — |
| GitHub account / Actions | CI smoke gate (DEPLOY-05) | (assumed) | — | If absent, fallback is GitLab/CircleCI; recommend assuming GitHub per ARCHITECTURE.md |

**Missing dependencies with no fallback:**
- None blocking for Phase 1 implementation. pnpm is a one-liner install. Postgres ships in Docker.

**Missing dependencies with fallback:**
- **pnpm:** `npm install -g pnpm@9` documented in README's Quick Start.
- **Local Postgres client:** Docker `exec` into the Postgres container suffices; psql install is operator-optional.
- **Node 22 locally:** Phase 1 plans should specify `.nvmrc` containing `22` so `nvm use` upgrades local dev. Vitest 4 + SvelteKit 2 work fine on Node 20 for the unit-test runner; the Docker image is the source of truth for production behavior.

**Note on `oauth2-mock-server` in CI:** not listed above because it's a CI-only npm dep (`npm install --save-dev oauth2-mock-server@7`); no host-level install. The CI service container brings it up.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.x (D-04) — with `@vitest/coverage-v8` for coverage |
| Config file | `vitest.config.ts` — Vite-shared, ESM-native (created in Phase 1 Wave 0) |
| Quick run command | `pnpm vitest run --reporter=dot tests/unit` |
| Full suite command | `pnpm vitest run && bash tests/smoke/self-host.sh` |
| Smoke runner | `bash tests/smoke/self-host.sh` — orchestrates Docker compose + `oauth2-mock-server` + assertions |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| AUTH-01 | Sign in with Google OAuth → land on dashboard | integration | `pnpm vitest run tests/integration/auth.spec.ts -t "google oauth"` | ❌ Wave 0 |
| AUTH-02 | Sign-out invalidates server-side session | integration | `pnpm vitest run tests/integration/auth.spec.ts -t "sign out"` | ❌ Wave 0 |
| AUTH-02 | Sign out from all devices clears all sessions for user | integration | `pnpm vitest run tests/integration/auth.spec.ts -t "all devices"` | ❌ Wave 0 |
| AUTH-03 | First sign-in creates user; second sign-in resumes | integration | `pnpm vitest run tests/integration/auth.spec.ts -t "first vs return"` | ❌ Wave 0 |
| PRIV-01 | Cross-tenant access returns 404 not 403 | integration | `pnpm vitest run tests/integration/tenant-scope.spec.ts` | ❌ Wave 0 |
| PRIV-01 | Anonymous access returns 401 on every protected route | integration | `pnpm vitest run tests/integration/anonymous-401.spec.ts` | ❌ Wave 0 |
| UX-04 | Paraglide compiles `messages/en.json` to typed `m.*` exports | unit | `pnpm vitest run tests/unit/paraglide.spec.ts` | ❌ Wave 0 |
| UX-04 | Adding `messages/ru.json` would be content-only (snapshot test) | unit | `pnpm vitest run tests/unit/paraglide.spec.ts -t "locale add"` | ❌ Wave 0 |
| DEPLOY-05 | Self-host smoke test boots image, signs in, asserts no SaaS leak | smoke | `bash tests/smoke/self-host.sh` (CI-only) | ❌ Wave 0 |
| (cross-cutting) | Envelope encryption round-trip | unit | `pnpm vitest run tests/unit/envelope.spec.ts` | ❌ Wave 0 |
| (cross-cutting) | Envelope rejects tampered ciphertext (auth tag) | unit | `pnpm vitest run tests/unit/envelope.spec.ts -t "tamper"` | ❌ Wave 0 |
| (cross-cutting) | KEK rotation re-wraps DEK, ciphertext unchanged | unit | `pnpm vitest run tests/unit/envelope.spec.ts -t "rotate"` | ❌ Wave 0 |
| (cross-cutting) | Migrations idempotent on second boot | integration | `pnpm vitest run tests/integration/migrate.spec.ts` | ❌ Wave 0 |
| (cross-cutting) | Migrations advisory-locked (concurrent safe) | integration | `pnpm vitest run tests/integration/migrate.spec.ts -t "concurrent"` | ❌ Wave 0 |
| (cross-cutting) | Trusted-proxy: untrusted source → use socket peer | unit | `pnpm vitest run tests/unit/proxy-trust.spec.ts` | ❌ Wave 0 |
| (cross-cutting) | Trusted-proxy: walk XFF from right, drop trusted hops | unit | `pnpm vitest run tests/unit/proxy-trust.spec.ts -t "right-walk"` | ❌ Wave 0 |
| (cross-cutting) | `/healthz` 200 always; `/readyz` 200 only after migrations | integration | `pnpm vitest run tests/integration/health.spec.ts` | ❌ Wave 0 |
| (cross-cutting) | DTO discipline: API response excludes `google_sub`, `wrappedDek`, `secretCt` | unit | `pnpm vitest run tests/unit/dto.spec.ts` | ❌ Wave 0 |
| (cross-cutting) | Pino redaction: `kek`, `apiKey`, `accessToken` keys are `[REDACTED]` | unit | `pnpm vitest run tests/unit/logger.spec.ts` | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `pnpm vitest run --reporter=dot tests/unit` (~5 sec; covers envelope, proxy-trust, paraglide, dto, logger)
- **Per wave merge:** `pnpm vitest run` (full unit + integration; Postgres service container, ~30 sec)
- **Phase gate:** Full suite + `bash tests/smoke/self-host.sh` green before `/gsd:verify-work` (~3-5 min total)

### Wave 0 Gaps

The following test infrastructure must land in the first wave of Phase 1 (before any feature task):

- [ ] `vitest.config.ts` — base config; resolves `$lib/*` SvelteKit aliases for tests
- [ ] `tests/conftest-equivalent` (Vitest setup file at `tests/setup.ts`) — Postgres connection string from `TEST_DATABASE_URL`, runs `migrate()` once, truncates tables between specs
- [ ] `tests/integration/helpers.ts` — `setupTestDb()`, `createUser()`, `createGame()`, `fetchAs(userId, path)` (sets session cookie directly, bypassing OAuth)
- [ ] `tests/unit/envelope.spec.ts` — placeholder file with imports; tests filled in alongside the module
- [ ] `tests/integration/anonymous-401.spec.ts` — enumerates `app.routes` and asserts 401 for each protected one
- [ ] `tests/integration/tenant-scope.spec.ts` — the cross-tenant-404 matrix
- [ ] `tests/smoke/self-host.sh` — bash + curl assertions; runs in CI only
- [ ] `.github/workflows/ci.yml` — unit → integration → smoke pipeline
- [ ] Framework install: `pnpm install -D vitest@4 @vitest/coverage-v8 oauth2-mock-server@7 ipaddr.js@2 uuidv7@1`

## Sources

### Primary (HIGH confidence)
- Better Auth official docs — Drizzle adapter `https://better-auth.com/docs/adapters/drizzle`, Google provider `https://better-auth.com/docs/authentication/google`, SvelteKit integration `https://better-auth.com/docs/integrations/svelte-kit`, cookies `https://better-auth.com/docs/concepts/cookies`, CLI `https://better-auth.com/docs/concepts/cli`. Verified 2026-04-27.
- Drizzle ORM migrations docs `https://orm.drizzle.team/docs/migrations` — programmatic `migrate()` recipe.
- Inlang Paraglide for SvelteKit `https://inlang.com/m/dxnzrydw/paraglide-sveltekit-i18n` — verified Vite plugin shape, locale strategies.
- pg-boss v10 release notes `https://github.com/timgit/pg-boss/releases/tag/10.0.0` — `boss.stop({wait, graceful, timeout})` semantics, `createQueue` requirement, Node 20 / Postgres 13 minimums.
- Hono behind reverse proxy `https://hono.dev/examples/behind-reverse-proxy` — protocol forwarding pattern.
- Hono CVE-2026-27700 advisory `https://advisories.gitlab.com/pkg/npm/hono/CVE-2026-27700/` — confirms `getConnInfo` cannot be trusted under reverse proxies that append the real IP.
- Node.js crypto `https://nodejs.org/api/crypto.html` — AES-256-GCM API used in Pattern 4.
- NIST SP 800-57 envelope encryption `https://csrc.nist.gov/publications/detail/sp/800-57-part-1/rev-5/final` — rotate KEKs, not DEKs.
- npm registry version checks (verified 2026-04-27 via `npm view`): `hono@4.12.15`, `@hono/node-server@2.0.0` (latest) and `1.19.14` (recommended), `better-auth@1.6.9`, `drizzle-orm@0.45.2`, `pg@8.20.0`, `pg-boss@12.18.1`, `@sveltejs/kit@2.58.0`, `svelte@5.55.5`, `@inlang/paraglide-js@2.16.1`, `vitest@4.1.5`, `pino@10.3.1`.
- Project research artifacts (already shipped in repo): `.planning/research/STACK.md`, `.planning/research/ARCHITECTURE.md` (especially Pattern 1 / Pattern 4 / Pattern 5 / SaaS vs Self-host Deltas / Build Order Tier 0), `.planning/research/PITFALLS.md` (P1, P2, P3, P13, P14, P18, P19, P20).

### Secondary (MEDIUM confidence)
- `oauth2-mock-server` (axa-group) `https://github.com/axa-group/oauth2-mock-server` — current 7.x; widely used for OIDC mocks in CI. Not officially endorsed by Better Auth but the only viable choice given that Better Auth ships no test/dev provider.
- pg-boss v12 release history (current is 12.18.1 vs locked 10.x) `https://github.com/timgit/pg-boss/releases` — used to surface the version-drift finding for planner reconciliation.
- Better Auth CLI naming (`@better-auth/cli` vs older `auth@latest`) — multiple community sources; verified by walking issue tracker and most recent docs.

### Tertiary (LOW confidence — flagged for validation)
- Better Auth's exact behavior under `cookieCache: { enabled: false }` plus database sessions: documented but not exercised at production scale by us; recommend a Phase-1 integration spike that confirms session invalidation is server-side immediate.
- Hono's `app.routes` introspection used in the anonymous-401 sweep: works in Hono 4.x but may have edge cases with `app.route()` mounts. Recommend a Phase-1 spike to verify the route enumerator covers all mounted sub-apps.
- `@hono/node-server` 1.19.14 + 2.0.0 compatibility: 1.19.14 is well-tested but 2.0.0 was released six days before research; we deliberately pin to 1.19.14. Revisit pin at Phase 2 start.

## Metadata

**Confidence breakdown:**

- Standard Stack: **HIGH** — every version verified against npm registry on 2026-04-27. Two drift findings (`@hono/node-server` 2.0.0, `pg-boss` 12.x) explicitly flagged for planner.
- Architecture (Areas 1, 3, 6, 8): **HIGH** — derived from already-locked CONTEXT.md decisions and ARCHITECTURE.md patterns. Code shapes adapted from official docs.
- Better Auth integration (Area 2): **HIGH** for the Hono-mount + SvelteKit-hook hybrid; **MEDIUM** for D-13's "Better Auth test mode" reconciliation (no such mode exists; recommend `oauth2-mock-server`).
- Envelope encryption (Area 4): **HIGH** — built-in `node:crypto` AES-256-GCM is well-trodden; matches NIST SP 800-57 envelope guidance.
- CI smoke test (Area 5): **HIGH** for the structural shape (Postgres service + Docker run + curl assertions); **MEDIUM** for `oauth2-mock-server` integration with Better Auth — recommend a one-time integration spike.
- Trusted-proxy (Area 6): **HIGH** — confirmed by CVE-2026-27700 and project's own D-19/D-20.
- Paraglide JS 2 (Area 7): **HIGH** — verified directly from inlang.com docs 2026-04.
- Pitfalls: **HIGH** — sourced from project's own catalogued PITFALLS.md plus 2026 CVE.

**Research date:** 2026-04-27
**Valid until:** 2026-06-27 (60 days). Re-validate `@hono/node-server` 2.0.0 at Phase 2 start. Re-validate pg-boss 10.x lock vs 12.x current at Phase 3 start (workers actually run there). Re-validate Better Auth at every phase boundary because 1.6→1.7 may land within window.
