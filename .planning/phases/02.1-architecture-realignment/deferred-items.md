
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

## Plan 02.1-28 deferred items

- **Lint error in `dev-mock-oauth.mjs:26`** — pre-existing P2 violation
  (`process.env` read outside `src/lib/server/config/env.ts`). Found during
  Plan 02.1-28 lint pass; out of scope (not introduced by this plan; the
  file is a dev-time OAuth mock helper, not part of the production code
  path). File for a one-line cleanup PR that routes through the env module
  or moves the file under `tests/` where the rule does not fire.

## Plan 02.1-33 deferred items

- **`tests/integration/audit-render.test.ts` Plan 02.1-25 SSR scan asserts
  `var(--color-accent)` on `.row.mine` border-left and `.ownership-badge.mine`
  background.** Plan 02.1-30 unified the Mine token via `var(--color-mine)`
  (which defaults to `--color-accent` but is structurally distinct). The
  Plan 02.1-25 test regex was not updated by Plan 02.1-30 and now fails
  whenever SourceRow.svelte renders the `--color-mine` token. Out of scope
  for Plan 02.1-33 — this is Plan 02.1-30's test-update gap, not a
  Plan 02.1-33-introduced regression. Fix path: change the two
  `var\(--color-accent\)` substrings in the regex to `var\(--color-mine\)`
  in tests/integration/audit-render.test.ts (Plan 02.1-25 describe block,
  "SourceRow.svelte source carries the Mine treatment CSS rule + kind label"
  case).
- **`tests/integration/audit-render.test.ts` Plan 02.1-25 two-card layout
  scan fails on /games/[gameId]/+page.svelte.** Plan 02.1-30 (StoresSection)
  restructured the page; the two-card structural assertions need updating
  to match the post-Plan-02.1-30 markup. Out of scope for Plan 02.1-33 —
  this is Plan 02.1-30's test-update gap.

## Plan 02.1-36 — out-of-scope lint error in dev-mock-oauth.mjs

Pre-existing lint error observed during Plan 02.1-36 verification (2026-04-30):

- `dev-mock-oauth.mjs:26` — `'process.env' is restricted from being used`
  (`no-restricted-properties`). The file is a development-only mock OAuth
  server entrypoint that lives outside `src/`. The env-discipline rule fires
  here because `dev-mock-oauth.mjs` is at the repo root and the lint config
  scans it. Two reasonable fix paths: (a) add `dev-mock-oauth.mjs` to the
  ESLint `no-restricted-properties` override allowlist (it's not production
  code), or (b) route the env reads through a tiny dev-only wrapper. Out of
  scope for Plan 02.1-36 — this plan only touches `src/lib/util/`,
  `src/lib/server/logger.ts`, and `tests/unit/`. The error was present on
  master before this branch (commit 9a0792e); not a regression.

## Plan 02.1-39 round-6 polish #11 follow-up — pre-existing audit-render failures (2026-04-30)

Verified at task time during the RecoveryDialog parity-sweep work (extending the modal to /games and /sources). Three audit-render integration tests were already failing on `c98eadf` (the parent commit) — confirmed by stashing the in-progress diff and re-running the same test selection against unchanged HEAD:

- `SteamListingRow falls back to 'App {appId}' when listing.name is null`
- `SteamListingRow Open-on-Steam href targets store.steampowered.com/app/{appId}/`
- `SourceRow.svelte source carries the Mine treatment CSS rule + kind label`

Out of scope for the round-6 polish #11 follow-up (the diff only touches `/games`, `/sources`, the `audit-render.test.ts` parity describe block, UAT-NOTES.md, and VALIDATION.md). The five new RecoveryDialog parity tests added by this commit all pass; the unit suite (`pnpm test:unit`) is green.
