# Phase 1: Foundation - Context

**Gathered:** 2026-04-27
**Status:** Ready for planning

<domain>
## Phase Boundary

One Docker image boots in three roles (`app` / `worker` / `scheduler`) selected by an `APP_ROLE` environment variable. Google OAuth login works end-to-end via Better Auth with database-backed sessions. An envelope-encryption module (KEK-from-env, DEK-per-row, AES-256-GCM, `kek_version` column, rotation supported) is unit-tested but only minimally exercised by the schema in this phase. Tenant-scope middleware enforces that every authenticated request carries a verified `user_id`, and a self-host smoke test in CI gates every PR from day one. Trusted-proxy header handling lands here too because the audit log records IPs from Phase 1 and a stub would be a bug, not a feature.

This phase delivers no end-user features beyond "sign in, see an empty dashboard, sign out (including from all devices)". Everything else builds on this foundation.

</domain>

<decisions>
## Implementation Decisions

### Repo & Tooling

- **D-01 — Flat single package.** One `package.json` at the repo root. SvelteKit lives at `src/routes/` (handles UI + server endpoints via `+page.server.ts` / `hooks.server.ts`). Worker entrypoint is `src/worker/index.ts` and scheduler is `src/scheduler/index.ts`. They share `src/lib/` (db, encryption, schema, services). One `Dockerfile` produces one image whose `ENTRYPOINT` dispatches on `APP_ROLE`. Reason: solo-friendly, matches the "one image → three roles" architecture, no workspace boilerplate.
- **D-02 — pnpm.** Strict dep resolution (no phantom deps), workspace-friendly even at flat layout, faster CI.
- **D-03 — ESLint + Prettier (not Biome).** Better `.svelte` coverage via `eslint-plugin-svelte` and `svelte-check`. Slower than Biome but the SvelteKit ecosystem assumes ESLint and the user wants thorough coverage of `.svelte` files.
- **D-04 — Vitest.** Standard in the SvelteKit/Vite world, watch mode, mocking out of the box. Playwright deferred to a later phase if true e2e is needed.

### Better Auth & User Model

- **D-05 — Database-backed sessions, not JWE cookies.** A row in a `sessions` table per login; the cookie carries only `session_id`. Server can invalidate instantly (logout, "sign out from all devices", security incident). Required for the audit log to be honest about active sessions.
- **D-06 — UUID v7 for every primary key.** `users.id`, `sessions.id`, `audit_logs.id`, and every Phase-2+ table. Time-sortable (indexes behave like int), enumeration-safe (no leaking "you have 47 users"), self-host export friendly. Use `pg` extension or app-side generation; pick during planning based on Drizzle support.
- **D-07 — Minimum user record on first sign-in.** `users { id, email, name, image_url, google_sub, created_at, updated_at }` only. No empty-`settings` row, no per-user defaults pre-populated — Phase 2 owns that. Avoid scope creep.
- **D-08 — "Sign out from all devices" ships in Phase 1.** Settings button deletes all `sessions` rows for the current `user_id`. Free security win once DB sessions exist; defers nothing.

### Envelope Encryption

- **D-09 — Random DEK per row + KEK-wrapped.** `crypto.randomBytes(32)` per secret. The DEK encrypts the secret with AES-256-GCM (12-byte nonce + 16-byte tag). The KEK wraps the DEK (also AES-256-GCM). Both `wrapped_dek` (with its own nonce/tag) and `ciphertext` (with its own nonce/tag) are stored on the secret row. Rotation re-wraps DEKs only — does not touch ciphertext payloads.
- **D-10 — `kek_version` column on every encrypted row.** Server reads `KEK_V1`, `KEK_V2`, … from env; column tells server which KEK to use for unwrap. Rotation procedure: load `KEK_V2`, background job iterates `kek_version=1` rows and re-wraps DEK to `kek_version=2`, then `KEK_V1` env is dropped. Online and reversible.
- **D-11 — Encryption scope: user-supplied API keys + OAuth refresh tokens.** Specifically: future YouTube Data API key, Steam Web API key, Reddit OAuth refresh token, any Reddit OAuth-app client secret if the user supplies one. Not encrypted: PII (email, name) — leaves search/analytics functional and the threat model from Google-OAuth-only login does not justify it. The Phase 1 schema does not yet have a `secrets` table; the encryption module is built and unit-tested in Phase 1, the table arrives in Phase 2.
- **D-12 — Audit on add / rotate / remove only.** Per-decryption logging would produce 100k+ rows/day with no incident-response value. Add/rotate/remove is captured by Phase-2's KEYS-06 requirement. Phase 1 wires up the audit framework so Phase 2 has a ready writer.

### Self-Host CI Gate

- **D-13 — Better Auth test mode for OAuth in CI.** Use Better Auth's built-in dev / test provider configured via env flag. No external mock OIDC server. Less moving parts in CI; failures point at our code, not at a mock infrastructure issue. **(See `<deviations>` block below — D-13 mechanism updated 2026-04-27 to use `oauth2-mock-server` because Better Auth 1.6.x does not expose a built-in test provider; intent is preserved.)**
- **D-14 — SaaS-leak detection: grep + runtime checks.** (1) CI grep for hardcoded admin emails, telemetry beacon URLs, Cloudflare-only headers without graceful fallback (`CF-*` referenced outside trusted-proxy module). (2) Smoke test boots the image with a minimal env (no `CF_*`, no `ANALYTICS_*`) and asserts startup succeeds. Both gates fail the PR.
- **D-15 — Smoke test asserts: boot in 3 roles + login → dashboard + cross-tenant 404 + anonymous 401.** Concretely:
  1. `docker run -e APP_ROLE=app …` boots, `/healthz` returns 200, `/readyz` returns 200 once migrations finish.
  2. `docker run -e APP_ROLE=worker …` boots without errors and prints "worker ready".
  3. `docker run -e APP_ROLE=scheduler …` boots without errors and prints "scheduler ready".
  4. Sign in via Better Auth test mode as user A → land on dashboard scoped to A.
  5. Create a stub resource as user A; sign in as user B; request user A's resource → 404 (not 403, never 200).
  6. Anonymous request to any protected route → 401.
- **D-16 — Postgres in CI: service container.** GitHub Actions `services: postgres:16-alpine`. Fresh DB per run, no docker-in-docker complexity. `DATABASE_URL` injected via env.

### i18n

- **D-17 — Paraglide compiled messages, no locale detection in MVP.** All UI strings flow through `m.welcome()`-style imports compiled from `messages/en.json`. Server renders English unconditionally. No URL-prefix routing, no `Accept-Language` parsing, no cookie. Adding `ru.json` later is content-only.
- **D-18 — Single `messages/en.json` at repo root.** Not split by feature in Phase 1. If the file grows past ~500 keys, split later — premature to organize now.

### Trusted-Proxy & Audit IP

- **D-19 — Trusted-proxy header handling lands in Phase 1.** Audit log writes IP from Phase 1 (Phase-2 KEYS-06 requires it). A stub `req.ip` would record the proxy IP forever and rewriting old rows is messy. DEPLOY-02 in Phase 6 only formalizes documentation and adds the explicit deploy-parity success criteria; the implementation lives here.
- **D-20 — `TRUSTED_PROXY_CIDR` env (CIDR list).** Env var carries a comma-separated CIDR list (default empty = trust nothing, real IP = direct socket peer). Middleware walks `X-Forwarded-For` from the right, dropping entries whose source matches a trusted CIDR; first untrusted-source entry is the real client IP. Same mechanism for `CF-Connecting-IP`. Values:
  - SaaS on aeza behind CF: `2400:cb00::/32,2606:4700::/32,…` (Cloudflare ranges) plus the Docker network range (`172.16.0.0/12`) so the app trusts the local proxy if any.
  - Self-host bare: empty (use socket peer).
  - Self-host behind nginx/Caddy: `127.0.0.1/32` plus loopback.

### Health, Docker, Logs

- **D-21 — `/healthz` + `/readyz` separate endpoints.** `/healthz` always 200 once the process is up (pure liveness). `/readyz` returns 200 only when DB connection works and migrations are at the latest. Docker healthcheck binds to `/readyz`. Cloudflare Tunnel polls `/healthz` to avoid restart loops during slow startup.
- **D-22 — `node:22-alpine` base image, multi-stage build.** Stages: `deps` (install) → `build` (compile SvelteKit + tsx for worker entrypoints) → `runtime` (copy `dist/` + production `node_modules`, run as non-root user). Target image size ~150–200 MB. Alpine chosen over `bookworm-slim` because no native-deps requirement is anticipated for Phase 1 / Phase 2; flag for revisit if Phase 3 wants `sharp` or another musl-fragile lib.
- **D-23 — Pino, stdout JSON in prod, pretty in dev.** Single logger configured in `src/lib/logger.ts`. `LOG_LEVEL` env (`debug|info|warn|error`, default `info` in prod, `debug` in dev). Use `pino-pretty` only in dev (`NODE_ENV=development`). All logs go to stdout — Docker / Loki picks them up; no file output.
- **D-24 — Pino redaction paths for known secret-shaped keys.** Configure once at logger init: `redact: ['*.password','*.api_key','*.apiKey','*.access_token','*.accessToken','*.refresh_token','*.refreshToken','*.secret','*.encrypted_*','*.wrapped_dek','*.dek','req.headers.authorization','req.headers.cookie']`. Plus a project lint rule (or convention enforced in CI grep) that bans direct `process.env.*` access outside `src/lib/config/` so KEK-style secrets cannot leak via accidental `console.log`.

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

### Folded Todos

None — no pending todos matched Phase 1.

</decisions>

<deviations>
## Decision Deviations Recorded During Planning

Mechanism updates accepted by the user that adjust HOW a locked decision is implemented while preserving the original INTENT. Future agents reading CONTEXT.md should treat these as authoritative refinements of the corresponding D-NN.

- **D-13 mechanism update (2026-04-27).** D-13's INTENT was "mocked OAuth in CI, no external SaaS dependency, failures point at our code" — that is preserved. The LITERAL mechanism ("Better Auth's built-in dev / test provider") does not exist in Better Auth 1.6.x. Substitute mechanism: **`oauth2-mock-server` (npm package)**, run as a sidecar on `localhost:9090` during the CI smoke job and during integration tests. Better Auth's Google provider is pointed at the mock issuer URL via env (`GOOGLE_ISSUER_URL` if Better Auth exposes the knob, otherwise the mock server is configured to mint id_tokens with `iss: 'https://accounts.google.com'`). User accepted this substitution on 2026-04-27 (no checkpoint required). Plans 05 and 10 reference D-13 = `oauth2-mock-server`.

- **Phase 1 DEPLOY-05 scope (2026-04-27).** D-15 success criterion #4 originally read "Self-host CI smoke test passes on every PR: boots the image with minimal env, signs in via OAuth mock, **creates a game, runs a poll stub**, and asserts no SaaS-only assumption leaked." The "creates a game" and "runs a poll stub" clauses are deferred: Phase 1 has no game model (Phase 2 lands GAMES-01) and no poll worker handlers (Phase 3 lands POLL-01..06). Phase 1 smoke covers boot + auth happy path + tenant scope hold + all three roles dispatch + i18n message resolution + no SaaS-only assumption. Phase 2 extends smoke to "create a game"; Phase 3 to "run a poll stub". User accepted this scope on 2026-04-27. ROADMAP Phase 1 SC#4 has been updated to match.

</deviations>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project context
- `.planning/PROJECT.md` — Locked product context, security posture, indie-budget constraint, distribution model
- `.planning/REQUIREMENTS.md` — REQ-IDs in scope for Phase 1: AUTH-01, AUTH-02, AUTH-03, PRIV-01, UX-04, DEPLOY-05
- `.planning/ROADMAP.md` §"Phase 1: Foundation" — Goal, success criteria, dependencies

### Research (read before planning)
- `.planning/research/STACK.md` — Stack picks (Hono / SvelteKit / Drizzle / pg-boss / Better Auth / node:crypto), versions, license risks. Better Auth replaces deprecated Lucia v3.
- `.planning/research/ARCHITECTURE.md` §"Build Order Tier 0" — Foundation components order; §"Pattern 1 (Tenant Scope)" — middleware sketch; §"KEK / DEK Lifecycle" — envelope encryption flow with rotation; §"Pattern 5 (Trusted Proxy)" — header handling sketch; §"SaaS vs Self-Host Deltas" — env-driven differences
- `.planning/research/PITFALLS.md` — P1 (cross-tenant data leak), P2 (KEK leakage), P3 (DTO discipline), P13 (self-host parity rot), P14 (AGPL contamination), P18 (accidental public mode), P19 (audit log scoping), P20 (operator compromise) — all address Phase 1 territory

### External (verify versions during planning)
- Better Auth Google OAuth: https://better-auth.com/docs/authentication/google
- Better Auth Drizzle adapter: https://better-auth.com/docs/adapters/drizzle
- Drizzle ORM: https://orm.drizzle.team/docs/
- Paraglide JS for SvelteKit: https://inlang.com/m/gerre34r/library-inlang-paraglideJs/sveltekit
- Node.js crypto (AES-256-GCM): https://nodejs.org/api/crypto.html
- pino redact: https://getpino.io/#/docs/redaction
- Cloudflare IP ranges: https://www.cloudflare.com/ips/

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

This is a greenfield project. No existing code to reuse. The Phase 1 plan is a clean scaffold.

### Established Patterns

None yet — Phase 1 establishes them. Patterns to plant carefully because every later phase inherits them:

- **Tenant scoping by convention + types** (ARCHITECTURE.md Pattern 1). Every service function takes `userId: string` as the first argument; every Drizzle query that touches a user-owned table includes `eq(table.userId, userId)`. HTTP middleware refuses to invoke any service function without a session-derived `userId`. This is the single most important pattern to get right in Phase 1; retrofitting is the predictable P1 (data leak) path.
- **Envelope encryption invocation discipline.** Plaintext lives in memory only inside the encrypt/decrypt helpers, never in service-level variables; helpers accept ciphertext and return ciphertext for storage; secret values are never logged (Pino redact + env-discipline lint rule from D-24).
- **Strict env discipline.** All env reads go through `src/lib/config/env.ts` (zod-validated, typed). No raw `process.env.X` outside that module. Prevents KEK-style secrets leaking via accidental `console.log` and gives one place to test config.

### Integration Points

- `Dockerfile` `ENTRYPOINT` dispatches on `APP_ROLE` to one of three Node entrypoints.
- SvelteKit `src/hooks.server.ts` is where Better Auth handler mounts and where the trusted-proxy / tenant-scope middleware chain lives.
- `src/lib/db/schema.ts` is the single source of truth for Drizzle migrations — Phase 1 creates `users`, `sessions`, `accounts` (Better Auth tables) and `audit_logs`.

</code_context>

<specifics>
## Specific Ideas

- **"Free-tier mindset"** — every infra decision in this phase respects the "indie zero budget" constraint. No managed KMS, no paid CI tier, no external mock OIDC server. Better Auth test mode + Postgres service container fits.
- **"Self-host parity is a CI gate, not a doc"** — DEPLOY-05's CI smoke test is what enforces parity for every later phase. The user's mental model is "if CI green, self-host operator gets the same image and behavior." This is the load-bearing trust signal for the open-source angle (PROJECT.md).
- **"Audit IP must be real from day one"** — the user repeatedly returned to "what if data leaks / what if my key leaks"; an audit log that says "the attacker came from `127.0.0.1`" is worse than no audit log. Trusted-proxy lands in Phase 1 specifically to keep this honest.

</specifics>

<deferred>
## Deferred Ideas

- **Cloudflare Tunnel-specific deploy guide** — Phase 6 (DEPLOY docs).
- **THIRD_PARTY_LICENSES.md and AGPL CI gate** — Phase 6 (PITFALL P14).
- **KEK rotation runbook + rehearsal** — Phase 6 (PITFALL P20). The mechanism (kek_version, re-wrap job) is built in Phase 1, but the procedure document, the rehearsal, and the operator drill are Phase 6.
- **Backups, monitoring, alerting** — Phase 6 polish.
- **Per-user TOTP / 2FA** — already excluded in PROJECT.md; not revived.
- **Multi-language UI** — i18n structure ready in Phase 1 but additional locales are post-MVP content additions.
- **Account deletion flow** — Phase 6 (PRIV-04).
- **Service-side rate limiting** — out of scope for Phase 1; rely on Cloudflare Free WAF and revisit when needed.
- **Health/ready endpoint authn** — `/healthz` and `/readyz` are unauthenticated by design (PRIV-01 explicitly excludes them from "every endpoint refuses anonymous"). Document this exception in plan-phase.

### Reviewed Todos (not folded)

None.

</deferred>

---

*Phase: 01-foundation*
*Context gathered: 2026-04-27*
*Revision 1: 2026-04-27 — appended `<deviations>` block (D-13 mechanism, DEPLOY-05 scope) per checker iteration 1.*
