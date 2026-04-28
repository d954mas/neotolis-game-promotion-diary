---
created: 2026-04-28T06:55:00.000Z
title: ARCH: channel-to-inbox auto-import flow (own channel → auto-pull videos → user attaches to games)
area: planning
files:
  - src/lib/server/db/schema/youtube-channels.ts (add auto_import flag)
  - src/lib/server/db/schema/events.ts (game_id becomes nullable after Phase 2.1 unification)
  - src/lib/server/services/youtube-channels.ts (add auto-import setup)
  - src/lib/server/services/events.ts (after unification — handle null game_id)
  - .planning/REQUIREMENTS.md (KEYS-01 YouTube key — already deferred to Phase 3, this needs it)
  - related todos:
    - 2026-04-28-rethink-items-vs-events-architecture (P0 unification — prerequisite)
    - 2026-04-28-youtube-channels-ux-gaps (channel delete + explainer)
---

## Problem

During Phase 2 manual UAT (2026-04-28), user pushed back on the current channel model:

> **"Это странно. Как будто свой канал я всегда хочу трекать. Видеть список видео и помечать те что связаны с конкретной игрой, иначе смысла как будто бы и нет?"**

The current model is conceptually broken: registering a channel only enables passive `is_own` auto-tagging on manually-pasted videos. The user has to know every video URL by heart and paste them one by one. Adding a channel does NOT actually track the channel — it's just a name+is_own registration.

**User's mental model** (and the natural UX): adding a channel should mean "track this channel — show me all its videos, let me categorize them per game."

## Proposed flow

1. User adds their own YouTube channel via /accounts/youtube
2. Phase 3 polling worker calls YouTube Data API `playlistItems.list` against the channel's uploads playlist (channel.contentDetails.relatedPlaylists.uploads)
3. Each video becomes a row in the unified `events` table (post-Phase-2.1):
   - `kind = 'youtube_video'`
   - `author_is_me = true` (from channel registry)
   - `game_id = NULL` ← **new: nullable**
   - `url`, `title`, `occurred_at` (= video upload date) populated from API
4. /accounts/youtube becomes the **inbox view** for `WHERE author_is_me = true AND game_id IS NULL`
5. User clicks an inbox video → "Attach to game" picker → sets `game_id`
6. Attached videos show up under `/games/[id]` Tracked items panel as today
7. Videos that genuinely don't relate to any game (devlogs, off-topic streams) get a "Not game-related" toggle → moves to a separate filter (not deleted, just out of inbox)

## Schema changes (on top of Phase 2.1 unification)

```sql
-- After Phase 2.1 unification:
ALTER TABLE events ALTER COLUMN game_id DROP NOT NULL;
-- "Inbox" = events.game_id IS NULL AND events.author_is_me = true
-- "Not game-related" = events.game_id IS NULL AND events.author_is_me = true AND events.metadata->>'inbox_dismissed' = 'true'

ALTER TABLE youtube_channels ADD COLUMN auto_import boolean NOT NULL DEFAULT true;
-- Default true for own channels; false for blogger channels (auto-import for blogger channels would be expensive and noisy)

ALTER TABLE youtube_channels ADD COLUMN uploads_playlist_id text;
-- Cached after first poll; needed to avoid re-fetching channel metadata every cron tick
```

## Phase split

**Phase 2.1 (alongside unification):**
- Make `events.game_id` nullable
- Add `auto_import` and `uploads_playlist_id` columns to youtube_channels
- Build the inbox UI shell (no auto-import data yet — empty state explains "Phase 3 will pull videos here")
- "Attach to game" picker UI (works on any null-game event row, will be useful immediately for manually-pasted but not-yet-attached videos)

**Phase 3 (when YouTube Data API key + polling worker land):**
- Implement actual auto-import polling
- Cron tick per own-channel: fetch latest N videos via `playlistItems.list`, dedupe by video id, insert events with game_id=NULL
- Quota math: 1 unit per `playlistItems.list` page (50 videos), so 24 channels × 1 page/day = 24 units/day vs 10k daily quota → very cheap
- Backfill option: "Import last N=100 videos from channel" one-shot button

**Phase 4 (when LayerChart correlation lands):**
- Inbox surfaces unattached videos in dashboard ("3 new videos from your channel — attach them?")
- Once attached, videos contribute to the wishlist-correlation analytics

## Why this matters

This isn't a polish todo — it's the **core flow** for the user's primary use case. Without auto-import, every "tracked" video is manual data entry. With auto-import + inbox, the app actually does work for the user.

User's exact phrasing: **"иначе смысла как будто бы и нет"** — without this, channel registration has no point.

## Severity

**P0 ARCH** — bundle the schema change with Phase 2.1 unification (now is the cheapest moment, zero production data). The polling and UI build out in Phase 3.

Owner: Phase 2.1 (schema + UI shell), Phase 3 (polling + auto-import), Phase 4 (dashboard surfacing).
