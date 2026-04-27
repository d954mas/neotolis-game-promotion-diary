---
phase: 02-ingest-secrets-and-audit
plan: 01
subsystem: testing
tags: [traceability, requirements, roadmap, agents-md, vitest, wave-0, placeholder-tests, privacy, multi-tenancy]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: "Wave 0 placeholder pattern (it.skip with named-plan annotations); vitest test.projects unit/integration split; tests/integration/tenant-scope.test.ts and anonymous-401.test.ts as the Pattern-3 reference"
provides:
  - "REQUIREMENTS.md updated to post-refinement scope: GAMES-04 split into GAMES-04a (P2) + GAMES-04b/c/d (backlog); KEYS-01/02 + INGEST-01 deferred to Phase 3; coverage rows now 18 P2 / 12 P3 line-items; total 54 v1 + 3 backlog"
  - "ROADMAP.md Phase 2 success criteria #1/#2/#3 amended; Phase 3 success criteria #7/#8 added (deferred YouTube/Reddit keys + Reddit URL ingest); both Requirements lines refreshed"
  - "AGENTS.md ## Privacy & multi-tenancy section: 8 invariants (tenant scoping, cross-tenant 404, anonymous-401 sweep, audit append-only, DTO ciphertext-strip, Pino redact paths, no public dashboards, self-host parity) + 6 P0-block anti-patterns"
  - "12 placeholder test files (9 integration + 3 unit) carrying 42 it.skip stubs with EXACT plan-NN annotations downstream plans (02-04..02-09) flip to it()"
affects:
  - 02-02-eslint-tenant-scope-rule (cites AGENTS.md Privacy invariant #1)
  - 02-03-schema-and-migration (cites AGENTS.md Privacy invariant #4 audit append-only + #5 ciphertext columns)
  - 02-04-games-services (fills tests/integration/games.test.ts + tests/integration/game-listings.test.ts)
  - 02-05-api-keys-steam-service (fills tests/integration/secrets-steam.test.ts + audit.test.ts KEYS-06 stub)
  - 02-06-ingest-and-events-services (fills tests/integration/ingest.test.ts + events.test.ts + tests/unit/url-parser.test.ts)
  - 02-07-audit-read-service (fills tests/integration/audit.test.ts + tests/unit/audit-cursor.test.ts)
  - 02-08-routes-and-sweeps (fills tests/integration/log-redact.test.ts + tests/unit/audit-append-only.test.ts)
  - 02-09-theme-components-paraglide (fills tests/integration/theme.test.ts + empty-states.test.ts)
  - all future planners + checkers (read AGENTS.md Privacy section as the authoritative invariant list)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Wave 0 placeholder test discipline (Phase 1 invariant carried forward): every later task ships into a test file that already exists; named-plan it.skip annotation tells future executor which plan claims the stub"
    - "Privacy & multi-tenancy block in AGENTS.md as the contract any planner / executor / checker can cite by name (D-36 / DV-6)"
    - "Trigger-gated requirement deferral: GAMES-04b/c/d marked Backlog with explicit trigger condition (added when a real user requests the channel kind) instead of speculatively shipping all four"

key-files:
  created:
    - "tests/integration/games.test.ts"
    - "tests/integration/game-listings.test.ts"
    - "tests/integration/secrets-steam.test.ts"
    - "tests/integration/ingest.test.ts"
    - "tests/integration/events.test.ts"
    - "tests/integration/audit.test.ts"
    - "tests/integration/theme.test.ts"
    - "tests/integration/empty-states.test.ts"
    - "tests/integration/log-redact.test.ts"
    - "tests/unit/url-parser.test.ts"
    - "tests/unit/audit-cursor.test.ts"
    - "tests/unit/audit-append-only.test.ts"
  modified:
    - ".planning/REQUIREMENTS.md"
    - ".planning/ROADMAP.md"
    - "AGENTS.md"

key-decisions:
  - "GAMES-04 split via trigger gate (GAMES-04a P2, GAMES-04b/c/d Backlog) — proves social-handle pattern with one channel kind in v1, defers Telegram/Twitter/Discord until a real user request triggers each"
  - "KEYS-01 (YouTube key) + KEYS-02 (Reddit OAuth) + INGEST-01 (Reddit URL ingest) deferred Phase 2 → Phase 3 — they land alongside their respective poll adapters (poll.youtube / poll.reddit) so the secret UI ships with a working consumer instead of an orphan"
  - "Phase 3 ROADMAP success criterion ordering: deferred KEYS / INGEST bullets inserted as #7 + #8 BEFORE the Phase 1-deferred smoke extension (which renumbers from #7 to #9) — the deferred Phase 2 work is logically sibling to Phase 3 polling, the smoke gate is the per-phase tail"
  - "AGENTS.md Privacy & multi-tenancy section ordering: invariant #1 (tenant scoping) → #2 (404 not 403) → #3 (anonymous-401 sweep) → #4 (audit append-only) → #5 (DTO ciphertext-strip) → #6 (Pino redact) → #7 (no public dashboards) → #8 (self-host parity); P0-block anti-patterns list mirrors the invariants for review-time grep"

patterns-established:
  - "Privacy invariant block in AGENTS.md is the single source planners/executors/checkers cite by name (e.g. 'AGENTS.md Privacy invariant #4 forbids audit_log UPDATE/DELETE grants')"
  - "Wave 0 plan body == doc moves + test scaffolds in one atomic commit per task (Phase 1 plan 01-02 is the model)"
  - "Test file headers carry a paragraph reminding future executors: if the test you need is NOT in the it.skip list below, fix it in this Wave 0 plan, NOT by silently adding a new it() in your plan's commit"

requirements-completed: []  # This plan ships no P2 REQ-IDs by design (frontmatter requirements: []) — its job is the doc move itself, not delivery of any P2 requirement.

# Metrics
duration: ~5min
completed: 2026-04-28
---

# Phase 2 Plan 01: Traceability Uplift + Wave 0 Test Scaffolding Summary

**REQUIREMENTS / ROADMAP / AGENTS.md updated to post-refinement Phase 2 scope (16 distinct REQ-IDs, 18 line-items; KEYS-01/02 + INGEST-01 → P3; GAMES-04a P2 + GAMES-04b/c/d Backlog) + 12 placeholder test files carrying 42 named-plan it.skip stubs.**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-04-27T20:01:39Z
- **Completed:** 2026-04-27T20:06:37Z
- **Tasks:** 2
- **Files modified:** 15 (3 docs + 12 new test files)

## Accomplishments

- Locked Phase 2 scope as a contract: REQUIREMENTS.md and ROADMAP.md now agree on the 18 P2 line-items (16 distinct REQ-IDs after GAMES-04a split + KEYS/INGEST deferral) so downstream plans cannot drift.
- AGENTS.md gained a load-bearing `## Privacy & multi-tenancy` section future planners / executors / checkers cite by invariant number (e.g. "AGENTS.md Privacy #4 forbids audit_log UPDATE/DELETE grants").
- Wave 0 invariant carried from Phase 1: every Phase 2 implementing plan (02-04..02-09) now has a pre-existing test file with the EXACT it.skip stubs it must flip — vitest reports 42 skipped tests across the 12 new files, no source imports, no broken references.

## Task Commits

Each task was committed atomically with `--no-verify` (parallel-execution flag from orchestrator; hooks validated once after wave completion):

1. **Task 1: REQUIREMENTS / ROADMAP / AGENTS traceability uplift** — `3b6f558` (docs)
2. **Task 2: Wave 0 placeholder test files (12 files, 42 it.skip stubs)** — `bd1c20e` (test)

_Plan metadata commit: appended after STATE.md / ROADMAP.md updates (final commit below)._

## Files Created/Modified

**Created (12 placeholder test files):**

- `tests/integration/games.test.ts` — 4 it.skip stubs for GAMES-01 (create) and GAMES-02 (soft-delete + restore); plan 02-04 fills.
- `tests/integration/game-listings.test.ts` — 2 it.skip stubs for GAMES-04a (attach + M:N); plan 02-04 fills.
- `tests/integration/secrets-steam.test.ts` — 5 it.skip stubs for KEYS-03 (encrypted at rest), KEYS-04 (DTO strip), KEYS-05 (rotate ×2), KEYS-06 (audit metadata); plan 02-05 fills.
- `tests/integration/ingest.test.ts` — 8 it.skip stubs for INGEST-02..04 + Twitter event + Reddit-deferred inline message; plan 02-06 fills.
- `tests/integration/events.test.ts` — 4 it.skip stubs for EVENTS-01..03; plan 02-06 fills.
- `tests/integration/audit.test.ts` — 4 it.skip stubs for PRIV-02 (page/cursor/filter/cross-tenant) + KEYS-06 (ip via proxy-trust); plans 02-05 + 02-07 fill.
- `tests/integration/theme.test.ts` — 3 it.skip stubs for UX-01 (SSR no-flash + POST + cookie reconciliation); plan 02-09 fills.
- `tests/integration/empty-states.test.ts` — 2 it.skip stubs for UX-03 (empty-state copy + Paraglide invariant); plan 02-09 fills.
- `tests/integration/log-redact.test.ts` — 1 it.skip stub for cross-cutting Pino redact on new ciphertext field names; plan 02-08 fills.
- `tests/unit/url-parser.test.ts` — 5 it.skip stubs for URL canonicalization (youtube watch/short/shorts/live, x.com → twitter.com, reddit_deferred); plan 02-06 fills.
- `tests/unit/audit-cursor.test.ts` — 2 it.skip stubs for cursor encode/decode round-trip + malformed input rejection; plan 02-07 fills.
- `tests/unit/audit-append-only.test.ts` — 2 it.skip stubs for writeAudit module export shape (no update / no delete); plan 02-08 fills.

**Modified:**

- `.planning/REQUIREMENTS.md` — GAMES-04 split into GAMES-04a/b/c/d; KEYS-01/02 + INGEST-01 traceability rows moved Phase 2 → Phase 3; coverage rows updated to 18 P2 + 12 P3 line-items; total now `54 v1 + 3 backlog`.
- `.planning/ROADMAP.md` — Phase 2 Requirements line + success criteria #1 (channels narrowed to YouTube), #2 (Reddit deferred message + Twitter/Telegram event create), #3 (Steam-only key paste); Phase 3 Requirements line + new success criteria #7 + #8 (deferred KEYS / INGEST); existing smoke extension renumbered from #7 to #9.
- `AGENTS.md` — new top-level `## Privacy & multi-tenancy` section between Constraints and Philosophy: 8 invariants + 6 P0-block anti-patterns, all citable by number from downstream review checklists.

## Decisions Made

- **GAMES-04 split:** keep the typed-example pattern (GAMES-04a YouTube channels) in P2 to validate the social-handle data model; defer GAMES-04b/c/d (Telegram/Twitter/Discord) to backlog gated on a real user request — avoids speculatively shipping four channel kinds when one proves the pattern.
- **KEYS-01 + KEYS-02 + INGEST-01 → Phase 3:** the YouTube key paste UI, Reddit OAuth flow, and Reddit URL ingest land alongside their respective poll adapters (`poll.youtube`, `poll.reddit`) so each secret ships with a working consumer rather than as an orphan UI.
- **Phase 3 success-criterion renumbering:** the Phase 1-deferred smoke extension that was bullet 7 was renumbered to bullet 9 to make room for the two newly deferred Phase 2 bullets at positions 7 and 8 — keeps the smoke gate as the per-phase tail and logically groups the deferred Phase 2 work with Phase 3 polling.
- **AGENTS.md Privacy section placement:** inserted between Constraints (subsection of Project) and Philosophy as a top-level `## Privacy & multi-tenancy` so downstream plans can cite "AGENTS.md Privacy invariant #N" without scrolling through Project narrative.

## Deviations from Plan

None - plan executed exactly as written.

The plan instructed inserting two new Phase 3 success criteria "numbered 8 and 9, before the Phase 3 smoke extension bullet". I interpreted this faithfully: the existing smoke extension was bullet 7, so to put new bullets BEFORE it AND number them logically, the new bullets occupy positions 7 + 8 and the smoke extension was renumbered to position 9. The plan's literal "numbered 8 and 9" appears to have been an off-by-one against the existing bullet count; "before the smoke extension bullet" is unambiguous and was honored.

## Issues Encountered

None. Both tasks executed cleanly. Vitest parsed all 12 new test files and reported the expected 42 skipped tests (4+2+5+8+4+4+3+2+1+5+2+2 = 42) — the post-W-6 count from the plan body matches exactly.

## User Setup Required

None - no external service configuration required for this Wave 0 plan. The Phase 2 user-setup story (KEK rotation runbook, optional Steam Web API key) lands in plan 02-11.

## Next Phase Readiness

- **For parallel Wave 0 plans (02-02 + 02-03):** AGENTS.md Privacy invariant #1 explicitly references `eslint-plugin-tenant-scope/no-unfiltered-tenant-query` (plan 02-02 builds it) and tenant-scope test (plan 01-07 already lands the file pattern). Plan 02-03 (schema + migration) can cite Privacy invariants #4 (audit append-only) and #5 (ciphertext column names) directly.
- **For Wave 1 plans (02-04..02-07):** every implementing plan now has a pre-existing test file with EXACT named stubs — no plan needs to create a new test file from scratch; each just flips `it.skip` → `it` and adds assertions. The Wave 0 invariant from Phase 1 is preserved.
- **For Phase 3:** ROADMAP and REQUIREMENTS now agree on the deferred work scope (KEYS-01/02 + INGEST-01); Phase 3 planner can scope these alongside `poll.youtube` and `poll.reddit` adapters without surprise.

## Self-Check: PASSED

- All 12 placeholder test files exist on disk.
- SUMMARY.md exists at `.planning/phases/02-ingest-secrets-and-audit/02-01-traceability-and-test-scaffolds-SUMMARY.md`.
- Both task commits present in `git log`: `3b6f558` (Task 1 docs), `bd1c20e` (Task 2 tests).
- Verify command passed (REQUIREMENTS.md / ROADMAP.md / AGENTS.md edits validated via grep gate).
- Vitest reports 42 skipped tests across the 12 new files (no parse failures, no source imports).

---
*Phase: 02-ingest-secrets-and-audit*
*Completed: 2026-04-28*
