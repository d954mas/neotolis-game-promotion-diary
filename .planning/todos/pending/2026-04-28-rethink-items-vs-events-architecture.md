---
created: 2026-04-28T05:35:00.000Z
title: ARCH: rethink tracked_items vs events split (one unified promotion log?)
area: planning
files:
  - src/lib/server/db/schema/tracked-youtube-videos.ts
  - src/lib/server/db/schema/events.ts
  - .planning/REQUIREMENTS.md (KEYS-01..02 deferred to Phase 3)
  - .planning/PROJECT.md (Constraints — indie budget)
---

## Problem

During Phase 2 manual UAT (2026-04-28), the user asked:
**"Так но я ведь могу захотеть трекать твиттер посты, или ютуб видео?"**

This exposes a real architectural ambiguity in the data model. Current split:

- `tracked_youtube_videos` — YouTube videos with auto-pulled metadata (Phase 3 will add view-count polling via Data API v3 — fits in free quota)
- `events` — all other promotion: `twitter_post | telegram_post | discord_drop | conference | talk | press | other` — manual log only, never auto-polled

The split is **driven by API cost**, not by user mental model:
- Twitter API became paid ($100+/month) in 2023 → outside "indie / zero-budget" constraint
- Telegram public posts have no engagement API
- Discord ditto
- YouTube Data API v3: free tier with 10k units/day → batched videos.list call ~50× quota saving (per Phase 3 spike)

So the user sees two panels that look semantically equivalent ("things I did about my game") but are split by an invisible technical reason.

## The strategic question

Three possible architectures going forward:

### Option A — keep current split (data model = "auto-trackable" vs "manual log")
- Pro: clean separation; Phase 3 polling worker only touches `tracked_youtube_videos`
- Pro: Phase 4 charts can clearly distinguish "things we have view counts for" vs "things we just logged"
- Con: invisible to user; needs UX explanation work (already captured in todo `2026-04-28-tracked-items-vs-events-unclear`)
- Con: extending to a 4th platform requires either schema split (yet another table) OR a polymorphic events.metadata column

### Option B — unify into one `promotion_log` table
- Single table with `kind`, `url`, `metadata jsonb` — both items and events become rows
- Per-kind `auto_polled` flag drives which rows the Phase 3 worker picks up
- Pro: matches user mental model ("everything I did, in one place")
- Pro: trivial to add new platforms (just a new `kind` enum value + maybe a poll adapter)
- Con: existing Phase 2 schema needs migration (cleanup of 2 tables → 1) — would invalidate `INGEST-03` is_own auto-decision logic that lives on `tracked_youtube_videos`
- Con: queries for "videos only" (Phase 4 charts) need a `WHERE kind LIKE 'youtube_%'` filter — slower than dedicated table

### Option C — keep tables separate but UNIFY UI
- Keep `tracked_youtube_videos` and `events` as-is
- Combine UI into a single "Promotion log" panel that lists both, sorted by date
- Distinct row visuals (auto-stat indicator on YouTube rows, "manual" tag on events)
- Pro: minimal schema churn
- Pro: matches user mental model in UI without rewriting backend
- Con: list query needs UNION across two tables — Phase 3 cursor pagination becomes more complex

### Recommendation
- **Defer this decision to Phase 4 planning** when LayerChart wishlist-correlation work begins. That's the moment we'll know: do we need fast per-platform queries (favors A), or do we want a single unified timeline (favors B/C)?
- For now: ship Phase 2 with current split + the cosmetic clarification in todo `2026-04-28-tracked-items-vs-events-unclear`
- Add a **Phase 4 spike**: 1-day investigation of "what query shape does the wishlist-correlation chart need?" before committing to a refactor

## Constraints to honor in any direction

- "Indie budget" — no paid Twitter API in v1
- "SaaS = self-host parity" — schema migration must work for both
- Existing Phase 2 audit-log entries reference `events.id` and `tracked_youtube_videos.id` — any unification needs to handle audit traceability

Owner: Phase 4 planner. Add to Phase 4 RESEARCH.md once that phase opens.
