---
phase: 1
slug: foundation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-27
revised: 2026-04-27
revision_note: "Iteration 1 — applied checker fixes (BLOCKERS 1-7, W1-W4, INFO I2). See plans 01-03, 01-05, 01-06, 01-07, 01-08, 01-10 and CONTEXT.md <deviations>."
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
>
> **Provisional ownership map (revision 1, 2026-04-27).** Plan 10 Task 3 finalizes this map during execution and flips the frontmatter to `nyquist_compliant: true`. The rows below reflect ownership after checker iteration 1 fixes were applied to Plans 03, 05, 06, 07, 08, 10. Note in particular: PT1-PT6 are now SIX rows (Plan 06 owns all six in-plan, NOT deferred to Plan 07); VALIDATION 8/9 are explicitly DEFERRED to Phase 2.

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 1-01-01 | 01 | 1 | DEPLOY-05 | structural | node -e (package.json pin grep) | ✅ W0 | ⬜ pending |
| 1-01-02 | 01 | 1 | DEPLOY-05 | structural | node -e (env+logger+ids grep) | ✅ W0 | ⬜ pending |
| 1-02-01 | 02 | 1 | DEPLOY-05 | structural | node -e (test scaffolding files exist) | ✅ W0 | ⬜ pending |
| 1-02-02 | 02 | 1 | DEPLOY-05 | structural | node -e (Dockerfile + ci.yml grep) | ✅ W0 | ⬜ pending |
| 1-03-01 | 03 | 2 | AUTH-01/02/03/DEPLOY-05 | structural | node -e (schema + migrate grep, includes BIGINT decimal comment per W2) | ✅ W0 | ⬜ pending |
| 1-03-02 | 03 | 2 | DEPLOY-05 | integration | `pnpm vitest run tests/integration/migrate.test.ts -t "idempotent"` | ✅ W0 | ⬜ pending |
| 1-03-02b | 03 | 2 | DEPLOY-05 | integration | `pnpm vitest run tests/integration/migrate.test.ts -t "advisory lock"` | ✅ W0 | ⬜ pending |
| 1-04-01-RT1 | 04 | 2 | AUTH-03 | unit | `pnpm vitest run tests/unit/encryption.test.ts -t "RT1"` — round-trip plaintext (VALIDATION 10/11) | ✅ | ✅ active |
| 1-04-01-RT2 | 04 | 2 | AUTH-03 | unit | `pnpm vitest run tests/unit/encryption.test.ts -t "RT2"` — round-trip empty string | ✅ | ✅ active |
| 1-04-01-RT3 | 04 | 2 | AUTH-03 | unit | `pnpm vitest run tests/unit/encryption.test.ts -t "RT3"` — round-trip 4KB unicode (UTF-8 multi-byte) | ✅ | ✅ active |
| 1-04-01-U1 | 04 | 2 | AUTH-03 | unit | `pnpm vitest run tests/unit/encryption.test.ts -t "U1"` — same plaintext → different ciphertexts (random DEK + nonce) | ✅ | ✅ active |
| 1-04-01-T1 | 04 | 2 | AUTH-03 | unit | `pnpm vitest run tests/unit/encryption.test.ts -t "T1"` — tampered secretCt throws (VALIDATION 12) | ✅ | ✅ active |
| 1-04-01-T2 | 04 | 2 | AUTH-03 | unit | `pnpm vitest run tests/unit/encryption.test.ts -t "T2"` — tampered secretTag throws (VALIDATION 12) | ✅ | ✅ active |
| 1-04-01-T3 | 04 | 2 | AUTH-03 | unit | `pnpm vitest run tests/unit/encryption.test.ts -t "T3"` — tampered wrappedDek throws (KEK→DEK auth tag) | ✅ | ✅ active |
| 1-04-01-T4 | 04 | 2 | AUTH-03 | unit | `pnpm vitest run tests/unit/encryption.test.ts -t "T4"` — tampered dekTag throws (VALIDATION 12) | ✅ | ✅ active |
| 1-04-01-B1 | 04 | 2 | AUTH-03 | unit | `pnpm vitest run tests/unit/encryption.test.ts -t "B1"` — missing KEK version → "KEK v<n>" error (VALIDATION 13, P2 fail-fast) | ✅ | ✅ active |
| 1-04-01-R1 | 04 | 2 | AUTH-03 | unit | `pnpm vitest run tests/unit/encryption.test.ts -t "R1"` — rotateDek re-wraps DEK only, ciphertext byte-identical (D-10) | ✅ | ✅ active |
| 1-04-01-R2 | 04 | 2 | AUTH-03 | unit | `pnpm vitest run tests/unit/encryption.test.ts -t "R2"` — rotated row decrypts to original plaintext (D-10) | ✅ | ✅ active |
| 1-05-01 | 05 | 3 | AUTH-01/02/03 | structural | node -e (auth.ts + dto.ts grep — BLOCKER 1 / D-13 = oauth2-mock-server reference; INFO I2 issuer-URL knob comment) | ✅ W0 | ✅ active |
| 1-05-02 | 05 | 3 | AUTH-02 | integration | `pnpm vitest run tests/integration/auth.test.ts -t "invalidateSession"` (D-13 = oauth2-mock-server per CONTEXT.md `<deviations>`) | ✅ W0 | ✅ active |
| 1-05-02b | 05 | 3 | AUTH-02 | integration | `pnpm vitest run tests/integration/auth.test.ts -t "all devices"` | ✅ W0 | ✅ active |
| 1-05-02c | 05 | 3 | AUTH-03 | integration | `pnpm vitest run tests/integration/auth.test.ts -t "returning user resumes"` | ✅ W0 | ✅ active |
| 1-06-01-PT1 | 06 | 3 | DEPLOY-05 | unit (middleware) | `pnpm vitest run tests/unit/proxy-trust.test.ts -t "PT1"` — BLOCKER 3 fix: PT1-PT6 owned by Plan 06, NOT deferred | ✅ W0 | ⬜ pending |
| 1-06-01-PT2 | 06 | 3 | DEPLOY-05 | unit (middleware) | `pnpm vitest run tests/unit/proxy-trust.test.ts -t "PT2"` — multi-hop XFF right-to-left walk | ✅ W0 | ⬜ pending |
| 1-06-01-PT3 | 06 | 3 | DEPLOY-05 | unit (middleware) | `pnpm vitest run tests/unit/proxy-trust.test.ts -t "PT3"` — XFF spoofing rejected (CVE-2026-27700) | ✅ W0 | ⬜ pending |
| 1-06-01-PT4 | 06 | 3 | DEPLOY-05 | unit (middleware) | `pnpm vitest run tests/unit/proxy-trust.test.ts -t "PT4"` — CF-Connecting-IP from trusted CF CIDR | ✅ W0 | ⬜ pending |
| 1-06-01-PT5 | 06 | 3 | DEPLOY-05 | unit (middleware) | `pnpm vitest run tests/unit/proxy-trust.test.ts -t "PT5"` — CF header ignored from untrusted source | ✅ W0 | ⬜ pending |
| 1-06-01-PT6 | 06 | 3 | DEPLOY-05 | unit (middleware) | `pnpm vitest run tests/unit/proxy-trust.test.ts -t "PT6"` — X-Forwarded-Proto trust gate (HSTS-relevant) | ✅ W0 | ⬜ pending |
| 1-06-02 | 06 | 3 | DEPLOY-05 | integration | `pnpm vitest run tests/integration/health.test.ts` (also: BLOCKER 4 fix — worker/scheduler stubs at D-01 paths boot cleanly) | ✅ W0 | ⬜ pending |
| 1-07-01 | 07 | 4 | PRIV-01 | structural | node -e (tenant + me + errors grep) | ✅ | ✅ active |
| 1-07-02 | 07 | 4 | PRIV-01 | integration | `pnpm vitest run tests/integration/anonymous-401.test.ts` — BLOCKER 2 fix: vacuous-pass guard (MUST_BE_PROTECTED allowlist + non-empty assertion) | ✅ | ✅ active |
| 1-07-02b | 07 | 4 | PRIV-01 | integration | `pnpm vitest run tests/integration/tenant-scope.test.ts` (VALIDATION 7 active; 8/9 explicitly deferred per W1) | ✅ | ✅ active |
| 1-07-02c | 07 | 4 | PRIV-01 | unit | `pnpm vitest run tests/unit/dto.test.ts` | ✅ | ✅ active |
| 1-07-02d | 07 | 4 | PRIV-01 | integration (deferred) | VALIDATION 8 — cross-tenant WRITE — deferred to Phase 2 (no writable resource in Phase 1) per W1 | n/a | ⬜ deferred |
| 1-07-02e | 07 | 4 | PRIV-01 | integration (deferred) | VALIDATION 9 — cross-tenant DELETE — deferred to Phase 2 (no deletable resource in Phase 1) per W1 | n/a | ⬜ deferred |
| 1-08-01 | 08 | 4 | DEPLOY-05 | structural | node -e (queue-client + worker + scheduler grep) — W4 fix: paths are src/worker/index.ts and src/scheduler/index.ts (D-01) | ✅ W0 | ⬜ pending |
| 1-09-01 | 09 | 4 | UX-04 | structural | node -e (project.inlang + en.json + .svelte grep) | ✅ W0 | ⬜ pending |
| 1-09-02 | 09 | 4 | UX-04 | unit | `pnpm vitest run tests/unit/paraglide.test.ts` | ✅ W0 | ⬜ pending |
| 1-09-02b | 09 | 4 | UX-04 | integration | `pnpm vitest run tests/integration/i18n.test.ts` | ✅ W0 | ⬜ pending |
| 1-10-01 | 10 | 5 | DEPLOY-05/AUTH-01/PRIV-01/UX-04 | smoke | `bash tests/smoke/self-host.sh` (CI only; Phase 1 scope per CONTEXT.md `<deviations>` 2026-04-27; BLOCKER 7 fix: image ENTRYPOINT exercised, no sh -c) | ✅ W0 | ⬜ pending |
| 1-10-02 | 10 | 5 | DEPLOY-05 | manual checkpoint | human-verify CI smoke job log (includes ENTRYPOINT-exercise check per BLOCKER 7) | n/a | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky · ⬜ deferred (deferred to a later phase by user decision; non-blocking)*

---

## Wave 0 Requirements

Wave 0 must land before any feature task. Per RESEARCH.md, Phase 1 Wave 0 covers the test scaffolding for all six phase requirements:

- [ ] `package.json` — install vitest@4, @vitest/coverage-v8, playwright@1.50+, supertest, oauth2-mock-server
- [ ] `vitest.config.ts` — projects split: unit (no setup), integration (with DB fixture)
- [ ] `tests/setup/db.ts` — per-test transactional Postgres fixture (BEGIN; SAVEPOINT; rollback) using a dedicated `test_*` schema
- [ ] `tests/setup/oauth.ts` — `oauth2-mock-server` lifecycle helpers (start/stop, mint id_token for fixture user) — D-13 mechanism per CONTEXT.md `<deviations>` 2026-04-27
- [ ] `tests/fixtures/users.ts` — seed helpers: `seedUser(email, googleSub)` returning a Better Auth session cookie
- [ ] `tests/unit/encryption.test.ts` — KEK→DEK→plaintext round-trip stub for AUTH-03 / PRIV-01
- [ ] `tests/integration/auth.test.ts` — anonymous-401 + authenticated-200 stubs for AUTH-01, AUTH-02
- [ ] `tests/integration/tenant-scope.test.ts` — cross-tenant 404 stub for PRIV-01
- [ ] `tests/integration/i18n.test.ts` — Paraglide message resolution stub for UX-04
- [ ] `tests/smoke/selfhost.smoke.spec.ts` — boots Docker image, asserts Phase-1-scoped happy path for DEPLOY-05 (per 2026-04-27 deferral)
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
5. **Every protected route returns 401 without cookie** — parameterized integration: enumerate all routes from Hono `app.routes`; for each, `fetch` with no cookie → assert 401 (or 302 to login for SvelteKit pages). **Vacuous-pass guard added (Plan 07 revision 1):** test asserts `protectedPaths.toContain('/api/me')` AND `protectedRoutes.length >= 1`.
6. **No public dashboard / share-link / read-only viewer route exists** — integration: grep route table for `public:true`-style markers; assert empty.

### Cross-tenant 404 (PRIV-01 → SC#2)
7. **User A cannot read user B's resource — returns 404** — integration: seed user A + B; A authenticates; `GET /api/games/{B's game id}` → 404 (NOT 403, NOT 500). (Per CLAUDE.md: 404 not 403 to avoid leaking existence.) Phase 1 sentinel via audit_log.
8. **User A cannot write to user B's resource — returns 404** — integration: same setup, `PATCH /api/games/{B's id}` → 404. **DEFERRED to Phase 2** (no writable resource in Phase 1) per W1; Plan 07 ships an `it.skip` with this exact annotation.
9. **User A cannot delete user B's resource — returns 404** — integration: `DELETE` → 404. **DEFERRED to Phase 2** (no deletable resource in Phase 1) per W1.

### Envelope encryption round-trip (AUTH-03, PRIV-01)
10. **KEK→DEK wrap then unwrap returns identical DEK** — unit: pure function test in `tests/unit/encryption.test.ts`.
11. **DEK encrypts plaintext then decrypts identical plaintext** — unit: AES-256-GCM round-trip with random nonce.
12. **Auth-tag mismatch causes decrypt to throw** — unit: tamper with ciphertext, assert thrown error (no silent corruption).
13. **Missing/short KEK env var fails fast at boot** — unit: launch helper with bad `APP_KEK_BASE64` → assert process exit / thrown error before HTTP server binds.

### Migration ordering (DEPLOY-05)
14. **Migrations run before HTTP server binds** — integration: spawn app role with fresh DB; assert migrations table populated before `/healthz` returns 200.
15. **Concurrent containers don't race migrations** — integration: spawn 2 app role containers simultaneously; assert advisory lock prevents double-apply (only one runs migrate, both see final schema).

### Self-host smoke (DEPLOY-05 → SC#4, Phase 1 scope per 2026-04-27 deferral)
16. **Phase-1-scoped happy path on built image** — Playwright/smoke: boot image with minimal env (`APP_KEK_BASE64`, `DATABASE_URL`, `GOOGLE_CLIENT_ID/SECRET`), mock OAuth login, assert dashboard renders English, assert tenant scoping holds via /api/me. ≤ 5 min runtime. **Phase 2 extends with "create a game"; Phase 3 extends with "run a poll stub" (per CONTEXT.md `<deviations>`).**
17. **No SaaS-only assumption leaked** — smoke: assert no env vars from SaaS-only profile (e.g. `CLOUDFLARE_*`, `LOKI_URL`) are required for boot; minimal env list passes. **All `docker run` invocations exercise the image's actual ENTRYPOINT (BLOCKER 7 fix); no `sh -c` wrapper, no `--entrypoint` override.**

### i18n structure (UX-04 → SC#5)
18. **Paraglide message function resolves at runtime** — integration: render `+page.svelte` containing `{m.dashboard_title()}`; assert string in HTML.
19. **Adding a locale = drop a JSON file** — unit: place `messages/ru.json` in fixture, run Paraglide compile, assert generated output includes new locale; no source-code changes required.

### Trusted-proxy headers (DEPLOY-05)
20. **X-Forwarded-For respected only from trusted CIDR** — unit: middleware test with two requests — one from a trusted IP with `X-Forwarded-For: 1.2.3.4` (resolves to 1.2.3.4); one from an untrusted IP with same header (resolves to socket addr). Confirms CVE-2026-27700 mitigation. **Plan 06 revision 1 expanded coverage to PT1-PT6 (six middleware-level tests, not deferred):** PT1 untrusted-source ignores XFF; PT2 trusted-source multi-hop XFF right-to-left walk; PT3 XFF-spoofing rejection; PT4 CF-Connecting-IP from trusted CF CIDR; PT5 CF header ignored from untrusted source; PT6 X-Forwarded-Proto trust gate (HSTS-relevant).

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags (`--watch`, `--ui`) in CI commands
- [ ] Feedback latency < 30s for unit; < 5 min for full suite
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending (will be flipped to `ratified by plan-phase 2026-04-27 (revision 1: checker iteration 1 fixes applied)` by Plan 10 Task 3 during execution).

**Revision 1 (2026-04-27) — checker iteration 1 fixes folded in:**
- BLOCKER 1: D-13 = oauth2-mock-server (CONTEXT.md `<deviations>` block recorded; Plan 05 + Plan 10 reference).
- BLOCKER 2: anonymous-401 sweep has hardcoded allowlist + non-empty guards (Plan 07).
- BLOCKER 3 + 6: PT1-PT6 owned by Plan 06 in-plan as middleware tests (six rows in map; not deferred to Plan 07).
- BLOCKER 4: Plan 06 ships `src/worker/index.ts` + `src/scheduler/index.ts` no-op stubs at D-01-locked paths.
- BLOCKER 5: Phase 1 DEPLOY-05 scope deferral recorded in CONTEXT.md `<deviations>`; ROADMAP SC#4 updated; Plan 10 `<scope>` block.
- BLOCKER 7: Plan 10 smoke script uses image ENTRYPOINT for all role invocations; no `sh -c` wrapper.
- W1: Plan 07 cross-tenant write/delete are explicit `it.skip` with deferred-to-Phase-2 annotations (no silent skips).
- W2: Plan 03 advisory lock comment includes the BIGINT-safe decimal `5_494_251_782_888_259_377`.
- W3: Plan 06 carries `<execution_notes>` recommending two atomic commits (no plan split; planner discretion).
- W4: Plan 06 + Plan 08 worker/scheduler paths corrected to D-01-locked `src/worker/index.ts` / `src/scheduler/index.ts`.
- INFO I2: Better Auth Google issuer-URL handling documented as `<execution_notes>` in Plan 05 + Plan 10 (three-path fallback).
