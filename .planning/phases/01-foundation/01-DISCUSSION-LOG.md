# Phase 1: Foundation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-27
**Phase:** 01-foundation
**Areas discussed:** Repo & tooling, Better Auth + user model, Envelope encryption, Self-host CI gate, i18n setup, Trusted-proxy + audit IP, Health/ready + Docker, Logging + redaction

---

## Repo & Tooling

### Workspace layout

| Option | Description | Selected |
|--------|-------------|----------|
| Flat single package | One `package.json`. SvelteKit at root. Worker/scheduler are tsx entrypoints in same code. Solo-friendly. | ✓ |
| pnpm workspaces (apps/*) | apps/web + apps/worker + packages/shared. Stricter dep isolation. More boilerplate. | |

**User's choice:** Flat single package (after explanation of both options).
**Notes:** User initially asked for clarification on what workspaces are. Once explained that "one image → three roles" matches the flat layout naturally, they picked flat.

### Package manager

| Option | Description | Selected |
|--------|-------------|----------|
| pnpm | Strict dep resolution, faster CI, workspace-friendly | ✓ |
| npm | Standard Node.js, no install needed | |
| bun | Fast but production-immature for indie Node servers | |

**User's choice:** pnpm.

### Linter / formatter

| Option | Description | Selected |
|--------|-------------|----------|
| Biome | Single tool, ~10× faster, popular 2025–2026. Less mature `.svelte` coverage. | |
| ESLint + Prettier | Standard. eslint-plugin-svelte + svelte-check. Slower, more configs, better Svelte coverage. | ✓ |

**User's choice:** ESLint + Prettier.
**Notes:** User picked thorough Svelte coverage over Biome's speed.

### Test runner

| Option | Description | Selected |
|--------|-------------|----------|
| Vitest | SvelteKit-ecosystem standard, watch mode, snapshot, mocks | ✓ |
| node:test (built-in) | No deps, in Node 22 LTS. Less rich API. | |

**User's choice:** Vitest.

---

## Better Auth + User Model

### Session storage

| Option | Description | Selected |
|--------|-------------|----------|
| DB sessions | Row in `sessions` per login. Cookie carries only `session_id`. Server can invalidate instantly. | ✓ |
| JWE cookies (stateless) | All session data encrypted in cookie. No DB hit per request, but cannot revoke instantly. | |

**User's choice:** DB sessions.

### Primary key type

| Option | Description | Selected |
|--------|-------------|----------|
| UUID v7 | Time-sortable (indexes behave like int), enumeration-safe, exportable. 2025 standard. | ✓ |
| bigint serial | Simple indexes, 8 bytes. Leaks user count via URLs. | |

**User's choice:** UUID v7.

### First-sign-in user record

| Option | Description | Selected |
|--------|-------------|----------|
| Minimum | users {id, email, name, image_url, google_sub, timestamps} only. | ✓ |
| + defaults | Empty settings row, default tz/theme. | |

**User's choice:** Minimum.

### "Sign out from all devices"

| Option | Description | Selected |
|--------|-------------|----------|
| Yes (Phase 1) | Settings button deletes all sessions for `user_id`. Free win once DB sessions exist. | ✓ |
| Defer to Phase 6 | Only normal logout in Phase 1. | |

**User's choice:** Yes — ship in Phase 1.

---

## Envelope Encryption

### DEK generation

| Option | Description | Selected |
|--------|-------------|----------|
| Random + wrap | DEK = random 32 bytes per secret. KEK wraps DEK via AES-GCM. Rotation = re-wrap only. NIST SP 800-57. | ✓ |
| HKDF from KEK + row_id | DEK derived deterministically. No wrapped_dek stored. Rotation requires decrypt + re-encrypt of all rows. | |

**User's choice:** Random + wrap.

### Key versioning

| Option | Description | Selected |
|--------|-------------|----------|
| `kek_version` column | Each secret stores `kek_version`. Server has `KEK_V1`, `KEK_V2`, … in env. Online rotation. | ✓ |
| Single live KEK | Rotation = full maintenance window. | |

**User's choice:** `kek_version` column.

### Encryption scope

| Option | Description | Selected |
|--------|-------------|----------|
| API keys + OAuth tokens | User-supplied API keys (YouTube, Steam) AND OAuth refresh tokens (Reddit). One mechanism, one test. PII not encrypted. | ✓ |
| API keys only | OAuth refresh tokens stored plaintext. Bad for security-conscious indie. | |
| Everything + PII | Adds email/name encryption. Breaks search; overkill for Google-OAuth-only login. | |

**User's choice:** API keys + OAuth tokens.

### Decryption audit

| Option | Description | Selected |
|--------|-------------|----------|
| add/rotate/remove only | Captures KEYS-06 events. Per-decrypt logging would produce noise without value. | ✓ |
| Every decrypt | Full paranoid; massive log volume. | |
| None | No audit trail for incident response. | |

**User's choice:** add/rotate/remove only.

---

## Self-Host CI Gate

### OAuth mock

| Option | Description | Selected |
|--------|-------------|----------|
| Better Auth test mode | Built-in dev/test provider. Env flag enables mock login. No external server. | ✓ |
| Mock OIDC server | Dex/Hydra as service container. Closer to prod, more setup. | |

**User's choice:** Better Auth test mode.

### SaaS-leak detection

| Option | Description | Selected |
|--------|-------------|----------|
| Grep + runtime checks | (1) CI grep for hardcoded admin email/telemetry/CF-only headers. (2) Runtime: boot without CF_*/ANALYTICS_* env, assert success. | ✓ |
| Grep only | Cheap, misses runtime issues. | |
| Runtime only | Misses hardcoded helpers. | |

**User's choice:** Grep + runtime checks.

### Smoke test scope (multi-select)

| Option | Description | Selected |
|--------|-------------|----------|
| Boot in 3 roles | APP_ROLE=app/worker/scheduler each boot, expose /healthz. | ✓ |
| Login → dashboard | Mock OAuth → land on dashboard scoped to user_id. | ✓ |
| Cross-tenant test | userA creates resource, userB requests it → 404 not 403. | ✓ |
| Anonymous → 401 | Every protected route refuses anonymous (401). | ✓ |

**User's choice:** All four (after clarification on roles).
**Notes:** User initially picked 3 of 4 because they didn't understand "boot in 3 roles". After explanation that one image runs as app/worker/scheduler via APP_ROLE env, they added it.

### Postgres in CI

| Option | Description | Selected |
|--------|-------------|----------|
| Service container | GitHub Actions `services: postgres:16-alpine`. Standard. | ✓ |
| Testcontainers in tests | Pg inside vitest via docker-api. Needs docker-in-docker. | |
| pg-mem (in-memory) | JS Postgres emulator. Limited SQL, won't work with pg-boss. | |

**User's choice:** Service container.

---

## i18n Setup

### Locale strategy in MVP

| Option | Description | Selected |
|--------|-------------|----------|
| None (EN only) | Paraglide compiles, server renders EN unconditionally. Adding ru.json later is content-only. | ✓ |
| Cookie + UI override | Locale switcher works even at EN-only. Adds complexity without payoff in MVP. | |
| URL prefix `/en/` | Explicit locale routing. Overkill for private diary. | |

**User's choice:** None.

### Message location

| Option | Description | Selected |
|--------|-------------|----------|
| `messages/en.json` | One JSON per locale at root. Paraglide compiles to typed TS functions. | ✓ |
| `messages/<feature>/en.json` | Split by feature. Better at very large scale; overkill now. | |

**User's choice:** Single `messages/en.json`.

---

## Trusted-Proxy + Audit IP

### Timing

| Option | Description | Selected |
|--------|-------------|----------|
| Phase 1 (now) | Audit log writes IP from Phase 1; without trusted-proxy, IP is wrong from day one. DEPLOY-02 in Phase 6 only formalizes docs. | ✓ |
| Stub now, full in Phase 6 | `req.ip` as-is now; rewrite later. Old audit rows would have proxy IPs. | |

**User's choice:** Phase 1.

### Configuration model

| Option | Description | Selected |
|--------|-------------|----------|
| `TRUSTED_PROXY_CIDR` env | Comma-separated CIDR list. Same mechanism for SaaS and self-host. | ✓ |
| `TRUST_PROXY=1/0` | Boolean "trust first header". Spoofable on misconfigured deploys. | |

**User's choice:** `TRUSTED_PROXY_CIDR` env.

---

## Health / Ready + Docker

### Health endpoints

| Option | Description | Selected |
|--------|-------------|----------|
| `/healthz` + `/readyz` | Liveness vs readiness. Docker → /readyz. CF Tunnel → /healthz. K8s-friendly. | ✓ |
| Single `/healthz` | Cannot distinguish "restart me" from "not ready yet". | |

**User's choice:** `/healthz` + `/readyz`.

### Docker base image

| Option | Description | Selected |
|--------|-------------|----------|
| node:22-alpine + multi-stage | ~150-200 MB final. Standard for Node 2025. | ✓ |
| distroless | ~80 MB. No shell — debug nearly impossible for solo operator. | |
| node:22-bookworm-slim | Debian, ~180 MB. Safer with native deps; not anticipated for Phase 1. | |

**User's choice:** node:22-alpine + multi-stage.

---

## Logging + Redaction

### Redaction approach

| Option | Description | Selected |
|--------|-------------|----------|
| Pino redaction paths | dotted-paths for known secret-shaped keys. Standard. | ✓ |
| Pino + custom serializers | Per-type serializers. More flexible, more code. | |
| Ban process.env outside config/ | Not redaction; lint discipline. Combined with first option. | |

**User's choice:** Pino redaction paths.
**Notes:** The "ban process.env outside config/" complement was folded into D-24 as a code convention even though not selected as primary option.

### Log destination

| Option | Description | Selected |
|--------|-------------|----------|
| stdout JSON in prod, pretty in dev | docker logs / Loki picks up JSON. pino-pretty in dev. | ✓ |
| Files at /var/log/app/*.log | Container anti-pattern. | |

**User's choice:** stdout JSON in prod, pino-pretty in dev.

---

## Claude's Discretion

Areas left for the planner to decide:
- Drizzle config: `drizzle-kit generate` vs `push`
- pg pool sizing and shared-pool strategy with pg-boss
- Specific eslint-config-* package and Prettier formatting rules
- pino-pretty configuration knobs
- Test fixture/factory shape
- Non-root user UID inside the image
- CI provider (assume GitHub Actions unless reason otherwise)
- /healthz / /readyz exact response payload format

## Deferred Ideas

- Cloudflare Tunnel deploy guide → Phase 6
- THIRD_PARTY_LICENSES.md and AGPL CI gate → Phase 6
- KEK rotation runbook + rehearsal → Phase 6 (mechanism in Phase 1, procedure later)
- Backups, monitoring, alerting → Phase 6
- Account deletion flow → Phase 6
- Service-side rate limiting → out of scope for Phase 1
- Health/ready endpoint authn → unauthenticated by design (document the exception)
