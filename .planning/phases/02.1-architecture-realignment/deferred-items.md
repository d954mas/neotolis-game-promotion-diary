# Phase 2.1 Deferred Items

Out-of-scope discoveries logged during plan execution. These are not fixed by
the current plan; the listed plan / phase owns the fix.

## From Plan 02.1-01

### `tests/unit/paraglide.test.ts` keyset snapshot drift

- **Discovered during:** Plan 02.1-01 verification (`pnpm test:unit`).
- **Symptom:** The hard-coded alphabetical key list in `paraglide.test.ts`
  (last refreshed at the end of Phase 2 when 80 keys were live) does not match
  the live `messages/en.json` snapshot anymore — Phase 2.1 is mid-flight and
  the messages file has accreted ~50 new keys for `/feed`, `/sources`,
  `/sources/new`, `polling_badge_*`, `settings_sessions_*`,
  `source_kind_*`, etc.
- **Why deferred:** Plan 02.1-01 is the migration / schema / ESLint plan.
  Touching the keyset snapshot here couples a structural plan to copy work
  that belongs to the wave-3 / wave-4 UI plans, which add the keys with the
  components that consume them. Fixing it now would either require dropping
  the keys (regression for downstream waves) or hard-coding tomorrow's
  expected list (trip-wire defeated until then).
- **Owner:** the Phase 2.1 wave-3 / wave-4 plans that ship `/feed`, `/sources`,
  `/sources/new`, `<UserChip>`, `<SessionsList>`, etc. land their keys; the
  wave that finishes the copy contract refreshes `paraglide.test.ts`
  alphabetical snapshot. (Phase 2 precedent: Plan 02-09 was the snapshot
  refresh point.)
- **Out of scope for Plan 02.1-01:** confirmed.

## Resolved by Plan 02.1-06 (Wave 2 HTTP routes)

### `src/lib/server/services/games.ts` — soft-delete cascade purged of retired schemas

- **Fixed in:** Plan 02.1-06 commit `98dfc09` (Rule 3 blocking fix).
- **Was:** services/games.ts imported `gameYoutubeChannels` +
  `trackedYoutubeVideos` schemas (retired in Plan 02.1-01) and cascaded
  soft-delete + restore against them. The dead imports prevented
  `createApp()` from loading the gamesRoutes sub-router, which in turn
  blocked the anonymous-401 sweep + cross-tenant matrix from running.
- **Now:** the soft-delete cascade spans only `game_steam_listings` +
  `events` (the surviving game-bound child tables). Per the unified-events
  shape, the cross-tenant test runs and the `gamesRoutes` mount succeeds.
- **Owner moved to:** Plan 02.1-06 (this plan); not Wave 3.

## From Plan 02.1-12

### `tests/unit/paraglide.test.ts` keyset snapshot — `event_kind_label_post` added

- **Discovered during:** Plan 02.1-12 Task 2 (Gap 12 closure).
- **Symptom:** EXPECTED_KEYS hard-coded alphabetical list does not include `event_kind_label_post`; the snapshot test will fail until refreshed.
- **Why deferred:** consistent with the existing 02.1-01 deferral — multiple gap-closure plans add keys; the LAST plan in the chain (02.1-16 FeedCard redesign) refreshes the snapshot in one commit covering all additions.
- **Owner:** Plan 02.1-16.
- **Out of scope for Plan 02.1-12:** confirmed.

## From Plan 02.1-03

### Pre-existing tsc errors in `src/lib/server/services/*` and `tests/integration/*`

- **Discovered during:** Plan 02.1-03 Task 2 verification (`pnpm tsc --noEmit`).
- **Symptom:** After Plan 02.1-01 deleted `youtube-channels.ts`,
  `tracked-youtube-videos.ts`, and `game-youtube-channels.ts` schema files
  (and dropped the `item.*` audit-action enum values), the following
  pre-existing files no longer compile:
  - `src/lib/server/services/youtube-channels.ts`
  - `src/lib/server/services/items-youtube.ts`
  - `src/lib/server/services/events.ts` (uses old `tracked_youtube_videos`)
  - `src/lib/server/services/games.ts` (uses old `game_youtube_channels`)
  - `src/lib/server/dto.ts` (re-exports the removed schema types + has a
    Phase-2 `toEventDto` shape that doesn't yet account for nullable game_id /
    new kind values)
  - `tests/integration/events.test.ts`, `games.test.ts`, `ingest.test.ts`
    (still import the deleted schema files)
- **Why deferred:** these are Wave 1+ rewrites/deletions (per Phase 2.1 plan
  README — Wave 1 deletes the old YouTube-only services and rewrites
  `services/events.ts` + `services/games.ts` against the unified events
  table; Wave 2 deletes the old routes; tests get extended in lock-step).
  Plan 02.1-03 ships only the keyset + adapter contract — it does not own
  service code.
- **Owner:** Wave 1 plans (`02.1-04` onwards per planner discretion in
  CONTEXT D-02) — service rewrites + DTO updates land alongside the
  service files they belong to.
- **Out of scope for Plan 02.1-03:** confirmed (Rule 4 boundary —
  pre-existing failures in unrelated files are out of scope).

## From Plan 02.1-13

### `tests/unit/paraglide.test.ts` keyset snapshot — 3 new keys for /events/new UX

- **Discovered during:** Plan 02.1-13 Task 1 (Gap 7 + 8 closure).
- **Symptom:** EXPECTED_KEYS hard-coded list does not include `events_new_date_today`, `events_new_date_yesterday`, or `events_new_date_explainer`; the snapshot test will fail until refreshed.
- **Why deferred:** consistent with Plans 02.1-01 / 02.1-12; the LAST gap-closure plan (02.1-16) refreshes the alphabetical snapshot covering all additions in one commit.
- **Owner:** Plan 02.1-16.
- **Out of scope for Plan 02.1-13:** confirmed.
