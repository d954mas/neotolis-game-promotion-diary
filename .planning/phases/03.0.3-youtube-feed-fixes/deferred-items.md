# Phase 03.0.3 deferred items

Out-of-scope discoveries surfaced while executing plan 03.0.3-01. Logged per
`AGENTS.md` Rule 1-3 scope-boundary rules — not auto-fixed; will be addressed
in a follow-up issue or phase.

## tests/integration/feed.test.ts — static-email collision on rerun

**Found during:** End-of-plan verification (Plan 03.0.3-01 Task 6 follow-up).

**Symptom:** `npx vitest run tests/integration/feed.test.ts` fails with
`duplicate key value violates unique constraint "user_email_unique"` for
static emails like `feed11a@test.local` / `p26-feed-a@test.local`.

**Root cause:** The test seeds users with static deterministic emails;
between runs, the prior rows linger in the test DB (`tests/setup.ts` runs
migrations once but does NOT truncate the user table between runs).
Pre-existing — confirmed by `git diff master..HEAD -- tests/integration/feed.test.ts`
returning empty.

**Scope decision:** NOT auto-fixed. The bug is unrelated to Plan 03.0.3-01's
changes (refresh-content quota burn). Fixing it would require either:
1. Rewriting the test's email-generation to use `uniq()` per call (similar to
   the pattern in `tests/integration/refresh-content-quota.test.ts`).
2. Adding a per-test cleanup hook that DELETEs users by email pattern.

Either approach is a separate atomic PR — bundling it here would violate
AGENTS.md "atomic PRs" practice.

**Recommended follow-up:** File a standalone GitHub issue
"feed.test.ts: static emails cause cross-run collisions" with the
`tests/integration` label.

## tests/integration/ingest-paste-then-poll.test.ts — handlePollActive throws

**Found during:** End-of-plan verification (Plan 03.0.3-01 Task 6 follow-up).

**Symptom:** Test "manual-paste event (source_id=NULL) flows through
handlePollActive → snapshot row + youtube_videos.last_polled_at populated"
fails with `TypeError: Cannot read properties of undefined (reading
'status')` at `src/lib/sources/youtube/server/handlers/poll-active.ts:206`.

**Root cause:** Pre-existing — confirmed by checking out `master` and
running the same test (also fails). `git diff master..HEAD --
src/lib/sources/youtube/server/handlers/poll-active.ts tests/integration/ingest-paste-then-poll.test.ts`
returns empty.

**Scope decision:** NOT auto-fixed. Unrelated to Plan 03.0.3-01's
changes. Likely surfaced by a dependency bump in Phase 03.0.2 (Vitest 4
upgrade or similar) or by `pollContent` returning a different shape in
some test fixture. Out of scope per AGENTS.md atomic-PR rule.

**Recommended follow-up:** File a standalone GitHub issue
"ingest-paste-then-poll: handlePollActive TypeError on writeSnapshot"
with the `tests/integration` label.

## .dev-oauth-mock.mjs — process.env reads outside config/env.ts (lint failure)

**Found during:** Plan 03.0.3-02 end-of-plan `pnpm lint`.

**Symptom:** `eslint .` fails on `.dev-oauth-mock.mjs` lines 9/10/11 with
`'process.env' is restricted from being used. Read env via
src/lib/server/config/env.ts (PITFALL P2 mitigation)`.

**Root cause:** Pre-existing — `.dev-oauth-mock.mjs` is an untracked dev
helper file (visible in `git status` at session start; not committed to
master). The file uses `process.env` directly because it runs as a
standalone Node script outside the SvelteKit/Hono runtime.

**Scope decision:** NOT auto-fixed. The file is untracked and outside the
plan's scope (Plan 03.0.3-02 touches feed-enrichment adapter wiring; the
dev helper is unrelated). Options to resolve later:
1. Add `.dev-*.mjs` / `.dev-*.ts` to `.eslintignore` (developer convention).
2. Delete the file if it's an orphan from earlier dev work.
3. Migrate the file to read env via `src/lib/server/config/env.ts` if it's
   meant to ship.

**Recommended follow-up:** Discuss with the operator (file is in their
local working copy, not on master). Likely belongs in `.gitignore` /
`.eslintignore` alongside the other `.dev-*.{ts,mjs}` developer scripts.
