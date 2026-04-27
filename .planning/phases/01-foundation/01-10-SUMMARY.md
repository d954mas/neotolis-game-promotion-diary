---
phase: 01-foundation
plan: 10
subsystem: self-host-smoke
tags: [smoke, deploy-05, oauth2-mock-server, d-13, d-14, d-15, ci-gate, image-entrypoint, generic-oauth, info-i2-path-2]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: Plan 01-02 (CI workflow scaffold + smoke job + Wave 0 self-host.sh stub), Plan 01-05 (Better Auth handler with genericOAuth plugin — INFO I2 Path 2), Plan 01-06 (Hono app + SvelteKit pass-through + /healthz + /readyz at D-21 semantics + worker/scheduler stubs at D-01 paths), Plan 01-07 (tenantScope on /api/* + /api/me + DTO discipline), Plan 01-08 (real pg-boss worker/scheduler entrypoints emitting `worker ready` / `scheduler ready`), Plan 01-09 (Paraglide compiled `Promotion diary` literal in messages/en.json)
provides:
  - tests/smoke/self-host.sh — full Phase-1-scoped self-host smoke test gating every PR (DEPLOY-05). Six numbered assertions per D-15: (1) APP_ROLE=app boots, /healthz 200, /readyz 200; (2) APP_ROLE=worker boots, stdout contains `worker ready`; (3) APP_ROLE=scheduler boots, stdout contains `scheduler ready`; (4) OAuth login lands on /api/me + dashboard renders Paraglide English; (5) anonymous /api/me returns 401, cross-tenant probe returns user B (never user A); (6) container has no CF_*/CLOUDFLARE_*/ANALYTICS_* env vars set. Exits non-zero on any miss; cleanup trap stops/removes containers on exit. ALL `docker run` invocations exercise the image's actual ENTRYPOINT (no `sh -c` wrapper, no `--entrypoint` override) — the production startup path is what's under test.
  - tests/smoke/lib/oauth-mock-driver.ts — `oauth2-mock-server`-driven OAuth dance helper invoked from the bash script via `pnpm tsx`. Boots an OIDC mock IdP on localhost:9090, configures `beforeUserinfo` + `beforeTokenSigning` to mint claims for the requested fixture user, replays the Better Auth `/api/auth/sign-in/google?callbackURL=/` redirect dance manually with `redirect: 'manual'` so cookies accumulate in a Map jar, prints `neotolis.session_token=<value>` on stdout for the bash script to `$()`-capture.
  - .github/workflows/ci.yml — smoke job adjusted: `pnpm build` runs BEFORE `docker build` (so the host workspace's compiled SvelteKit + Paraglide artifacts match the image's), `BETTER_AUTH_SECURE_COOKIES=false` env (review blocker P1 — production image runs over plain HTTP behind a TLS-terminating proxy in self-host), `GOOGLE_DISCOVERY_URL` points at the mock IdP for the smoke job's lifetime.
  - .planning/phases/01-foundation/01-VALIDATION.md — Per-Task Verification Map fully populated (33 rows including PT1-PT6 split + deferred Phase-2 cross-tenant write/delete), `nyquist_compliant: true`, status: ratified.
affects: [Phase 2 SC#1 (smoke extends to "user A creates a game" via the new /api/games endpoints; cross-tenant matrix expands from /api/me sentinel to /api/games), Phase 3 SC#2 (smoke extends to enqueue + process a poll-stub job end-to-end + assert metric_snapshots immutability + worker SIGTERM drain), every later phase (the smoke gate is now load-bearing — any PR that breaks self-host parity fails CI before merge)]

# Tech tracking
tech-stack:
  added: []  # oauth2-mock-server@^7.2.0 already pinned by Plan 01-02 Wave 0; no new deps.
  patterns:
    - "Image-ENTRYPOINT exercise (BLOCKER 7 fix): every `docker run` in the smoke script omits `--entrypoint` and never uses `sh -c`. The Dockerfile's `ENTRYPOINT [\"node\", \"build/server.js\"]` is the production startup path; the smoke test exercises it verbatim. APP_ROLE=app boots a long-lived container detached with `-d`; worker/scheduler boot detached and the bash script tails `docker logs -f <name> | grep -m1 \"<signal>\"` with `set +o pipefail` around the pipe (grep -m1 closes the pipe → docker logs dies with SIGPIPE → pipefail would propagate that nonzero even though grep matched; disable pipefail just for the pipeline)."
    - "INFO I2 Path 2 (genericOAuth) chosen over Path 1 (env-driven Google issuer override) and Path 3 (mock-mints-real-Google-iss). Better Auth 1.6.x's `socialProviders.google` hardcodes Google's authorize/token endpoints — no `discoveryUrl` knob. The genericOAuth plugin DOES expose `discoveryUrl`, so the same code points at https://accounts.google.com/.well-known/openid-configuration in production and http://localhost:9090/.well-known/openid-configuration in CI/smoke. The account row's `providerId` stays 'google' by construction (the plugin uses the configured providerId verbatim). Rationale recorded in src/lib/auth.ts header comment."
    - "D-13 mechanism = `oauth2-mock-server` (CONTEXT.md `<deviations>` 2026-04-27): Better Auth has no native dev provider in 1.6.x, so the original D-13 phrasing 'Better Auth's built-in test provider' was substituted at planning time. The mock server runs as a sidecar in the smoke job (started inside `oauth-mock-driver.ts`), generates its own RS256 keypair, and exposes `/.well-known/openid-configuration` so the genericOAuth plugin's discovery flow works end-to-end."
    - "Common-env helper (`common_env_args`): every role gets the full env set via a shared bash function rather than three near-identical `-e` lists. env.ts is module-level and validates everything at import time, so worker/scheduler need every var the app role needs even though they don't use the HTTP/auth ones at runtime. Helper makes it impossible to drift the lists."
    - "Cleanup trap: bash `trap cleanup EXIT` ensures `docker stop` + `docker rm` of all three smoke containers run even on failure or Ctrl-C. Without it a failed CI run leaks dangling containers that the next run's `docker run --name smoke-app` would conflict with."

key-files:
  created:
    - tests/smoke/self-host.sh
    - tests/smoke/lib/oauth-mock-driver.ts
  modified:
    - .github/workflows/ci.yml             # smoke job: pnpm build before docker build; BETTER_AUTH_SECURE_COOKIES=false; GOOGLE_DISCOVERY_URL pointing at mock
    - .planning/phases/01-foundation/01-VALIDATION.md  # frontmatter ratified; nyquist_compliant: true; full per-task map with PT1-PT6 split + deferred Phase-2 entries

key-decisions:
  - "INFO I2 path resolution = Path 2 (genericOAuth plugin with discoveryUrl). Original D-13 mechanism (Better Auth's built-in dev/test provider) does not exist in 1.6.x; original drop-in (`socialProviders.google`) hardcodes Google's endpoints with no override knob. genericOAuth was chosen during the post-Phase-1 review-blocker fix (P0-2) because: (a) it gives env-driven `discoveryUrl` so the same code serves real Google in production and oauth2-mock-server in CI/smoke; (b) the account row's `providerId` stays 'google' verbatim — no schema migration; (c) PKCE + scopes config is identical between paths. Rationale captured in src/lib/auth.ts inline comment + this summary."
  - "BLOCKER 7 mitigation choice — `docker run -d` + `docker logs -f | grep -m1`. Alternatives considered: (a) `docker run --rm` blocking and parsing exit code — rejected because pg-boss workers are long-lived; we want to test that they BOOT, not that they exit; (b) `docker exec` after a startup poll — rejected because the worker doesn't expose an HTTP endpoint to poll. The detached + log-grep pattern is the standard way to test 'service emits ready signal then keeps running'. The pipefail-around-grep nuance is documented inline in the script."
  - "All env vars to all three roles. The temptation was to send only DATABASE_URL + APP_KEK_BASE64 to worker/scheduler since they don't use Better Auth at runtime. But env.ts is module-level — `RawSchema.parse(process.env)` runs on every import. Worker/scheduler imports the env module (transitively, via logger / db / queue-client). If GOOGLE_CLIENT_ID is missing, parse fails, container exits non-zero, and the smoke test reports 'worker did not print ready signal' — confusing root cause. Sending the full env set keeps env.ts as the SOLE diagnostic point for missing config."
  - "Six explicit numbered assertions, no clever DRY. The script reads top-to-bottom as a checklist matching D-15 verbatim. A future contributor reading a CI failure log sees `(2) FAIL: worker did not print 'worker ready' within 30s` — knows exactly which D-15 invariant broke. Earlier draft tried to loop over a `(role, signal)` table; rejected because the loop noise made CI logs harder to scan."
  - "Re-fataling the dashboard-render assertion (post-Phase-1 review Fix 1 + Fix 2). The original Plan 10 contract had `(4)` fail loudly when the SvelteKit dashboard didn't render the Paraglide string. During the original Phase-1 cleanup the assertion was softened to a `PARTIAL` log line because `build/handler.js` was failing to load inside the production image — the dynamic import in src/roles/app.ts caught the throw and fell back to the 404 stub, so `GET /` never returned the dashboard HTML. Root cause was a zod version mismatch (Better Auth 1.6.9 uses zod-v4 syntax `.meta()`; the project pinned zod ^3.23.8 which hoisted to 3.25.76; the bundled `import * as z$1 from 'zod'` resolved to v3 and threw at hooks-init). Fixed by aligning the project's zod to ^4.3.6 (and @hono/zod-validator to ^0.7.0 for compatibility). Once handler.js loaded cleanly, the dashboard-render assertion was flipped back to fatal. Both diffs landed in the same review PR."

requirements-completed: [DEPLOY-05, AUTH-01, AUTH-02, AUTH-03, PRIV-01, UX-04]

# Metrics
duration: ~30min (initial plan + post-Phase-1 review fixes)
completed: 2026-04-27
---

# Phase 1 Plan 10: Self-Host Smoke Test Gating Every PR (DEPLOY-05) Summary

**Landed the Phase-1-scoped self-host CI smoke gate: `tests/smoke/self-host.sh` boots the production Docker image in all three roles via the image's actual ENTRYPOINT, drives a real Google OAuth login through `oauth2-mock-server` via `tests/smoke/lib/oauth-mock-driver.ts` (D-13 mechanism per CONTEXT.md `<deviations>` 2026-04-27), asserts the empty dashboard renders the Paraglide English string `Promotion diary`, hits anonymous-401 + cross-tenant /api/me sentinel, and confirms no SaaS-only env var is required for boot. CI's smoke job runs `pnpm build` → `docker build -t neotolis:ci .` → SaaS-leak source grep → `bash tests/smoke/self-host.sh` and fails the PR on any miss. Better Auth's Google integration uses the genericOAuth plugin with env-driven `discoveryUrl` (INFO I2 Path 2, chosen during the post-Phase-1 review-blocker fix to replace the original Path 0 'Better Auth socialProviders.google' that hardcoded Google's endpoints) so the same code points at real Google in production and at the mock IdP in CI. The dashboard-render assertion was softened during the original Phase-1 cleanup (HTTP 404 from a failed `build/handler.js` import inside the container) and was made fatal again in the post-Phase-1 review PR after the root cause — a zod version mismatch between the project (v3) and Better Auth (v4) — was fixed by aligning the project's zod to ^4.3.6.**

## Performance

- **Duration:** ~30 min initial; ~25 min for the post-Phase-1 review fixes (Fix 1 root-cause investigation + Fix 2 re-fataling)
- **Tasks:** 3 / 3 (Task 1 script + driver, Task 2 human checkpoint, Task 3 VALIDATION.md ratification)

## Accomplishments

- `tests/smoke/self-host.sh` ships the full six-assertion D-15 contract (Phase 1 scope per the 2026-04-27 deferral):
  1. APP_ROLE=app boots → `/healthz` returns `ok` → `/readyz` returns `{"ok":true}` after migrations.
  2. APP_ROLE=worker boots → stdout contains `worker ready` (Plan 08 dual-emit; bash greps the literal line).
  3. APP_ROLE=scheduler boots → stdout contains `scheduler ready`.
  4. OAuth login via `oauth-mock-driver.ts` → `/api/me` returns the seeded user → dashboard renders `Promotion diary` (Paraglide UX-04).
  5. Anonymous `/api/me` returns 401; user B's `/api/me` shows user B (never user A's email leaks across tenants).
  6. Running app container has no `CF_*` / `CLOUDFLARE_*` / `ANALYTICS_*` env vars set (D-14 runtime side; the `.github/workflows/ci.yml` source grep is the static side).
- `tests/smoke/lib/oauth-mock-driver.ts` boots `oauth2-mock-server` on localhost:9090, generates RS256 keys, configures `beforeUserinfo` + `beforeTokenSigning` so the mock mints `{ sub, email, email_verified: true, name, iss: server.issuer.url, aud: 'mock-client-id' }` claims for whatever `--sub --email --name` triple the bash script asks for. The driver replays the redirect dance manually with `redirect: 'manual'` and a `Map`-based cookie jar (auto-follow loses cookies). Prints exactly `neotolis.session_token=<value>` on stdout so the bash script can `$()`-capture in one line.
- `.github/workflows/ci.yml` smoke job: `pnpm build` step inserted between `pnpm install --frozen-lockfile` and `docker build` so the host workspace's compiled SvelteKit + Paraglide artifacts match the image's; `BETTER_AUTH_SECURE_COOKIES=false` job env (review blocker P1 — production image runs over plain HTTP in CI); `GOOGLE_DISCOVERY_URL` job env points at the mock IdP.
- `.planning/phases/01-foundation/01-VALIDATION.md` ratified: frontmatter `nyquist_compliant: true`, `wave_0_complete: true`, `status: ratified`. Per-Task Verification Map populated with one row per task plus PT1-PT6 split and explicit deferred-to-Phase-2 entries for VALIDATION 8 (cross-tenant WRITE) and 9 (cross-tenant DELETE).

## Deviations from the original plan

- **D-13 mechanism update.** Original CONTEXT.md text said "Better Auth's built-in dev / test provider"; that mechanism doesn't exist in Better Auth 1.6.x. Substitute = `oauth2-mock-server` package, recorded in CONTEXT.md `<deviations>` block on 2026-04-27 with user acceptance.
- **DEPLOY-05 SC#4 scope.** Original D-15 #4 said the smoke must "create a game and run a poll stub". Phase 1 has no game model (Phase 2 lands GAMES-01) and no poll handlers (Phase 3 lands POLL-01..06). Those clauses are scope-deferred: Phase 2 smoke extends with "create a game"; Phase 3 smoke extends with "run a poll stub". Recorded in CONTEXT.md `<deviations>` 2026-04-27 with user acceptance and reflected in ROADMAP Phase 1 SC#4.
- **INFO I2 issuer-URL path.** Original Plan 05 + Plan 10 considered three paths for routing Better Auth at the mock IdP. Path 2 (genericOAuth plugin with `discoveryUrl`) was chosen during the post-Phase-1 review-blocker fix because Better Auth's `socialProviders.google` hardcodes Google's authorize/token endpoints with no override knob. Recorded in src/lib/auth.ts header comment.
- **Dashboard-render assertion was softened, then re-fataled.** During the original Phase-1 cleanup the dashboard-render assertion at smoke step (4) was downgraded to a `PARTIAL` log line because `GET /` returned 404 from inside the production image. The post-Phase-1 review (Fix 1) traced the 404 to a zod version mismatch (Better Auth 1.6.9 uses zod v4; project pinned ^3.23.8 → resolved to 3.25.76 → bundled `z$1.coerce.boolean().meta()` threw because zod 3 has no `.meta()` method); aligning zod to ^4.3.6 (and `@hono/zod-validator` to ^0.7.0 for compatibility) made `build/handler.js` load cleanly and produce real dashboard HTML. Fix 2 then restored the original `fail "..."` assertion. Both diffs landed in the same review PR. Documented inline in `tests/smoke/self-host.sh` and in this summary.

## What this enables

The smoke gate is the load-bearing trust signal for the open-source angle (PROJECT.md): every PR is exercised through the same Docker image a self-host operator pulls. PITFALL P13 (self-host parity rot) cannot accumulate silently across phases — Phase 2's GAMES endpoints, Phase 3's poll workers, Phase 4's UI, and Phase 6's deploy hardening each extend this script in their own Wave 5 plans. Three CI jobs (lint-typecheck, unit-integration, smoke) together gate every PR; the smoke job is the deepest one.

## Open follow-ups (out of scope for Plan 10)

- Phase 2 smoke extension: "user A creates a game" via /api/games; cross-tenant matrix expands to /api/games.
- Phase 3 smoke extension: enqueue + process a poll-stub job end-to-end; metric_snapshots immutability; worker SIGTERM drain timing.
- Phase 6 deploy-doc smoke extension: assert TRUSTED_PROXY_CIDR=Cloudflare-ranges scenario and Cloudflare-Tunnel-fronted scenario produce identical /api/me + audit-log IP.

## Task Commits

The original Plan-10 work landed in commit `b69eb81` ("#4 Phase 1: foundation") on `master` — the squashed root commit that captures all 10 plans of Phase 1 in one revision. The post-Phase-1 review's re-fataling of the dashboard-render assertion and the underlying zod-version root-cause fix landed on `fix/post-phase-1-review` (this branch, closing issue #5).

## Self-Check: PASSED

- [x] Smoke script + driver written and committed
- [x] Smoke job wired into `.github/workflows/ci.yml`
- [x] All six numbered D-15 assertions present and active in `tests/smoke/self-host.sh` (Phase 1 scope)
- [x] Image ENTRYPOINT exercised — no `sh -c` wrapper, no entrypoint override (BLOCKER 7 mitigation)
- [x] D-13 mechanism deviation captured in `01-CONTEXT.md` `<deviations>` block
- [x] INFO I2 path resolved via genericOAuth `discoveryUrl` env knob (post-Phase-1 review fix)
- [x] Dashboard-render assertion fatal at merge time (no PARTIAL fall-through)
- [x] VALIDATION.md frontmatter ratified

---

*Phase: 01-foundation*
*Plan: 10*
*Completed: 2026-04-27 (re-fataled in #5 / post-Phase-1 review)*
