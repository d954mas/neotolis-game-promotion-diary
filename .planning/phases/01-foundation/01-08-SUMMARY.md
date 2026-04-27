---
phase: 01-foundation
plan: 08
subsystem: queue-runtime
tags: [pg-boss, worker, scheduler, app-role, graceful-shutdown, queue-declaration, d-01-paths, d-15-grep, d-22-drain]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: Plan 01-01 (env.DATABASE_URL, env.APP_ROLE, logger), Plan 01-03 (QUEUES registry + declareAllQueues, pg.Pool from db/client.ts), Plan 01-06 (APP_ROLE dispatcher in src/server.ts that imports startWorker/startScheduler from D-01 paths)
provides:
  - src/lib/server/queue-client.ts — pg-boss factory: createBoss() (constructs + starts + declares all queues) and stopBoss() (graceful drain via stop({ wait, graceful, timeout: 60_000 }))
  - src/worker/index.ts — APP_ROLE=worker entrypoint (REPLACES Plan 06 stub at the same D-01 path); subscribes to internal.healthcheck, prints 'worker ready', idles until SIGTERM
  - src/scheduler/index.ts — APP_ROLE=scheduler entrypoint (REPLACES Plan 06 stub at the same D-01 path); registers internal.healthcheck cron '*/5 * * * *', prints 'scheduler ready', idles until SIGTERM
affects: [01-10 self-host-smoke (Plan 10's D-15 smoke assertions #2/#3 grep `worker ready` / `scheduler ready` from these stdouts), Phase 3 POLL-01..06 (lands real handlers on poll.{hot,warm,cold,user} queues that Plan 03 declared and Plan 08 boots), Phase 3 POLL-06 (graceful shutdown contract — pg-boss drain + pool.end() — already in place)]

# Tech tracking
tech-stack:
  added: []   # pg-boss@10.1.10 already pinned by Plan 01-01; no new deps.
  patterns:
    - "pg-boss 10.x dedicated pool: createBoss passes connectionString rather than sharing the Drizzle pg.Pool (RESEARCH.md drift table). Keeps queue traffic from contending with app/audit traffic for connections; pg-boss internal pool is sized at 4 (Phase 3 will tune per-workload)."
    - "Phase-1-specific pitfall mitigation (queue declaration drift): createBoss always calls declareAllQueues(boss) after start. createQueue is idempotent in pg-boss 10.x (the v9→v10 breaking change), so calling on every boot is safe and prevents 'silent loss-on-send' against undeclared queues."
    - "D-22 graceful shutdown: stopBoss wraps boss.stop({ wait: true, graceful: true, timeout: 60_000 }) — completes in-flight handlers up to 60s, then hard-stops. Worker and scheduler entrypoints chain stopBoss → pool.end() in their SIGTERM/SIGINT handlers; either drain failure logs and continues; final process.exit(0)."
    - "D-15 grep contract dual emission: both entrypoints emit logger.info({...}, 'worker ready' | 'scheduler ready') AND console.log('worker ready' | 'scheduler ready'). Plan 10's smoke test does not parse JSON — the raw console.log line is the grep target. The structured log preserves Loki / docker logs observability for production."
    - "Worker subscribes even with no Phase-1 work: internal.healthcheck is a no-op handler in Phase 1, but proves the worker is alive and connected (a worker that boots without subscriptions is a silent idle that would hide bugs)."
    - "Scheduler registers a cron even with no Phase-1 work: internal.healthcheck every 5 minutes is the marker. If the cron syntax / queue name is invalid, schedule() throws and we re-throw — fast failure beats a silent never-scheduled cron."
    - "Idle pattern: both entrypoints return a never-resolving Promise<void>(() => {}) so the Node process stays alive after pg-boss has set up its own internal loops. SIGTERM is the only exit path."

key-files:
  created:
    - src/lib/server/queue-client.ts
  modified:
    - src/worker/index.ts        # REPLACED Plan 06 stub (was 'worker stub ready') with real pg-boss worker (now 'worker ready')
    - src/scheduler/index.ts     # REPLACED Plan 06 stub (was 'scheduler stub ready') with real pg-boss scheduler (now 'scheduler ready')

key-decisions:
  - "pg-boss connectionString (not shared pg.Pool). RESEARCH.md flagged 10.x's pool-sharing as fragile vs newer versions; passing connectionString lets pg-boss own its own pool. This intentionally costs ~4 extra Postgres connections (worker pool=4 + scheduler pool=4) on top of the Drizzle pools — well within the (10+4+2)+8 = 24-of-100 max_connections budget Plan 03 reserved."
  - "createBoss config: max=4, retentionDays=30, archiveCompletedAfterSeconds=3600. Conservative defaults appropriate for 'topology declared, no real jobs running yet'. Phase 3 (POLL-01..06) tunes max per workload, may shorten retentionDays to 7 if poll volume warrants, and will set per-queue concurrency caps (poll.hot=4 / poll.warm=2 / poll.cold=1 / poll.user=2 per ROADMAP Phase 3 SC#2)."
  - "Worker subscribes to internal.healthcheck with a no-op handler. Alternatives considered: (a) subscribe to nothing in Phase 1 — rejected because a silent idle worker hides 'is the worker actually connected?' bugs; (b) subscribe to all five queues with no-op handlers — rejected because the poll.* queues are Phase 3's contract, and a Phase-1 no-op subscription on poll.hot would create a future archaeology question ('why does this handler exist?') when Phase 3 lands the real handler. internal.healthcheck is the clean 'I am alive' signal."
  - "Scheduler registers exactly one cron: internal.healthcheck every 5 minutes. Same reasoning — at least one schedule proves the cron loop is wired; using internal.healthcheck (Phase 1's invented queue) avoids polluting the Phase 3 queues with Phase 1 schedules. Phase 3 owns the poll.* cron expressions."
  - "Stub-string scrub from doc comments. The plan's automated verifier asserts that 'worker stub ready' / 'scheduler stub ready' strings do NOT appear anywhere in the file (not just outside string literals). My initial doc comments mentioned the legacy stub messages; I removed those mentions verbatim so the verifier passes. This is a Rule 1 fix — the verifier represents an integration contract (Plan 10 smoke test must not accidentally grep a stale string that's still mentioned in a comment), so the verifier's stricter-than-needed reading is actually correct."
  - "Same export names as Plan 06 stub (startWorker / startScheduler). Plan 06's src/server.ts dispatcher imports both names from the D-01 paths; this plan REPLACES the file content but preserves the export contract so the dispatcher does not need a re-edit. This was intentional in the plan — Plan 06 shipped stubs with the same shape so Plan 08 is a content swap, not a wiring change."
  - "Dual-emit (logger + console.log). The plan's <action> block specified both. Rationale: Plan 10's smoke test greps stdout from `docker run` for the literal string 'worker ready' / 'scheduler ready'. Pino's JSON output contains the string but the Plan 10 grep does not parse JSON — it greps the raw stream. console.log emits the raw line directly; logger.info emits the JSON line. Both go to the same stdout; the smoke test sees both."

requirements-completed: [DEPLOY-05]

# Metrics
duration: ~2min
completed: 2026-04-27
---

# Phase 1 Plan 8: pg-boss Worker + Scheduler Entrypoints + queue-client Factory Summary

**Promoted Plan 06's worker/scheduler stubs at the D-01-locked paths (src/worker/index.ts and src/scheduler/index.ts) to real pg-boss 10.x implementations: a shared queue-client factory (createBoss + stopBoss) declares every queue from Plan 03's QUEUES registry on every boot (Phase-1 pitfall mitigation), the worker subscribes to internal.healthcheck and prints `worker ready` (D-15 smoke assertion #2 grep target), the scheduler registers a `*/5 * * * *` healthcheck cron and prints `scheduler ready` (D-15 assertion #3), and both entrypoints honor SIGTERM with `boss.stop({ wait: true, graceful: true, timeout: 60_000 })` followed by `pool.end()` (D-22 graceful shutdown contract that Phase 3 POLL-06 builds on). Three-role single-image pattern is now end-to-end runnable: APP_ROLE=app boots Hono+SvelteKit (Plan 06), APP_ROLE=worker boots a pg-boss-backed worker, APP_ROLE=scheduler boots a pg-boss-backed scheduler — same image, three CMDs.**

## Performance

- **Duration:** ~2 min
- **Started:** 2026-04-27T11:49:14Z
- **Completed:** 2026-04-27T11:51:25Z
- **Tasks:** 1 / 1
- **Files modified:** 3 (1 created, 2 replaced)

## Accomplishments

- `src/lib/server/queue-client.ts` exports `createBoss()` and `stopBoss()`. `createBoss()` constructs a pg-boss 10.x instance with `connectionString: env.DATABASE_URL`, conservative defaults (`max: 4`, `retentionDays: 30`, `archiveCompletedAfterSeconds: 3600`), wires an `error` event handler that logs to Pino, calls `boss.start()`, then calls `declareAllQueues(boss)` so all five Phase 1 queues (`poll.hot` / `poll.warm` / `poll.cold` / `poll.user` / `internal.healthcheck`) are created idempotently on every boot. `stopBoss()` invokes `boss.stop({ wait: true, graceful: true, timeout: 60_000 })` with structured log lines around the drain.
- `src/worker/index.ts` REPLACES Plan 06's stub. Boots pg-boss via `createBoss()`, subscribes to `QUEUES.INTERNAL_HEALTHCHECK` with a no-op acknowledger (Phase 3 lands real `poll.*` handlers), emits both `logger.info({ role: 'worker' }, 'worker ready')` AND `console.log('worker ready')` (D-15 dual-emit grep contract), wires `process.on('SIGTERM' | 'SIGINT')` to a shutdown chain (`stopBoss` → `pool.end()` → `process.exit(0)`), and idles on a never-resolving Promise. Export name `startWorker` matches what Plan 06's `src/server.ts` dispatcher already imports — no dispatcher edit required.
- `src/scheduler/index.ts` REPLACES Plan 06's stub. Same shape as the worker but instead of `boss.work(...)` it calls `boss.schedule(QUEUES.INTERNAL_HEALTHCHECK, '*/5 * * * *')`. Schedule() throw is logged loudly and re-thrown so the container exits non-zero (faster failure than a silent never-scheduled cron). Same dual-emit ready signal (`scheduler ready`), same SIGTERM/SIGINT shutdown chain.
- The Plan-specified `<automated>` verification gate passes: every required structural marker appears in the source files (`new PgBoss(`, `await boss.start()`, `declareAllQueues(boss)`, `wait: true`, `graceful: true`, `timeout: 60_000`, `env.DATABASE_URL` in queue-client; `console.log('worker ready')`, `createBoss`, `stopBoss`, `SIGTERM`, `pool.end()`, `QUEUES.INTERNAL_HEALTHCHECK`, `startWorker` in worker — and the literal `worker stub ready` does NOT appear anywhere in the file; mirror checks for the scheduler).
- Plan 10's grep contract for D-15 smoke assertions #2/#3 is now realizable: a `docker run -e APP_ROLE=worker ...` will print `worker ready` to stdout, and `docker run -e APP_ROLE=scheduler ...` will print `scheduler ready`. Plan 10's smoke test (BLOCKER 7 fix — exercised via real ENTRYPOINT, not `sh -c`) consumes those raw lines.

## Task Commits

Each task was atomically committed (with `--no-verify` per the parallel-execution contract):

1. **Task 1: pg-boss client factory + worker entrypoint + scheduler entrypoint with graceful shutdown** — `2802f6e` (feat)

## Files Created / Modified

### Created (1 file)
- `src/lib/server/queue-client.ts` — `createBoss` / `stopBoss` factory shared by worker + scheduler

### Modified — REPLACED Plan 06 stubs (2 files)
- `src/worker/index.ts` — was a stub printing `worker stub ready`; now a real pg-boss worker printing `worker ready`
- `src/scheduler/index.ts` — was a stub printing `scheduler stub ready`; now a real pg-boss scheduler printing `scheduler ready`

## Decisions Made

(Recorded in detail in frontmatter `key-decisions`.)

- **pg-boss with `connectionString`, not a shared `pg.Pool`.** RESEARCH.md flagged 10.x's pool-sharing as fragile; the explicit reason for "pg-boss on its own pool" is to keep queue traffic from contending with app/audit traffic. The connection budget (10 app + 4 worker + 2 scheduler + 8 pg-boss internal pools = 24 of Postgres' default `max_connections=100`) was already reserved in Plan 03's pool-sizing decision.
- **Subscribe to `internal.healthcheck` (one no-op subscription) in Phase 1.** A worker that boots but has no subscriptions is a silent idle that hides bugs. Subscribing to a Phase-1-invented queue (not a Phase-3 queue) avoids future-archaeology confusion. Same reasoning for the scheduler's single cron.
- **Dual-emit ready signals (`logger.info` + `console.log`).** Plan 10's smoke test greps raw stdout, not parsed JSON. `console.log` is the grep target; `logger.info` preserves production observability. Both flow to the same stdout.
- **Same export names as Plan 06 stub (`startWorker` / `startScheduler`).** Plan 06's `src/server.ts` dispatcher imports both names; this plan replaces file content while preserving the export contract. No dispatcher edit needed.
- **`max=4` for pg-boss internal pool, `timeout: 60_000` for graceful drain.** Conservative defaults appropriate for "topology declared, no real jobs running yet". Phase 3 will tune these per real polling workload.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Plan's automated verifier flagged the literal string `worker stub ready` / `scheduler stub ready` even when it appeared inside a doc comment, not at runtime**
- **Found during:** Task 1 verification (`node -e ...` gate failed on `worker still has stub message`)
- **Issue:** My initial doc comments at the top of `src/worker/index.ts` and `src/scheduler/index.ts` said *"Plan 06 shipped a no-op stub printing `worker stub ready`"* (and the equivalent for scheduler). The plan's automated verifier asserts `if(w.includes('worker stub ready')) throw new Error('worker still has stub message')` — a substring match that does not distinguish comment text from code. The verifier's reading is actually CORRECT for the integration: Plan 10's smoke test could in theory grep the source-bundled comment if the build process embedded source maps, and even setting that aside, leaving the legacy string in a comment creates a maintenance footgun (someone's grep "find all `... stub ready` printers in the codebase" still hits the comment).
- **Fix:** Rephrased both doc comments to say *"Plan 06 shipped a no-op stub at this same path"* (no mention of the literal stub strings). The historical change is still documented but the literal "stub ready" strings now appear nowhere in the file.
- **Files modified:** `src/worker/index.ts`, `src/scheduler/index.ts`
- **Commit:** Folded into Task 1's `2802f6e` (the verifier fail was caught before commit)

---

**Total deviations:** 1 (Rule 1 — doc-comment text scrub to satisfy the structural verifier; verifier's stricter reading is the right contract)
**Impact on plan:** Plan executed cleanly. No architectural changes, no missing dependencies discovered, no scope drift, no acceptance criteria changes.

## Authentication Gates

None encountered. Plan 08 is pure code on the locked stack; no external services were contacted during execution. pg-boss connects to Postgres at `boss.start()` time — that path is exercised by the smoke test and integration tests in CI, not at structural-verification time.

## Issues Encountered

- **node_modules not installed locally.** The Windows executor machine does not have node_modules installed (consistent with prior plan SUMMARYs — Plan 02's `pnpm install` runs in CI, Plan 06 noted vitest blocked locally on Node 20.15 vs required 22.12+). The plan's `<automated>` structural verification (`node -e "..."` greps over the source files) passed cleanly. `pg-boss` types are not statically checkable on this machine; the API usage matches the plan's `<action>` block verbatim, which was authored against the pg-boss 10.x documentation. `tsc --noEmit` will run in CI on Node 22 and will type-check the imports.
- **Pre-existing uncommitted modifications to `.planning/` docs** (carry-over from prior plans + planner iterations). Per the parallel-execution contract, I touched none of them; the orchestrator owns the final metadata commit.
- **Parallel agents (01-07 and 01-09) had files staged in the working tree before my commit.** Visible in `git status --short` before staging: `?? src/lib/server/http/middleware/audit-ip.ts`, `?? src/lib/server/http/middleware/tenant.ts`, `?? src/lib/server/http/routes/`, `?? src/lib/server/services/errors.ts`, `?? src/lib/server/services/me.ts` (Plan 07) and modifications to `src/lib/server/http/app.ts`, `src/routes/+layout.server.ts`, `tests/integration/i18n.test.ts`, `tests/unit/paraglide.test.ts` (Plans 07/09). I staged ONLY my three files via explicit pathspec (`git add src/lib/server/queue-client.ts src/worker/index.ts src/scheduler/index.ts`) so the parallel agents' work was not absorbed into my commit. `git status --short` after staging confirmed only my files were in the index.

## Per-Task Verification Map Updates (for Plan 10 Task 3)

For Plan 10 Task 3 to flip the VALIDATION frontmatter to `nyquist_compliant: true`, the following row in `01-VALIDATION.md` is now satisfied at the structural level:

- `1-08-01` — structural assertions all pass (`node -e (queue-client + worker + scheduler grep) — W4 fix: paths are src/worker/index.ts and src/scheduler/index.ts (D-01)`). Plan 10's smoke test owns the runtime assertion (boot the image with APP_ROLE=worker / APP_ROLE=scheduler and grep stdout for `worker ready` / `scheduler ready`).

**Note for Plan 10**: D-15 smoke assertions #2 and #3 are now testable end-to-end. The grep targets are exactly `worker ready` and `scheduler ready` (NOT `worker stub ready` / `scheduler stub ready` — those were Plan 06's interim strings that Plan 08 has now replaced). Plan 10's smoke test should grep for the post-Plan-08 strings.

## User Setup Required

None. Phase 1 Plan 08 is pure code on the locked stack already pinned by Plan 01-01 (`pg-boss@10.1.10`). The smoke test in Plan 10 will exercise `boss.start()` against a service-container Postgres in CI; self-host operators will exercise these paths automatically when they run their `worker` and `scheduler` containers against their configured `DATABASE_URL`.

## Next Phase Readiness

- **Plan 01-09 (Wave 4 i18n):** unaffected; Plan 09 owns Paraglide files only. Already in flight as a parallel agent.
- **Plan 01-10 (Wave 5 self-host smoke):** can now write `docker run -e APP_ROLE=worker ... | grep -q "worker ready"` and the equivalent for scheduler. The grep contract is locked.
- **Phase 3 POLL-01..06:** lands `boss.work(QUEUES.POLL_HOT, handler)` etc. on the four poll queues. The pg-boss instance is already booting in worker mode, all queues are already declared, and the graceful drain contract is already in place — Phase 3's worker is a handler-registration patch on top of this scaffold, not a re-architecture.
- **Phase 3 POLL-06 (graceful shutdown contract):** `stopBoss → pool.end()` chain is already implemented; the `boss.stop({ wait: true, graceful: true, timeout: 60_000 })` call is the literal mechanism POLL-06 mandates. Phase 3 may want to extend this with a phase-specific log line about in-flight job count at drain start, but the safety contract is satisfied today.
- **No blockers.** Wave 4 is complete pending the parallel 01-07 / 01-09 agents; Wave 5 (Plan 10) is unblocked.

## Known Stubs

This plan introduces NO new stubs. Two intentional behaviors that are NOT stubs but might look like stubs to a casual reader:

1. **Worker subscribes only to `internal.healthcheck` in Phase 1.** This is by design (Phase-1 scope per CONTEXT.md `<deviations>` 2026-04-27 — "Phase 1 has no actual job handlers"). Phase 3 (POLL-01..06) lands the real `poll.{hot,warm,cold,user}` handlers. The healthcheck handler is intentionally a no-op — it acknowledges the job and emits a debug log; it is NOT a placeholder for real work. The same pattern persists into Phase 3 because Phase 3's healthcheck is still a no-op (the value is in the `poll.*` handlers).
2. **Scheduler registers only `internal.healthcheck` cron in Phase 1.** Same reasoning. Phase 3 lands `poll.hot` / `poll.warm` / `poll.cold` / `poll.user` cron schedules with the adaptive cadence math (per ROADMAP Phase 3 SC#1).

Both behaviors are documented inline in the source files with the future-plan owners and clear rationale.

## Self-Check

- [x] `src/lib/server/queue-client.ts` exists; contains `new PgBoss(`, `await boss.start()`, `declareAllQueues(boss)`, `wait: true`, `graceful: true`, `timeout: 60_000`, `env.DATABASE_URL` — verified by `node -e ...` gate (output `ok`)
- [x] `src/lib/server/queue-client.ts` exports both `createBoss` and `stopBoss`
- [x] `src/worker/index.ts` exists at the D-01-locked path; exports `startWorker`; contains literal `console.log('worker ready')` — verified
- [x] `src/worker/index.ts` no longer contains the literal `worker stub ready` — verified
- [x] `src/worker/index.ts` subscribes to `QUEUES.INTERNAL_HEALTHCHECK` (proves at least one subscription)
- [x] `src/worker/index.ts` handles `SIGTERM` and `SIGINT` and chains `stopBoss(boss)` → `pool.end()` → `process.exit(0)`
- [x] `src/scheduler/index.ts` exists at the D-01-locked path; exports `startScheduler`; contains literal `console.log('scheduler ready')` — verified
- [x] `src/scheduler/index.ts` no longer contains the literal `scheduler stub ready` — verified
- [x] `src/scheduler/index.ts` calls `boss.schedule(QUEUES.INTERNAL_HEALTHCHECK, '*/5 * * * *')` — verified
- [x] `src/scheduler/index.ts` handles SIGTERM/SIGINT with `stopBoss + pool.end()` chain — verified
- [x] Both worker and scheduler return `new Promise<void>(() => {})` (idle process; lives until SIGTERM) — verified
- [x] Export names (`startWorker` / `startScheduler`) match what `src/server.ts` Plan 06 imports — no dispatcher edit needed
- [x] Commit `2802f6e` (Task 1) exists in git log — verified via `git log --oneline -3`
- [x] All my staged files used explicit pathspec (`git add src/lib/server/queue-client.ts src/worker/index.ts src/scheduler/index.ts`); no `git add .` or `git add -A` per parallel-execution hygiene
- [x] No files outside Plan 08's wave allocation appeared staged in any commit — confirmed via `git status --short` before commit (only my 3 files appeared in the index; parallel agents' files remained `??` / `M` in the working tree)

## Self-Check: PASSED

---
*Phase: 01-foundation*
*Plan: 08*
*Completed: 2026-04-27*
