# Phase 02.2 — Deferred Items

Out-of-scope discoveries logged during plan execution. Each item documents a
finding that does NOT belong to the current plan's scope but should be addressed
later.

---

## Plan 02.2-02 — flaky updatedAt timing test

**Discovered:** 2026-05-01 during execution of Plan 02.2-02
**File:** `tests/integration/events-attach.test.ts:332`
**Test:** `Plan 02.1-28: attachEventToGames bumps events.updatedAt`

**Issue:** The test asserts `after.updatedAt.getTime() >= beforeTs.getTime()`
where `beforeTs` is set by Postgres' `defaultNow()` (DB clock) on INSERT and
`after.updatedAt` is set by JS `new Date()` (process clock) on UPDATE. When
the DB clock is slightly ahead of the process clock — typical with Docker
containerized Postgres — the `after` value can be LESS than `beforeTs` even
after the 5ms `setTimeout` sleep, producing a race-condition flake.

**First observed run:**
- `1777627510265` (after, JS clock) vs `1777627510508` (before, DB clock).
- Re-running the same test passes.

**Out of scope rationale:** Plan 02.2-02 wires `assertQuota` into the create
paths and lands the 7 quota integration tests. This flaky test was already
flaky in master (last touched in commit `4846fa8` — Phase 2 PR #10) and is
not affected by the Plan 02.2-02 changes (the quota guard runs BEFORE the
INSERT and does not touch the updatedAt path).

**Suggested fix (future plan):** either use DB-side `now()` for `attachEventToGames`'s
updatedAt UPDATE (single-clock comparison) or change the assertion to allow a
small clock-skew tolerance. Phase 6 housekeeping bucket.

---

## Plan 02.2-06 — pre-existing unit test failures (env not seeded)

**Discovered:** 2026-05-01 during execution of Plan 02.2-06
**Verified pre-existing** via `git stash && pnpm test:unit -- <file>` on Plan
02.2-06 task-2 baseline (commit `c28ba9a`).

Three unit test files / one assertion fail on the baseline (before Plan 02.2-06
landed any change). All are caused by env vars not being seeded before module
import in the test environment. These are unrelated to deploy templates.

- `tests/unit/dto.test.ts` — env not seeded
- `tests/unit/feed-loader.test.ts` — env not seeded
- `tests/unit/logger.test.ts > logger redaction > Plan 02.1-36` — env not seeded

Plan 02.2-06's 12 new tests (`scripts.test.ts` × 6 + `compose-prod.test.ts` × 6)
all PASS. The pre-existing failures are tracked here for whichever plan owns
the env-seed pattern follow-up.
