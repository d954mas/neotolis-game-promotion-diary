---
created: 2026-04-28T05:42:00.000Z
title: Phase 4 expectation — internal video detail page with view-count chart
area: planning
files:
  - .planning/ROADMAP.md (Phase 4 — LayerChart wishlist metrics)
  - src/routes/games/[gameId]/+page.svelte (current items list links to YouTube external)
  - src/routes/items/[itemId]/+page.svelte (does not exist — Phase 4 should add)
---

## Problem

During Phase 2 manual UAT (2026-04-28), the user clicked an added YouTube video in the Tracked items list and was redirected externally to YouTube. They asked: **"У меня же будут карточки на каждое ютуб видео? Чтобы я видел просмотры, график просмотров и тд"**

This is a forward-looking expectation, not a Phase 2 bug. Current Phase 2 scope only stores `url + title + is_own + added_at` — there's no view-count data to show, so the external link makes sense for Phase 2. But the user's mental model assumes a clickable card showing engagement metrics.

## Expected Phase roadmap fit

- **Phase 3 (Ingest workers)** lands `videos.list` polling via YouTube Data API v3 — gets `view_count`, `like_count`, `comment_count` snapshots every N hours into a new `tracked_youtube_video_stats` time-series table (or similar — Phase 3 will design)
- **Phase 4 (LayerChart wishlist dashboards)** lands `/items/[itemId]/+page.svelte` — internal card with:
  - Video title + thumbnail (already in oEmbed payload from Phase 2 — store `thumbnail_url` if not already)
  - Latest stats (views/likes/comments)
  - Time-series chart "views per day" (LayerChart)
  - Cross-reference: wishlist-add events from Steam (when KEYS-01 lands — but Phase 4 doesn't need Steam wishlist API, that's separate)
- **Phase 4 also**: change `/games/[gameId]` Tracked items list to link to `/items/[itemId]` instead of external YouTube URL

## What this means for current work

**Nothing breaks in Phase 2** — current behavior (external redirect) is acceptable interim. Just:

1. Verify Phase 2 stores `thumbnail_url` from oEmbed payload (check `tracked_youtube_videos` schema). If not already, add a small Phase 2.1 polish to capture it so Phase 4 doesn't have to backfill.
2. Confirm Phase 4 ROADMAP entry mentions video detail pages (not just dashboard charts).

## Tests / Acceptance for Phase 4

When Phase 4 plans this:
- Each tracked YouTube video has its own `/items/[itemId]` route with at least: title, thumbnail, latest view count, time-series chart of views over time
- Click on row in /games/[gameId] tracked-items list goes to internal detail page (not external YouTube)
- "Open on YouTube" remains as a secondary action on the detail page

Owner: Phase 4 planner — add to Phase 4 RESEARCH.md / requirements when that phase opens.
