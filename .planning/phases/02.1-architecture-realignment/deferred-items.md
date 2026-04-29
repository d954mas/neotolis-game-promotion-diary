
## Plan 02.1-21 — out-of-scope errors found during typecheck

Pre-existing typecheck errors in tests/integration/game-listings.test.ts and games.test.ts referencing modules removed during Plan 02.1-01 baseline collapse:
- src/lib/server/services/youtube-channels.js
- src/lib/server/db/schema/game-youtube-channels.js
- src/lib/server/db/schema/youtube-channels.js
- src/lib/server/db/schema/tracked-youtube-videos.js

Out of scope for Plan 02.1-21 (it does not touch these files). Pre-Phase-02.1-01 cleanup; either update or delete these test files.

## Plan 02.1-24 — out-of-scope unit-test failures observed during execution

Two unit-test failures pre-existing on master (verified 2026-04-29 during Plan 02.1-24 Task 1 verification run):

- `tests/unit/format-feed-date.test.ts` — locale-dependent regex mismatch on prior-year date assertions ("Dec 24, 2025" vs "Dec 25, 2025"); driven by host timezone, not by Plan 02.1-24 changes.
- `tests/unit/logger.test.ts` — env-discipline grep flags `src/routes/settings/+page.server.ts:15` (a comment that mentions `process.env`). Pre-existing, not introduced by this plan.

Both are out of scope for Plan 02.1-24 (which does not touch those files). Filed for separate follow-up.

## Plan 02.1-29 — out-of-scope test/lint failures observed during execution

Verified at task time (2026-04-29) during Plan 02.1-29 verification:

- **Pre-existing typecheck errors in events test files (Plan 02.1-27 → 02.1-28 dependency):**
  Plan 02.1-27 dropped `events.game_id` column. Test files (`tests/integration/events.test.ts`,
  `events-attach.test.ts`, `feed.test.ts`, `inbox.test.ts`, `ingest.test.ts`,
  `tenant-scope.test.ts`) still reference `events.gameId` — these are migrated by Plan 02.1-28
  in lock-step. Out of scope for Plan 02.1-29; tracked by Plan 02.1-28.
- **Pre-existing typecheck errors in `tests/integration/games.test.ts`:** references modules removed
  during Plan 02.1-01 baseline collapse (`game-youtube-channels`, `youtube-channels`,
  `tracked-youtube-videos`). Same item already tracked under Plan 02.1-21 above.
- **`.claude/worktrees/agent-*/` ESLint noise:** parallel-agent worktrees from the GSD orchestrator
  leak into ESLint scans. The repo's `.gitignore` does NOT list `.claude/`, so ESLint sees those
  files. Not introduced by Plan 02.1-29; filed for separate follow-up (suggested fix: add `.claude/`
  to `.gitignore`).
- **DB-isolation flake in non-game-listings integration tests:** "duplicate key on user_email_unique"
  / "password authentication failed for user 'test'" surfaces in unrelated tests. Pre-existing
  per the comment in `tests/integration/game-listings.test.ts` lines 6-11 ("tests/setup.ts truncates
  `neotolis_test`, but runMigrations() reads env.DATABASE_URL which points at `neotolis`"). The
  Plan 02.1-29 tests use `randomBytes(4)` per-invocation suffixes to dodge the conflation; broader
  fix is the test-harness wiring (deferred — already noted in game-listings.test.ts).
