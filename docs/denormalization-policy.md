# Denormalization policy

This document is the project's standing reference for **how to think about
denormalization** in the schema. The canonical rule lives in
[`AGENTS.md` → Principles → "No denormalization of separately-renameable
values"](../AGENTS.md). This doc unpacks the rule with worked examples,
records the historical violations and their fixes, and lists what's
deliberately exempt so future contributors don't accidentally re-introduce
the anti-pattern (or wrongly flag intrinsic-identifier copies as
violations).

## The rule (verbatim from AGENTS.md)

> **No denormalization of separately-renameable values.** Never copy a
> value owned by another table's row onto your row "for convenience".
> Display names (`channelTitle`, `displayName`, `gameTitle`, etc),
> descriptions, statuses, anything the user or upstream API can edit
> later → read from the owning row via FK, never cache on the consumer
> row. One UPDATE on the source of truth must reflect across every
> consumer; copies create stale-data bugs. Intrinsic identifiers that
> are part of the URL/key itself (`subreddit` slug — Reddit forbids
> rename, value is part of the canonical URL) are the only safe
> denormalization. If read-path latency hurts, use a JOIN or a derived
> view — do not duplicate.

## Why this matters

The bugs this rule prevents are silent. A column name like
`channelTitle` on `events` looks fine in code review. The schema accepts
the write. The page renders. The defect surfaces months later when a
YouTube channel renames itself and the user sees "old name" on rows
logged before the rename, "new name" on rows logged after — same
channel, both forms, no obvious cause. Fixing it after the fact requires
a backfill script + a permanent removal of the column. Fixing it up-
front costs one JOIN and zero ambiguity about which row is the source
of truth.

## How to apply the rule

1. **Renameable by user or upstream → FK + JOIN.** Display names,
   descriptions, statuses owned by another row. Read at query time.
2. **Intrinsic identifier (part of URL/key) → safe to copy.** Subreddit
   slug, channel ID, user ID — platform forbids rename and the value IS
   the identifier.
3. **Own-row state → safe to write.** A column the row itself owns and
   updates (`fetched_at`, `poll_failure_count`, `last_user_refresh_at`).
4. **Audit metadata → safe to snapshot.** Audit log is insert-only
   forensic record. Snapshotting values at audit-write time is the
   intended behavior.
5. **Steam listing fields → safe to copy from upstream.** A
   `game_steam_listings` row IS the local cache of one Steam app's
   metadata; the row is the source of truth from the local schema's
   perspective.

## Historical violations (resolved)

### V-1: `youtube_videos.channel_title` (fixed in PR #39)

- **Owner of truth:** `youtube_channels.channel_title`
- **Symptom:** When a YouTube channel renamed itself, the polling worker
  updated `youtube_channels` on the next cron tick but never re-walked
  `youtube_videos` to refresh the snapshotted name. Feed cards rendered
  the stale name forever (until manually re-fetched).
- **Fix:** Schema migration `0048_smiling_gravity.sql` drops the column.
  `feed-enrichment.ts` LEFT JOINs `youtube_videos.channel_id →
  youtube_channels.channel_title` at read time.
  `metadata.ts`, `channel-context-backfill.ts`, and `video-single.ts`
  no longer write `channel_title` on the videos row.
  `EventDto.channelTitle` wire shape unchanged — only the SOURCE moved
  from videos row to channels JOIN.

### V-2: `games.release_date` + `games.release_tba` (fixed in PR #39)

- **Owner of truth:** `game_steam_listings.release_date`
- **Symptom:** When Steam pushed a date change to a listing, the
  listing row updated but `games.release_date` never re-synced. The
  games row carried whatever value was set when the row was first
  populated (or NULL for v0.1-era games — the GameEditDialog never
  exposed the field).
- **Fix:** Schema migration `0047_bright_shocker.sql` drops both
  columns. `services/games.ts deriveReleaseInfoForGames()` computes the
  per-game earliest non-null listing release_date + any-null-means-TBA
  via one tenant-scoped query. Page loaders pass the derived map into
  `toGameDto()`. `GameDto.releaseDate` / `.releaseTba` wire shape
  unchanged.

## OK-INTRINSIC exemptions (do NOT flag as violations)

These categories are deliberately denormalized OR deliberately copied
from upstream and are NOT violations of the no-denorm rule. Future
contributors should not "fix" them.

- **URL slugs / permanent IDs.** `reddit_posts.subreddit`,
  `reddit_posts.author`, `events.metadata.subreddit`,
  `events.metadata.channelId` (YouTube), `events.metadata.handle`
  (Twitter), `events.metadata.channel` (Telegram). Each is intrinsic
  to the post URL itself and the platform forbids rename.
- **Own-row state.** `events.title`, `events.notes`, `events.url`,
  `events.metadata.last_user_refresh_at`,
  `events.metadata.inbox.dismissed`,
  `events.metadata.triage.offTopic`, `youtube_videos.fetched_at`,
  `youtube_videos.last_polled_at`, `youtube_videos.poll_failure_count`.
- **Steam listing fields.** `game_steam_listings.name`,
  `.release_date`, `.cover_url`, `.coming_soon`, `.steam_genres`,
  `.steam_categories`. The listing row IS the local copy of one Steam
  app's metadata; `raw_appdetails` jsonb on the same row carries the
  full Steam payload. There is no more-canonical local table to FK
  from.
- **Audit metadata.** Every `audit_log.metadata` jsonb write. INSERT-
  only forensic record — snapshotting is the intended behavior.
- **Tenant-scope copies.** `event_games.user_id` is deliberately
  denormalized so `eslint-plugin-tenant-scope/no-unfiltered-tenant-
  query` can require the filter without walking FK chains.
  Service-layer `attachEventToGames` asserts user_id consistency on
  every write.
- **Display name on its own row.** `data_sources.display_name` (user's
  own label), `youtube_channels.channel_title` (the channel's own row).
  Owned by THIS row, not copied from elsewhere — these ARE the sources
  of truth other rows JOIN to.
- **Resolved platform identifiers.** `data_sources.channel_id` (FK to
  `youtube_channels`), `data_sources.metadata.uploads_playlist_id`
  (deterministic from channel_id), `youtube_channels.handle_aliases[]`
  (append-only list of every URL that resolved to this channel id),
  `data_source_channel_state.channel_key` (stable platform identifier).

## How to handle a new violation

1. Open a follow-up PR. Don't add a feature flag, don't backfill the
   stale value — drop the column / JSONB field cleanly.
2. Write a `drizzle-kit generate` forward migration that drops the
   column. Apply it to the dev DB at the end of the PR so the live
   schema doesn't 500 on next page load.
3. Add a JOIN at the loader (or service helper) that derives the value
   at read time from the source-of-truth row.
4. Drop every UPSERT site that writes the column. Search the codebase
   for the field name as both `camelCase` (Drizzle) and `snake_case`
   (SQL/migration); both must be clean.
5. Keep the wire DTO field if existing UI consumers read it under that
   name. Move only the SOURCE of the value, not the API contract.
6. Update tests: fixtures writing to the dropped column switch to
   writing the source-of-truth row instead. Assertions on persisted
   values become assertions on the JOIN-derived value.
7. Add a one-line entry to the "Historical violations" section above
   so the next contributor sees the precedent.

## Enforcement

- **AGENTS.md `Don'ts`** lists "Caching a display name / status /
  description from another table's row" as a forbidden pattern.
- **ESLint `local/no-denormalized-write`** (in `eslint-rules/`) flags
  the canonical anti-pattern: writes to `metadata.<someName>Title =`,
  `metadata.<someName>Name =`, etc. False positives are possible — the
  rule is `warn` so the team triages on PR. Real positives become
  follow-up PRs that drop the field, following the steps above.
- **Code review.** A reviewer who sees a JSONB write of a display name
  pulled from another table should flag it and link this doc.
