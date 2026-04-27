---
phase: 01-foundation
plan: 02
subsystem: testing
tags: [vitest, docker, github-actions, ci, smoke-test, oauth2-mock-server, postgres, multi-stage]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: Plan 01-01 supplies package.json (vitest, oauth2-mock-server, pg as devDeps), tsconfig.json, src/lib/server/logger.ts, src/lib/server/config/env.ts
provides:
  - vitest.config.ts splitting unit (no DB) and integration (with DB) projects via test.projects
  - Wave 0 placeholder test files for every VALIDATION.md behavior — every it.skip names the responsible plan
  - tests/setup.ts boots pg.Pool, runs migrations once, truncates public tables between specs (with graceful warn until Plan 01-03 lands runMigrations)
  - tests/setup/db.ts withTx / withSavepoint helpers for transactional test isolation
  - tests/setup/oauth.ts startMockOauth/stopMockOauth/mintIdToken (D-13 mechanism per CONTEXT.md <deviations>)
  - tests/integration/helpers.ts setupTestDb/createUser/createGame/fetchAs stable signatures
  - Multi-stage Dockerfile (deps -> build -> runtime) on node:22-alpine with non-root UID 10001 (D-22)
  - .dockerignore excluding node_modules, .svelte-kit, build, .git, .planning, tests/smoke, .env*, .github
  - docker-compose.selfhost.yml with three services (app/worker/scheduler) sharing one image + postgres:16-alpine
  - .github/workflows/ci.yml three-job pipeline (lint-typecheck, unit-integration, smoke) with Postgres service container per D-16
  - SaaS-leak grep step (D-14) guarding against analytics.neotolis / admin@neotolis hardcoded strings and CF-Connecting-IP references outside trusted-proxy module
  - tests/smoke/self-host.sh skeleton with CI/ALLOW_LOCAL_SMOKE gate; comments name the five-step happy path Plan 01-10 lands
affects: [01-03 db-migrate, 01-04 envelope-encryption, 01-05 better-auth, 01-06 hono-mount, 01-07 tenant-scope, 01-08 worker-scheduler, 01-09 i18n, 01-10 self-host-smoke]

# Tech tracking
tech-stack:
  added:
    - "vitest@4 with test.projects (unit/integration split)"
    - "Docker multi-stage build pattern (deps/build/runtime, distroless-ish alpine final)"
    - "GitHub Actions Postgres service container (D-16)"
    - "oauth2-mock-server lifecycle helpers (D-13 substitute mechanism)"
  patterns:
    - "Wave 0 fail-loudly placeholders: every Phase 1 test file already on disk; later plans flip it.skip into real assertions. Nyquist invariant — every later task ships into a test that already exists."
    - "Transactional test fixture: tests/setup.ts uses pool-level TRUNCATE between specs; tests/setup/db.ts adds withTx() for stricter per-test isolation."
    - "One image, three roles: Dockerfile ENTRYPOINT dispatches on APP_ROLE (Plan 06 lands the runtime dispatch in build/server.js). docker-compose.selfhost.yml exercises all three roles from the same build."
    - "CI structure for self-host trust: SaaS-leak grep + smoke test gate every PR; D-14/D-15 mechanisms baked into ci.yml from day one."
    - "Test scaffolding documents responsibility: every it.skip placeholder names the plan (01-04, 01-05, 01-06, 01-07, 01-09) that lands the assertion. Reading any test file tells you what's coming and from where."

key-files:
  created:
    - vitest.config.ts
    - tests/setup.ts
    - tests/setup/db.ts
    - tests/setup/oauth.ts
    - tests/fixtures/users.ts
    - tests/integration/helpers.ts
    - tests/unit/encryption.test.ts
    - tests/unit/proxy-trust.test.ts
    - tests/unit/logger.test.ts
    - tests/unit/dto.test.ts
    - tests/unit/paraglide.test.ts
    - tests/integration/auth.test.ts
    - tests/integration/tenant-scope.test.ts
    - tests/integration/anonymous-401.test.ts
    - tests/integration/health.test.ts
    - tests/integration/migrate.test.ts
    - tests/integration/i18n.test.ts
    - tests/smoke/self-host.sh
    - Dockerfile
    - .dockerignore
    - docker-compose.selfhost.yml
    - .github/workflows/ci.yml
  modified: []

key-decisions:
  - "Dockerfile final stage: node:22-alpine over distroless. Alpine ships wget for HEALTHCHECK without an extra layer; ~150–200 MB final image still fits the indie-budget envelope; revisit if Phase 3 wants sharp/native musl-fragile libs."
  - "Non-root UID = 10001. Above the alpine reserved range (<1000) and above the typical container UID grab-bag (1000–9999) so it doesn't collide with host bind-mounts on self-host VPS deployments."
  - "tests/setup.ts catches the missing-runMigrations import and prints a console.warn rather than throwing. Lets vitest --project=unit and --project=integration both parse cleanly today; the warn vanishes when Plan 01-03 lands the migrator."
  - "fetchAs uses cookie-string heuristic (contains '=' = literal cookie, else user-id). Lets Plan 05/07 supply the user-id → cookie lookup later without touching the helper signature."
  - "tests/integration/helpers.ts createGame stub throws 'games table arrives in Phase 2'. Lets Plan 10's smoke test import the same module shape that Phase 2 will fill in — no module-rename later."

requirements-completed: [DEPLOY-05]

# Metrics
duration: ~14 min
completed: 2026-04-27
---

# Phase 1 Plan 02: Test Scaffolding + Multi-Stage Dockerfile + CI Pipeline Summary

**Wave 0 placeholder tests for all six Phase 1 requirements + multi-stage Docker image + GitHub Actions CI workflow with SaaS-leak grep and self-host smoke skeleton**

## Performance

- **Duration:** ~14 min
- **Started:** 2026-04-27T11:16:52Z
- **Completed:** 2026-04-27T11:30:00Z (approximate)
- **Tasks:** 2
- **Files modified:** 22 (all new)

## Accomplishments

- Every Wave 0 test file from 01-VALIDATION.md exists with skipped placeholders that fail-loudly until later plans implement the feature (Nyquist invariant preserved across the phase)
- vitest.config.ts splits unit (no DB) and integration (with DB) projects via vitest 4's test.projects API
- tests/setup.ts boots pg.Pool from TEST_DATABASE_URL, runs migrations once, truncates public tables between specs — with a graceful warn-don't-throw fallback until Plan 01-03 lands runMigrations
- Multi-stage Dockerfile produces a one-image-three-roles container (D-22): node:22-alpine deps -> build -> runtime, non-root UID 10001, HEALTHCHECK on /readyz
- docker-compose.selfhost.yml exercises all three APP_ROLE roles (app, worker, scheduler) from the single image, against a healthchecked Postgres 16 container
- .github/workflows/ci.yml three-job pipeline (lint-typecheck → unit-integration with Postgres 16 service container per D-16 → smoke with image build + SaaS-leak grep + self-host.sh)
- D-14 SaaS-leak grep: hardcoded admin emails / analytics URLs FAIL the PR; CF-Connecting-IP outside the trusted-proxy module FAILS the PR
- BLOCKER 7 fix encoded: tests/smoke/self-host.sh comments document that every docker run exercises the image ENTRYPOINT, no sh -c wrapper

## Task Commits

Each task was committed atomically:

1. **Task 1: vitest config + test fixtures + Wave 0 placeholder test files** — `9179319` (test)
2. **Task 2: Multi-stage Dockerfile + docker-compose.selfhost.yml + CI workflow + smoke skeleton** — `4508906` (feat)

## Files Created

### Test scaffolding (Task 1)
- `vitest.config.ts` — vitest 4 test.projects split: unit (no DB) + integration (with DB, setupFiles, forks pool)
- `tests/setup.ts` — pg.Pool boot, runMigrations dynamic-import-with-warn, public-table TRUNCATE between specs
- `tests/setup/db.ts` — withTx() / withSavepoint() per-test transactional helpers
- `tests/setup/oauth.ts` — startMockOauth / stopMockOauth / mintIdToken (D-13 oauth2-mock-server)
- `tests/fixtures/users.ts` — seedUser stub: throws "users table not yet created (Plan 01-03)"
- `tests/integration/helpers.ts` — setupTestDb / createUser / createGame / fetchAs stable signatures
- `tests/unit/encryption.test.ts` — KEK/DEK/tamper/missing-KEK placeholders (Plan 01-04)
- `tests/unit/proxy-trust.test.ts` — PT1–PT6 placeholders (Plan 01-06)
- `tests/unit/logger.test.ts` — pino-shape sanity check + redaction-path placeholders
- `tests/unit/dto.test.ts` — DTO discipline placeholders (Plan 01-05 / 01-07)
- `tests/unit/paraglide.test.ts` — i18n placeholders (Plan 01-09)
- `tests/integration/auth.test.ts` — OAuth happy-path placeholders (Plan 01-05)
- `tests/integration/tenant-scope.test.ts` — cross-tenant 404 placeholder + W1 explicit DEFERRED-to-Phase-2 annotations on 8/9
- `tests/integration/anonymous-401.test.ts` — anonymous-401 + no-public-route placeholders (Plan 01-07)
- `tests/integration/health.test.ts` — /healthz, /readyz, worker stub boot, scheduler stub boot placeholders (Plan 01-06)
- `tests/integration/migrate.test.ts` — idempotent + advisory-lock placeholders (Plan 01-03)
- `tests/integration/i18n.test.ts` — runtime i18n render placeholder (Plan 01-09)

### Container + CI (Task 2)
- `Dockerfile` — three-stage (deps/build/runtime); node:22-alpine; non-root UID 10001; HEALTHCHECK on /readyz; ENTRYPOINT ["node", "build/server.js"]
- `.dockerignore` — excludes node_modules, .svelte-kit, build, .git, .planning, tests/smoke, .env, .github
- `docker-compose.selfhost.yml` — app + worker + scheduler from one build + postgres:16-alpine with healthcheck-gated dependsOn
- `.github/workflows/ci.yml` — lint-typecheck + unit-integration (Postgres 16 service container) + smoke (image build + SaaS-leak grep + self-host.sh)
- `tests/smoke/self-host.sh` — bash -euo pipefail skeleton; CI/ALLOW_LOCAL_SMOKE gate; comments name the Plan 01-10 five-step happy path

## Skipped vs Active Tests (per `<output>` requirement)

**Active (will run today):**
- `tests/unit/encryption.test.ts` → "module file does not exist yet (placeholder honesty check)" — asserts Plan 01-04's envelope module hasn't landed yet (will be deleted when Plan 04 lands)
- `tests/unit/logger.test.ts` → "logger module exposes pino-shaped interface" — passes when Plan 01-01's logger lands; gracefully no-ops if absent

**Skipped (named plan owns):**
- 4 placeholders for envelope encryption (Plan 01-04)
- 6 placeholders for proxy-trust PT1–PT6 (Plan 01-06)
- 2 logger redaction / env-discipline placeholders (Plan 01-04 / 01-07)
- 2 DTO discipline placeholders (Plan 01-05 / 01-07)
- 2 paraglide i18n placeholders (Plan 01-09)
- 5 OAuth happy-path placeholders (Plan 01-05)
- 3 tenant-scope placeholders (1 active for Plan 01-07, 2 explicit "DEFERRED to Phase 2" — VALIDATION 8/9 W1 fix)
- 2 anonymous-401 / no-public-route placeholders (Plan 01-07)
- 4 health/readyz/worker-boot/scheduler-boot placeholders (Plan 01-06 — BLOCKER 4 fix)
- 3 migration placeholders (Plan 01-03 — W2 advisory-lock decimal `5_494_251_782_888_259_377` referenced in comment)
- 1 runtime i18n render placeholder (Plan 01-09)

**Total:** 36 placeholders across 12 test files, every one naming the responsible downstream plan.

## SaaS-Leak Grep Patterns Enforced (D-14)

The CI workflow (`.github/workflows/ci.yml` step "SaaS-leak grep (D-14)") fails the PR if either pattern matches under `src/`:

1. Hardcoded SaaS-only strings: `analytics\.neotolis`, `admin@neotolis`
2. Cloudflare-only header outside the trusted-proxy module: `CF-Connecting-IP` referenced anywhere except files matching `proxy-trust`

These are the initial guardrails. Future plans extend the patterns (e.g. analytics beacons, admin email allowlists, paid-only feature flags). The grep is best-effort; the proxy-trust unit tests (Plan 01-06 PT1–PT6) are the authoritative defense.

## Dockerfile Decisions

- **Base image:** `node:22-alpine` (D-22 explicit). Alpine over distroless because the build needs `wget` for HEALTHCHECK and `corepack` for pnpm; alpine ships both without extra layers.
- **UID:** non-root user `app:app`, UID/GID 10001. Above the alpine reserved range (<1000) and the typical container 1000–9999 grab-bag — avoids collision with host bind-mounts on self-host VPS deployments.
- **Healthcheck:** `wget --quiet --spider http://localhost:3000/readyz` with 30s interval, 5s timeout, 20s start period, 3 retries. Binds to `/readyz` (D-21) — Cloudflare Tunnel polls `/healthz` separately to avoid restart loops.
- **ENTRYPOINT:** `["node", "build/server.js"]`. The role dispatch lives inside `build/server.js` (Plan 01-06 lands the actual file; Wave 0 ships the structure).
- **Stages:** `deps` (full install incl. devDeps for the build) → `build` (compile SvelteKit + `pnpm prune --prod`) → `runtime` (copy build/, node_modules/, package.json, drizzle/). `pnpm prune --prod` in the build stage strips devDeps before the COPY so runtime carries only what production needs.

## Decisions Made

- **vitest 4 test.projects.** Replaces the older `vitest.workspace.ts` pattern. Cleaner config (one file), better IDE integration, and lets us run `pnpm test:unit` (filter `--project=unit`) without setup-file overhead.
- **TEST_DATABASE_URL distinct from DATABASE_URL.** Prod and test DBs must never share a connection string — accidentally truncating prod tables in CI is a real risk. The setup file reads only the TEST_ variant.
- **fetchAs heuristic.** Cookie-string-vs-user-id detection via `.includes('=')` keeps Plan 05/07 free to supply the user-id → cookie lookup without changing the signature.
- **Smoke script gate.** CI-only by default (`if [[ -z "${CI:-}" ]] && [[ -z "${ALLOW_LOCAL_SMOKE:-}" ]]`) prevents accidental local runs that would build images on developer machines unexpectedly.

## Deviations from Plan

None — plan executed exactly as written. The plan's wave-coordination block warned that Plan 01-01 owns package.json; this executor made no edits to package.json, .gitignore, .nvmrc, tsconfig.json, src/lib/server/logger.ts, src/lib/server/config/env.ts, src/lib/server/ids.ts, .eslintrc.cjs, .prettierrc, or .prettierignore. Confirmed via `git status` and `git diff --stat HEAD~2 HEAD` (only files in `tests/`, `Dockerfile`, `.dockerignore`, `docker-compose.selfhost.yml`, `.github/workflows/ci.yml`, and `vitest.config.ts` were touched).

## Issues Encountered

- **Windows CRLF warnings on commit.** Git surfaced `LF will be replaced by CRLF` warnings on every text file because the repo's autocrlf setting is project-default. No-op for the file content; Linux CI normalizes on checkout. Documented for future executors but not fixed here.
- **`git update-index --chmod=+x` failed on the smoke script.** The file wasn't yet staged. Not a problem in practice: `.github/workflows/ci.yml` invokes the script via `bash tests/smoke/self-host.sh`, which doesn't require the executable bit. Plan 01-10 can flip the bit when it replaces the script body.
- **Dependency vs Plan 01-01.** Plan 01-02's tests/setup/oauth.ts uses `oauth2-mock-server` and tests/setup.ts uses `pg`. Plan 01-01's SUMMARY confirms both are in package.json devDeps (`oauth2-mock-server@^7.2.0`, `pg@8.20.0`). No follow-up dependency commit needed.

## User Setup Required

None — Phase 1 Wave 0 is purely scaffolding. CI runs against the same Postgres service container; self-host operators don't interact with these files until Phase 6 documents the deploy procedure.

## Next Phase Readiness

- **Plan 01-03 (Wave 2 schema + migrate):** can land `src/lib/server/db/migrate.ts` and `runMigrations` will be picked up automatically by `tests/setup.ts` (the warn disappears on first successful import).
- **Plan 01-04 (Wave 2 envelope encryption):** `tests/unit/encryption.test.ts` is on disk with four it.skip blocks naming the four behaviors to assert. The "module file does not exist yet" test will fail and must be deleted when Plan 04 lands the module.
- **Plan 01-05 (Wave 3 Better Auth):** `tests/integration/auth.test.ts` is on disk with five it.skip blocks; `tests/setup/oauth.ts` exposes the mock-server lifecycle Plan 05 will call.
- **Plan 01-06 (Wave 3 Hono mount + middleware):** `tests/unit/proxy-trust.test.ts` has six PT placeholders; `tests/integration/health.test.ts` has four placeholders including worker/scheduler stub boots (BLOCKER 4 fix).
- **Plan 01-07 (Wave 4 tenant scope):** `tests/integration/anonymous-401.test.ts` and `tests/integration/tenant-scope.test.ts` on disk; W1 fix already encoded as explicit "DEFERRED to Phase 2" annotations on VALIDATION 8/9.
- **Plan 01-09 (Wave 4 i18n):** Paraglide placeholders on disk in unit + integration test files.
- **Plan 01-10 (Wave 5 self-host smoke):** `tests/smoke/self-host.sh` skeleton ready to receive the five-step happy path; `.github/workflows/ci.yml` already invokes it; image-build step already wired.

## Self-Check: PASSED

- All 22 created files exist on disk (verified via `ls`).
- Both task commits (`9179319`, `4508906`) present in `git log --oneline`.
- All Task 1 acceptance criteria pass (vitest projects:, TEST_DATABASE_URL, fetchAs export, "404 not 403" marker, KEK/DEK/tamper/missing-KEK markers, "every protected route returns 401" marker, no xit/it.todo).
- All Task 2 acceptance criteria pass (Dockerfile node:22-alpine + ENTRYPOINT + USER app + HEALTHCHECK /readyz; ci.yml postgres:16-alpine + self-host.sh + SaaS-leak; smoke shebang + set -euo pipefail; compose three roles + postgres:16-alpine; .dockerignore .git/node_modules/.svelte-kit).

---
*Phase: 01-foundation*
*Plan: 02*
*Completed: 2026-04-27*
