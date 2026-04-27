---
phase: 1
slug: foundation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-27
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.x (unit + integration), Playwright 1.50+ (smoke), GitHub Actions (CI) |
| **Config file** | `vitest.config.ts` (Wave 0 installs); `playwright.config.ts` (Wave 0 installs); `.github/workflows/smoke.yml` (Wave 0 installs) |
| **Quick run command** | `npm run test:unit` (vitest, no DB) |
| **Full suite command** | `npm run test` (unit + integration + smoke) |
| **Estimated runtime** | ~5 minutes (smoke ≤ 5 min hard cap; unit < 30s; integration ~90s) |

---

## Sampling Rate

- **After every task commit:** Run `npm run test:unit` (no DB, fast feedback)
- **After every plan wave:** Run `npm run test` (full integration + smoke)
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds for unit feedback; 5 minutes for full suite

---

## Per-Task Verification Map

> Filled by gsd-planner. Every task in every PLAN.md must map to a row here with a concrete automated command OR an entry in Manual-Only.

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 1-XX-XX | XX | N | REQ-XX | unit/integration/smoke | `{command}` | ✅ / ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Wave 0 must land before any feature task. Per RESEARCH.md, Phase 1 Wave 0 covers the test scaffolding for all six phase requirements:

- [ ] `package.json` — install vitest@4, @vitest/coverage-v8, playwright@1.50+, supertest, oauth2-mock-server
- [ ] `vitest.config.ts` — projects split: unit (no setup), integration (with DB fixture)
- [ ] `tests/setup/db.ts` — per-test transactional Postgres fixture (BEGIN; SAVEPOINT; rollback) using a dedicated `test_*` schema
- [ ] `tests/setup/oauth.ts` — `oauth2-mock-server` lifecycle helpers (start/stop, mint id_token for fixture user)
- [ ] `tests/fixtures/users.ts` — seed helpers: `seedUser(email, googleSub)` returning a Better Auth session cookie
- [ ] `tests/unit/encryption.test.ts` — KEK→DEK→plaintext round-trip stub for AUTH-03 / PRIV-01
- [ ] `tests/integration/auth.test.ts` — anonymous-401 + authenticated-200 stubs for AUTH-01, AUTH-02
- [ ] `tests/integration/tenant-scope.test.ts` — cross-tenant 404 stub for PRIV-01
- [ ] `tests/integration/i18n.test.ts` — Paraglide message resolution stub for UX-04
- [ ] `tests/smoke/selfhost.smoke.spec.ts` — boots Docker image, asserts 5-step happy path for DEPLOY-05
- [ ] `.github/workflows/ci.yml` — runs unit + integration + smoke on every PR; fails on red
- [ ] `.github/workflows/smoke.yml` (or job in ci.yml) — service container Postgres 16; builds image; runs smoke
- [ ] Drizzle test-DB migration runner (programmatic `migrate()` against `test_*` schema)

---

## Manual-Only Verifications

Phase 1 has no purely manual gates — every success criterion in ROADMAP.md is automatable. Listed only for traceability:

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| (none — all behaviors have automated coverage) | — | — | — |

*All phase behaviors have automated verification.*

---

## Testable Behaviors (from RESEARCH.md §Validation Architecture)

The 20 testable behaviors below come from RESEARCH.md and map back to ROADMAP success criteria + REQ-IDs. The planner must ensure every plan touches at least one of these via Per-Task Verification Map.

### Auth happy path (AUTH-01, AUTH-02 → SC#1, SC#2)
1. **OAuth login mints session cookie** — integration: oauth2-mock-server → `/api/auth/callback/google` → assert `__Secure-better-auth.session_token` cookie set, HTTP-only, Secure, SameSite=Lax.
2. **Authenticated request returns 200 + correct user_id** — integration: with cookie, `GET /api/me` → 200 with the seeded user.
3. **Sign-out invalidates session** — integration: `POST /api/auth/signout` → cookie cleared; revisiting protected page redirects to login.
4. **Existing user resumes data; new user gets empty dashboard** — integration: two seeded users; second login returns prior data, fresh login returns empty set.

### Anonymous-401 invariant (AUTH-01 → SC#3)
5. **Every protected route returns 401 without cookie** — parameterized integration: enumerate all routes from Hono `app.routes`; for each, `fetch` with no cookie → assert 401 (or 302 to login for SvelteKit pages).
6. **No public dashboard / share-link / read-only viewer route exists** — integration: grep route table for `public:true`-style markers; assert empty.

### Cross-tenant 404 (PRIV-01 → SC#2)
7. **User A cannot read user B's resource — returns 404** — integration: seed user A + B; A authenticates; `GET /api/games/{B's game id}` → 404 (NOT 403, NOT 500). (Per CLAUDE.md: 404 not 403 to avoid leaking existence.)
8. **User A cannot write to user B's resource — returns 404** — integration: same setup, `PATCH /api/games/{B's id}` → 404.
9. **User A cannot delete user B's resource — returns 404** — integration: `DELETE` → 404.

### Envelope encryption round-trip (AUTH-03, PRIV-01)
10. **KEK→DEK wrap then unwrap returns identical DEK** — unit: pure function test in `tests/unit/encryption.test.ts`.
11. **DEK encrypts plaintext then decrypts identical plaintext** — unit: AES-256-GCM round-trip with random nonce.
12. **Auth-tag mismatch causes decrypt to throw** — unit: tamper with ciphertext, assert thrown error (no silent corruption).
13. **Missing/short KEK env var fails fast at boot** — unit: launch helper with bad `APP_KEK_BASE64` → assert process exit / thrown error before HTTP server binds.

### Migration ordering (DEPLOY-05)
14. **Migrations run before HTTP server binds** — integration: spawn app role with fresh DB; assert migrations table populated before `/healthz` returns 200.
15. **Concurrent containers don't race migrations** — integration: spawn 2 app role containers simultaneously; assert advisory lock prevents double-apply (only one runs migrate, both see final schema).

### Self-host smoke (DEPLOY-05 → SC#4)
16. **5-step happy path on built image** — Playwright/smoke: boot image with minimal env (`APP_KEK_BASE64`, `DATABASE_URL`, `GOOGLE_CLIENT_ID/SECRET`), mock OAuth login, create game row, run pg-boss poll job stub, assert tenant scoping holds. ≤ 5 min runtime.
17. **No SaaS-only assumption leaked** — smoke: assert no env vars from SaaS-only profile (e.g. `CLOUDFLARE_*`, `LOKI_URL`) are required for boot; minimal env list passes.

### i18n structure (UX-04 → SC#5)
18. **Paraglide message function resolves at runtime** — integration: render `+page.svelte` containing `{m.dashboard_title()}`; assert string in HTML.
19. **Adding a locale = drop a JSON file** — unit: place `messages/ru.json` in fixture, run Paraglide compile, assert generated output includes new locale; no source-code changes required.

### Trusted-proxy headers (DEPLOY-05)
20. **X-Forwarded-For respected only from trusted CIDR** — unit: middleware test with two requests — one from a trusted IP with `X-Forwarded-For: 1.2.3.4` (resolves to 1.2.3.4); one from an untrusted IP with same header (resolves to socket addr). Confirms CVE-2026-27700 mitigation.

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags (`--watch`, `--ui`) in CI commands
- [ ] Feedback latency < 30s for unit; < 5 min for full suite
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
