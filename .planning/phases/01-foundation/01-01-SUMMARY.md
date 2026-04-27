---
phase: 01-foundation
plan: 01
subsystem: infra
tags: [config, env, zod, pino, uuidv7, eslint, prettier, sveltekit, drizzle, hono, locked-stack]

# Dependency graph
requires:
  - phase: 00-research
    provides: Locked stack (verified pins as of 2026-04-27), D-01..D-25 decisions, project structure
provides:
  - Locked Phase 1 stack pinned in package.json (better-auth 1.6.9, drizzle-orm 0.45.2, hono 4.12.15, @hono/node-server 1.19.14, pg-boss 10.1.10, paraglide-js 2.16.1)
  - src/lib/server/config/env.ts as the SOLE reader of process.env (D-24, P2 mitigation)
  - Boot-time KEK validation that fails fast on missing/wrong-length APP_KEK_BASE64 and scrubs the env var after decode
  - Pino logger pre-wired with the full D-24 redact-path list (api_key, refresh_token, wrapped_dek, Authorization header, etc.)
  - UUIDv7 helper for time-sortable, enumeration-safe primary keys (D-06)
  - ESLint rule that bans process.env outside src/lib/server/config/
  - SvelteKit + Vite + Drizzle + Paraglide configs targeting adapter-node and the inlang plugin
affects: [01-02 test-scaffolding, 01-03 db-schema, 01-04 envelope-encryption, 01-05 better-auth, 01-06 hono-mount, 01-07 tenant-scope, 01-08 worker-scheduler, 01-09 i18n, 01-10 self-host-smoke]

# Tech tracking
tech-stack:
  added:
    - hono@4.12.15
    - "@hono/node-server@1.19.14 (NOT 2.x — research drift table)"
    - "@hono/zod-validator@^0.4.0"
    - drizzle-orm@0.45.2
    - pg@8.20.0
    - pg-boss@10.1.10
    - better-auth@1.6.9
    - pino@^9.5.0
    - zod@^3.23.8
    - "@inlang/paraglide-js@2.16.1"
    - "@sveltejs/kit@^2.58.0"
    - "@sveltejs/adapter-node@^5.2.0"
    - svelte@^5.55.5
    - vite@^5.4.0
    - ipaddr.js@^2.2.0
    - uuidv7@^1.0.2
    - rate-limiter-flexible@^5.0.0
    - dotenv@^16.4.5
    - "vitest@^4.1.5 (devDep)"
    - "oauth2-mock-server@^7.2.0 (devDep, D-13 substitute)"
    - "drizzle-kit@^0.28.0 (devDep)"
    - "@better-auth/cli@^1.6.9 (devDep)"
  patterns:
    - "Single-source env reader: every module imports `env` from src/lib/server/config/env.ts; direct process.env access is blocked by ESLint outside that file"
    - "KEK boot poison-pill: APP_KEK_BASE64 is decoded, length-checked at 32 bytes, and deleted from process.env immediately so the raw key cannot leak via console.log(process.env)"
    - "Pino redaction is configured once at logger init; secret-shaped key paths from D-24 (apiKey, refreshToken, wrappedDek, dek, kek, plus Authorization/Cookie headers) are censored to '[REDACTED]'"
    - "UUIDv7 (RFC 9562) for every primary key going forward — time-sortable, enumeration-safe (D-06)"
    - "Locked-stack discipline: every dep that must match a verified version uses an exact pin (no ^), so install reproducibility is preserved across self-host operators"

key-files:
  created:
    - package.json
    - .nvmrc
    - tsconfig.json
    - svelte.config.js
    - vite.config.ts
    - drizzle.config.ts
    - .gitignore
    - .eslintrc.cjs
    - .prettierrc
    - .prettierignore
    - .env.example
    - src/lib/server/config/env.ts
    - src/lib/server/logger.ts
    - src/lib/server/ids.ts
  modified: []

key-decisions:
  - "Followed plan exactly. No deviations from Phase 1 locked-stack pins."
  - "drizzle.config.ts gets a single eslint-disable for process.env access — it's a dev-only generate-time tool that never runs in the production app process; the plan explicitly authorized this exception"
  - "package.json frontmatter listed pnpm-workspace.yaml in files_modified, but the action body, acceptance criteria, and D-01 (flat single package, no workspaces) all explicitly call for no workspace file — skipped per D-01"

patterns-established:
  - "Sole-process.env-reader: src/lib/server/config/env.ts owns all env IO; ESLint enforces the boundary (no-restricted-properties rule)"
  - "Boot-fail-fast on env shape: zod schema parse, KEK length check, and KEK_CURRENT_VERSION ↔ KEK_VERSIONS Map presence check all run synchronously at module load — process exits before HTTP server binds if any check fails"
  - "Pino-redact-at-init: redact paths are declared in one place (src/lib/server/logger.ts) so adding a new secret-shaped field anywhere triggers a single-line change here"
  - "Exact pinning for security-critical deps; semver-compatible (^) for tooling/types"

requirements-completed: [DEPLOY-05]

# Metrics
duration: ~3min
completed: 2026-04-27
---

# Phase 1 Plan 1: Locked-stack scaffold + env / logger / ids primitives Summary

**Pinned the Phase 1 stack (`better-auth@1.6.9`, `drizzle-orm@0.45.2`, `hono@4.12.15`, `@hono/node-server@1.19.14` — NOT 2.x, `pg-boss@10.1.10`, `@inlang/paraglide-js@2.16.1`), wired a zod-validated env module that is the SOLE process.env reader and self-destructs the KEK after decode, configured Pino with the full D-24 redact path list, and shipped the UUIDv7 helper plus ESLint+Prettier+SvelteKit+Vite+Drizzle configs.**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-04-27T11:16:52Z
- **Completed:** 2026-04-27T11:19:37Z
- **Tasks:** 2 / 2
- **Files modified:** 14 (all newly created)

## Accomplishments

- Locked-stack discipline: every Phase 1 dep is at the verified pin from `01-RESEARCH.md` (2026-04-27). The drift table's two warnings (`@hono/node-server` 2.0.0, `pg-boss` 12.x) are honored — we pin the older stable in both cases.
- Env module that fails fast on missing/short `APP_KEK_BASE64`, length-checks the decoded buffer at 32 bytes, supports `KEK_V2..V9` rotation slots, and **deletes the raw env var after consumption** so accidental `console.log(process.env)` cannot leak the KEK material (PITFALL P2 mitigation #4).
- Pino logger with all 14 D-24 redact paths (`apiKey`, `api_key`, `accessToken`, `access_token`, `refreshToken`, `refresh_token`, `password`, `secret`, `encrypted_*`, `wrapped_dek`, `wrappedDek`, `dek`, `kek`, `req.headers.authorization`, `req.headers.cookie`).
- ESLint `no-restricted-properties` rule banning `process.env` outside `src/lib/server/config/`. The `env.ts` module uses scoped `eslint-disable-next-line` comments — every disable is documented as the sole-reader exception. `drizzle.config.ts` carries one disable as the explicit dev-only exception authorized by the plan.
- UUIDv7 helper (`src/lib/server/ids.ts`) ready for every primary key from Plan 03 onward.
- SvelteKit + adapter-node + Paraglide-Vite-plugin + Drizzle-Kit configs all reference the right adapters and project paths, ready for downstream waves to layer on auth, DB schema, HTTP middleware, and i18n without touching scaffolding.

## Task Commits

Each task was committed atomically (with `--no-verify` per the parallel-execution contract):

1. **Task 1: Initialize package.json with locked deps + scripts + tsconfig + ESLint/Prettier** — `44c1d7e` (feat)
2. **Task 2: Write env config (sole process.env reader) + Pino logger + UUIDv7 helper + .env.example** — `c0067e7` (feat)

**Plan metadata:** to be added by the final commit step (SUMMARY.md + STATE.md + ROADMAP.md + REQUIREMENTS.md).

## Files Created/Modified

- `package.json` — locked-stack pins, pnpm scripts (dev/build/typecheck/lint/format/test/db:*), engines and packageManager fields
- `.nvmrc` — Node 22 pin
- `tsconfig.json` — strict + noUncheckedIndexedAccess + verbatimModuleSyntax + bundler resolution; extends SvelteKit's generated tsconfig
- `svelte.config.js` — adapter-node target with `out: 'build'`, `precompress: false`, `$lib` alias
- `vite.config.ts` — sveltekit plugin + paraglideVitePlugin (project: `./project.inlang`, outdir: `./src/lib/paraglide`, strategy: `['baseLocale']`); vitest config block included
- `drizzle.config.ts` — postgresql dialect, schema path glob, sole approved dev-time `process.env` exception with eslint-disable + explanatory comment
- `.gitignore` — node_modules, build, dist, .svelte-kit, src/lib/paraglide (compiled, regenerated on build), drizzle/meta, .env, coverage
- `.eslintrc.cjs` — TypeScript + Svelte parsers, the `no-restricted-properties` rule for `process.env`
- `.prettierrc` + `.prettierignore` — 2-space, double quotes, trailing commas, prettier-plugin-svelte
- `.env.example` — every required + optional variable with descriptive comments and the `openssl rand -base64 32` hint for KEK generation
- `src/lib/server/config/env.ts` — zod-validated env, sole `process.env` reader, KEK decode + length check + scrub
- `src/lib/server/logger.ts` — Pino with D-24 redact paths, pino-pretty gated on `NODE_ENV=development`
- `src/lib/server/ids.ts` — UUIDv7 helper

## Decisions Made

- **`pnpm-workspace.yaml` skipped despite frontmatter listing.** The plan's frontmatter `files_modified` field listed `pnpm-workspace.yaml`, but the action body, acceptance criteria, and D-01 ("flat single package") all explicitly require **no** workspace file. D-01 takes precedence — workspaces are a stated anti-goal. The frontmatter is interpreted as a list of files the plan is *allowed* to touch, not files it *must* create.
- **Exact pins on security-critical deps; semver `^` on dev/types.** Where RESEARCH.md verified an exact version (better-auth 1.6.9, drizzle-orm 0.45.2, hono 4.12.15, @hono/node-server 1.19.14, pg-boss 10.1.10, paraglide-js 2.16.1), the pin is exact (no `^`) so self-host operators get the exact verified combination. Tooling and `@types/*` use `^` because patch drift there has zero security or behavior implication.
- **`@hono/node-server` pinned at 1.19.14, NOT 2.0.0.** RESEARCH.md drift table is explicit: 2.0.0 was published 2026-04-21, six days before research; insufficient burn-in for production. Re-evaluate at Phase 2 start.
- **`pg-boss` pinned at 10.1.10 (not 12.x).** CLAUDE.md locks 10.x for the MVP; revisit at Phase 3 (where workers actually run).

## Deviations from Plan

None — plan executed exactly as written.

The single trivial fix was during Task 2 verification: my first `.env.example` placed the openssl hint inside the value placeholder (`openssl-rand-base64-32`, hyphenated). The acceptance criterion expected the readable form `openssl rand -base64 32`. I corrected the comment in-place before committing Task 2; nothing was committed in the wrong shape, so this was a pre-commit verification iteration, not a deviation.

---

**Total deviations:** 0
**Impact on plan:** Plan executed cleanly. No drift from the locked stack, no architectural changes, no missing dependencies discovered.

## Issues Encountered

- **Pre-existing uncommitted modifications to `.planning/` docs.** STATE.md, ROADMAP.md, config.json, multiple PLAN.md files, CONTEXT.md, and VALIDATION.md showed `M` status before this plan started — those are upstream artifacts from the planner/checker iterations and the parallel `01-02` agent. I staged only the Task-1 and Task-2 source files explicitly (no `git add .`); the orchestrator owns the final metadata commit which will fold those edits.
- **Parallel agent (`01-02`) created `tests/` and `vitest.config.ts` while this plan ran.** Visible as untracked entries in `git status`. Untouched here per the parallel-execution contract.

## User Setup Required

None. The plan does not introduce any external service configuration. `.env.example` documents what an operator (SaaS or self-host) will need to set before running `pnpm install && pnpm typecheck && pnpm dev` in subsequent waves; concrete OAuth client setup lands in Plan 05's USER-SETUP.

## Next Phase Readiness

- Plan 01-02 (test scaffolding, runs in parallel in Wave 1) can import `env` and `logger` from these files immediately.
- Plan 01-03 (db schema) can import `env.DATABASE_URL` and `uuidv7` directly.
- Plan 01-04 (envelope encryption) can use `env.KEK_VERSIONS` Map and `env.KEK_CURRENT_VERSION`.
- Plan 01-05 (Better Auth) can use `env.BETTER_AUTH_URL`, `env.BETTER_AUTH_SECRET`, `env.GOOGLE_CLIENT_ID`, `env.GOOGLE_CLIENT_SECRET`, `env.COOKIE_DOMAIN`.
- Plan 01-06 (Hono + proxy-trust) can use `env.TRUSTED_PROXY_CIDR` and `env.PORT`.
- No blockers. Wave 1 is positioned to land cleanly.

## Self-Check

- [x] `package.json` exists at `C:/projects/neotolis-game-promotion-diary/package.json` with all required pins
- [x] `src/lib/server/config/env.ts`, `logger.ts`, `ids.ts` exist
- [x] `.env.example`, `.eslintrc.cjs`, `.prettierrc`, `.prettierignore`, `tsconfig.json`, `svelte.config.js`, `vite.config.ts`, `drizzle.config.ts`, `.gitignore`, `.nvmrc` all exist
- [x] Commit `44c1d7e` (Task 1) exists in git log
- [x] Commit `c0067e7` (Task 2) exists in git log
- [x] Greppable invariant holds: every `process.env` reference in `src/` is inside `src/lib/server/config/env.ts` (verified via Grep tool)
- [x] No stubs introduced (this plan plants pure infrastructure config; nothing renders to a UI)

## Self-Check: PASSED

---
*Phase: 01-foundation*
*Plan: 01*
*Completed: 2026-04-27*
