---
phase: 02-ingest-secrets-and-audit
plan: 02
subsystem: testing
tags: [eslint, ast, tenant-scope, drizzle, rule-tester, security]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: "src/lib/server/services/ shape (userId-first signature), Drizzle 0.45.2 query method-chain shape, @typescript-eslint/eslint-plugin@^8.12 with transitive @typescript-eslint/utils + RuleTester"
provides:
  - "eslint-plugin-tenant-scope/no-unfiltered-tenant-query — AST rule that flags Drizzle queries against tenant-owned tables missing a userId filter"
  - "Linked plugin wired in eslint.config.js as `error` for src/lib/server/services/**"
  - "Single-loop chain walker that ping-pongs through MemberExpression / CallExpression / AwaitExpression so the entire .from(<T>).where(...) / .update(<T>).set(...).where(...) chain is captured"
  - "RuleTester unit suite (5 valid + 5 invalid) using @typescript-eslint/utils/ts-eslint RuleTester (the standalone @typescript-eslint/rule-tester package is not installed; this transitive path is the load-bearing fallback the plan authorised)"
affects:
  - "All Phase 2 service plans (02-04 games, 02-05 api-keys-steam, 02-06 ingest-and-events, 02-07 audit-read) — every Drizzle query they add against tenant-owned tables is now lint-checked"
  - "All future phases that touch tenant-owned tables (Phase 3 ingest workers, Phase 5 reddit, Phase 6 admin)"

# Tech tracking
tech-stack:
  added:
    - "eslint-plugin-tenant-scope (local link: dep, version 0.0.0, private)"
  patterns:
    - "Custom ESLint AST rule via ESLintUtils.RuleCreator.withoutDocs"
    - "RuleTester wired to vitest via static describe/it/itOnly assignment"
    - "Local linked plugin pattern (`link:./eslint-plugin-tenant-scope`) — avoids publishing an internal-only rule to npm while keeping resolution standard"

key-files:
  created:
    - "eslint-plugin-tenant-scope/no-unfiltered-tenant-query.js — the AST rule"
    - "eslint-plugin-tenant-scope/index.js — plugin export"
    - "eslint-plugin-tenant-scope/package.json — local link package boilerplate"
    - "tests/unit/tenant-scope-eslint-rule.test.ts — 10-case RuleTester suite"
    - ".planning/phases/02-ingest-secrets-and-audit/deferred-items.md — out-of-scope tracker"
  modified:
    - "eslint.config.js — registers tenant-scope plugin and turns rule on `error` for services"
    - "package.json — adds eslint-plugin-tenant-scope link: dev-dep"
    - "pnpm-lock.yaml — materialises the link"

key-decisions:
  - "TENANT_TABLES set is the eight Phase-2 tenant-owned tables: games, gameSteamListings, youtubeChannels, gameYoutubeChannels, apiKeysSteam, trackedYoutubeVideos, events, auditLog. ALLOWLIST is the four Better Auth core tables (user/session/account/verification) plus Phase-5 subredditRules (shared seed data). Phase-3 worker-internal tables (poll queues etc.) are not yet on either list — when Phase 3 lands them, the planner explicitly classifies them."
  - "RuleTester import path is @typescript-eslint/utils/ts-eslint (the deprecated re-export) NOT @typescript-eslint/rule-tester. The standalone rule-tester package is not in the dependency graph; the plan explicitly authorised this fallback. The deprecation warning is benign because the wrapped class IS ESLint 9's own RuleTester via inheritance, and we use it as a flat-config tester via languageOptions.parser. If we ever upgrade to the standalone package, the only diff is the import line."
  - "Single-loop chain walker (over ME / CE / AE) replaces the original two-loop walk that exited too early on `tx.update(<T>).set({...}).where(...)`. The bug was caught by RuleTester case 3 (a real Rule 1 deviation) and is now load-bearing — without this fix, every Phase 2 service that uses the update form would silently bypass the lint check."
  - "Severity is `error` not `warn` — services that miss userId fail lint, fail CI, never merge. Disable comments require `--` justification per AGENTS.md Pitfall 7."

patterns-established:
  - "Two-layer Pattern 1 enforcement: this rule (STRUCTURAL, lint-time) + tests/integration/tenant-scope.test.ts (BEHAVIORAL, runtime). Neither alone suffices; both required."
  - "Local-linked plugin pattern for project-internal lint rules — keeps the rule code in the same repo, no publishing dance, no transitive trust risk"
  - "RuleTester-as-vitest pattern: assign RuleTester.{describe,it,itOnly} to vitest's describe/it/it.only and assign a no-op afterAll for forward-compat with the standalone @typescript-eslint/rule-tester package"

requirements-completed: []

# Metrics
duration: 7min
completed: 2026-04-27
---

# Phase 2 Plan 02: ESLint tenant-scope rule Summary

**Custom ESLint AST rule `tenant-scope/no-unfiltered-tenant-query` shipped as a local linked plugin, wired as `error` for `src/lib/server/services/**`, with a 10-case RuleTester suite that proved out a real chain-walker bug before a single Phase 2 service line shipped.**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-04-27T20:11:03Z
- **Completed:** 2026-04-27T20:17:43Z
- **Tasks:** 2 (TDD: rule landing, then RuleTester suite)
- **Files modified:** 6 created (3 plugin files + 1 test + 1 deferred-items + 1 SUMMARY) + 3 modified (eslint.config.js, package.json, pnpm-lock.yaml) = 9

## Accomplishments

- AST rule that walks Drizzle method chains and reports any `.from(<TENANT>) / .update(<TENANT>) / .delete(<TENANT>)` whose surrounding chain text omits a `userId`-bearing `.where(...)`.
- Local linked plugin pattern (no npm publish, no transitive trust risk) — `eslint-plugin-tenant-scope/` lives next to `src/`, resolved via `link:./eslint-plugin-tenant-scope`.
- 10-case RuleTester suite: 5 valid (userId filter present, allowlisted tables, tx-binding variant, delete form) + 5 invalid (missing userId on select / no-where / update / delete / select-with-non-userId-where) — caught a real bug in the chain walker before any Phase 2 service shipped.
- Phase 1 src/ lints clean — no Phase 1 tenant leak surfaced. The rule's first invocation against an existing codebase is green, which is the strongest "the rule isn't a vacuous-pass" signal we can ship without a planted regression.

## Task Commits

1. **Task 1: Create plugin + register in eslint.config.js** — `407019e` (feat)
2. **Task 2: RuleTester unit suite + Rule 1 chain-walk fix** — `ff06248` (test)

_TDD shape: Task 1 wrote the rule and verified it fired manually; Task 2 wrote the RuleTester suite that immediately caught the chain-walk bug, fixing it under Rule 1 in the same commit per the deviation policy. Two commits total, one per task._

## Files Created/Modified

- `eslint-plugin-tenant-scope/no-unfiltered-tenant-query.js` (created) — the AST rule itself: TENANT_TABLES + ALLOWLIST_TABLES sets, `from`-handler, `update|delete`-handler, single-loop chain walker, reports `missingUserIdFilter` when the chain text lacks `\.where\s*\(\s*[\s\S]*?\buserId\b[\s\S]*?\)`.
- `eslint-plugin-tenant-scope/index.js` (created) — `export default { rules: { "no-unfiltered-tenant-query": noUnfilteredTenantQuery } }`.
- `eslint-plugin-tenant-scope/package.json` (created) — `"name": "eslint-plugin-tenant-scope"`, `"type": "module"`, `"private": true`.
- `eslint.config.js` (modified) — added `import tenantScope from "./eslint-plugin-tenant-scope/index.js"` plus a config block that registers the plugin and turns the rule on as `error` for `src/lib/server/services/**/*.ts(x)`.
- `package.json` (modified) — added `"eslint-plugin-tenant-scope": "link:./eslint-plugin-tenant-scope"` in `devDependencies`.
- `pnpm-lock.yaml` (modified) — link entry added.
- `tests/unit/tenant-scope-eslint-rule.test.ts` (created) — RuleTester suite with 10 cases.
- `.planning/phases/02-ingest-secrets-and-audit/deferred-items.md` (created) — tracks pre-existing prettier drift in `package.json` (and 51 other repo files) for a follow-up `chore/format` PR.

## Decisions Made

See `key-decisions` in frontmatter for the load-bearing four. In short:

- TENANT_TABLES = 8 Phase-2 tenant tables. ALLOWLIST = 4 Better Auth + 1 Phase 5. Phase 3 will classify any new tables it lands.
- RuleTester comes from `@typescript-eslint/utils/ts-eslint` (the deprecated transitive path), NOT the standalone `@typescript-eslint/rule-tester` package. Plan authorised this fallback because the standalone package is not in the dependency graph and the deprecated wrapper IS ESLint 9's own RuleTester via inheritance.
- Severity = `error` (not `warn`). Disable requires `--` justification.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Single-loop chain walker replaces broken two-loop walk**
- **Found during:** Task 2 (RuleTester suite — case `tx.update(events).set({deletedAt}).where(and(eq(events.userId, userId), eq(events.gameId, gameId)))` was reported as invalid even though it has a userId filter).
- **Issue:** The plan-shipped rule walked `MemberExpression` parents in one loop, then `CallExpression` / `AwaitExpression` parents in a separate loop. Drizzle update chains alternate ME / CE / ME / CE, so the first-loop-then-second-loop pattern exited at the first ME after a CE, missing the outer `.where(...)` call entirely. Result: every Phase 2 update form would silently bypass the rule.
- **Fix:** Consolidated both loops into a single `while (chain && (chain.type === "MemberExpression" || chain.type === "CallExpression" || chain.type === "AwaitExpression")) chain = chain.parent` that ping-pongs through all three node kinds until it hits a statement-shape parent. Applied identically to both the `from`-handler and the `update|delete`-handler.
- **Files modified:** `eslint-plugin-tenant-scope/no-unfiltered-tenant-query.js`
- **Verification:** RuleTester now reports 10/10 passing (was 9/10 before fix); CLI lint of stub services with `db.select().from(games).where(eq(games.id, gid))` still fires the rule; same query with `where(and(eq(games.userId, userId), eq(games.id, gid)))` is silent; `pnpm exec eslint src/` is clean (no Phase 1 leak).
- **Committed in:** `ff06248` (Task 2 commit)

**2. [Rule 3 - Blocking] RuleTester import path fallback**
- **Found during:** Task 2 (test file authoring — the plan's primary import `@typescript-eslint/rule-tester` is not in `node_modules/`).
- **Issue:** The plan named `@typescript-eslint/rule-tester` as the primary import and `@typescript-eslint/utils/ts-eslint` as the fallback. The standalone `@typescript-eslint/rule-tester` package is NOT a transitive dep via `@typescript-eslint/eslint-plugin@^8.12` (only `@typescript-eslint/utils` is). Without the fallback the test file would fail at `import` time.
- **Fix:** Imported `RuleTester` from `@typescript-eslint/utils/ts-eslint` (the plan-authorised fallback). The wrapped class is ESLint 9's own `RuleTester` via inheritance, so flat-config style (`languageOptions: { parser: tsParser }`) works as intended.
- **Files modified:** `tests/unit/tenant-scope-eslint-rule.test.ts`
- **Verification:** `pnpm exec vitest run tests/unit/tenant-scope-eslint-rule.test.ts` reports 10/10 passing.
- **Committed in:** `ff06248` (Task 2 commit)

**3. [Rule 3 - Blocking] Prettier formatting on new files**
- **Found during:** Task 1 (after writing the rule + plugin files, `pnpm exec prettier --check` flagged them — would fail the CI lint job which runs `prettier --check .`).
- **Issue:** New files don't match prettier's formatting expectations (the rule file had multi-line ternary that prettier collapsed; the test file had array-shape preferences).
- **Fix:** Ran `pnpm exec prettier --write` on the new files only.
- **Files modified:** `eslint.config.js`, `eslint-plugin-tenant-scope/no-unfiltered-tenant-query.js`, `tests/unit/tenant-scope-eslint-rule.test.ts`.
- **Verification:** `pnpm exec prettier --check` on those files passes.
- **Committed in:** `407019e` (Task 1) and `ff06248` (Task 2).

---

**Total deviations:** 3 auto-fixed (1 Rule-1 bug, 2 Rule-3 blockers).
**Impact on plan:** All three fixes were necessary for correctness or to land the plan. The Rule-1 chain-walker fix is load-bearing — without it the rule is a vacuous-pass on the update form. No scope creep beyond the plan.

## Issues Encountered

- 52 pre-existing prettier-style drift files across the repo (including `package.json`). Out of scope for this plan per the SCOPE BOUNDARY policy. Logged to `.planning/phases/02-ingest-secrets-and-audit/deferred-items.md` for a follow-up `chore/format` PR.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- The structural Pattern 1 defense is now in place. Every Phase 2 service plan (02-04 games, 02-05 api-keys-steam, 02-06 ingest-and-events, 02-07 audit-read) now writes its Drizzle queries under lint enforcement.
- Plan 02-03 (schema + migration) can land next; it doesn't trigger the rule directly (schema files are not in `src/lib/server/services/**`), but the tables it creates feed straight into the TENANT_TABLES set used by this rule.
- The behavioural half of Pattern 1 (cross-tenant integration test) was scaffolded in plan 02-01 and gets its real assertions in plan 02-08.

## Self-Check: PASSED

- `eslint-plugin-tenant-scope/no-unfiltered-tenant-query.js` — FOUND
- `eslint-plugin-tenant-scope/index.js` — FOUND
- `eslint-plugin-tenant-scope/package.json` — FOUND
- `tests/unit/tenant-scope-eslint-rule.test.ts` — FOUND
- `eslint.config.js` carries `tenant-scope/no-unfiltered-tenant-query` reference — FOUND
- `package.json` carries `eslint-plugin-tenant-scope` link dep — FOUND
- Commit `407019e` — FOUND
- Commit `ff06248` — FOUND
- `pnpm exec vitest run tests/unit/tenant-scope-eslint-rule.test.ts` — 10/10 passing
- `pnpm exec eslint src/` — clean (no Phase 1 leak)

---
*Phase: 02-ingest-secrets-and-audit*
*Completed: 2026-04-27*
