---
created: 2026-04-28T06:40:00.000Z
title: /accounts/youtube — channel delete + own/not-own explainer + auto-import expectation
area: ui
files:
  - src/lib/server/services/youtube-channels.ts (no removeChannel exists)
  - src/lib/server/http/routes/youtube-channels.ts (no DELETE /youtube-channels/:id route)
  - src/routes/accounts/youtube/+page.svelte (no helper text explaining own/not-own)
  - src/lib/server/db/schema/youtube-channels.ts
  - .planning/ROADMAP.md (Phase 3 — could add auto-import as optional)
---

## Problem

During Phase 2 manual UAT (2026-04-28), three related issues on `/accounts/youtube`:

**1. No way to delete a channel.**
Plan 02-08 explicitly didn't ship `DELETE /api/youtube-channels/:id` because the service layer has no `removeChannel`. The Plan 02-08 SUMMARY documented this as a Rule 3 deviation: "service layer has no removeChannel; user-facing flow detaches per-game". But the user doesn't know that — they see a channel in the list with no delete affordance and ask "as I'm supposed to live with this forever?".

User feedback (verbatim): "У меня нет возможности удалить."

**2. "Own / not own" semantics not explained in UI.**
The chip "Own channel" appears next to the channel name with no explanation. The user asked: "В чем разница пометок мой или не мой?"

**Real meaning:**
- `is_own = true` = the user's own channel (where they publish their own gameplay/devlog videos)
- `is_own = false` = a blogger's / press channel that covers the user's games
- Used by INGEST-03 to auto-tag tracked YouTube videos: when oEmbed `author_url` matches a registered own-channel → video auto-marked `is_own = true`

**Why it matters:** Phase 4 wishlist analytics will distinguish "videos I made about my game" vs "blogger reviews of my game" — different signals for promotion ROI.

But the UI doesn't explain ANY of this.

**3. User expectation: "added channel = auto-track all its videos".**
User asked: "Этот канал я всегда трекаю? и потом могу как-то удобно на нем помечать что связано с игрой?"

This is a **legitimate expectation** that the current model doesn't meet. In current model:
- Adding a channel only registers it for INGEST-03 auto-tagging — does NOT auto-import any videos
- User must manually paste each video URL into Tracked items panel

A more user-friendly model: "add channel → auto-import last N videos as tracked items, with optional per-video toggle to attach to game". This is a Phase 3+ feature — needs YouTube Data API quota budget and `playlistItems.list` polling.

## Solution

**Fix 1 — Add channel delete (Phase 2.1):**
- Add `removeChannel(userId, channelId)` to `src/lib/server/services/youtube-channels.ts` — soft-delete pattern matching games (cascade detach from `game_youtube_channels` link table)
- Add DELETE `/api/youtube-channels/:id` route to `src/lib/server/http/routes/youtube-channels.ts`
- Add MUST_BE_PROTECTED entry for the new route
- Add cross-tenant 404 test
- Add UI: `<ConfirmDialog>` on channel row delete button (matches game/key delete pattern)
- Audit: new `channel.removed` action

**Fix 2 — UI explainer for own/not-own (Phase 2.1):**
- Add helper text under the page heading explaining the distinction
- Suggested copy:
  > "Register YouTube channels to help the app distinguish your own videos from blogger coverage. When you add a tracked video, we'll auto-tag it based on which channel published it."
- Per-row tooltip on the "Own / Blogger" chip explaining what it means
- **Note:** if Phase 2.1 unifies items + events (todo `2026-04-28-rethink-items-vs-events-architecture`), the `is_own` flag moves to `events.author_is_me` — same explainer applies, different field name

**Fix 3 — Auto-import option (Phase 3 enhancement, NOT blocking):**
- For own channels, optionally enable "auto-import recent videos" via YouTube Data API `playlistItems.list` against the channel's uploads playlist
- Schema addition: `youtube_channels.auto_import boolean DEFAULT false`
- Phase 3 polling worker: per-channel cron tick fetches last N videos, creates tracked-item rows
- Per-video user choice to attach to which game (via cross-game timeline)
- Out of scope for Phase 2.1 — record as Phase 3 ROADMAP enhancement

## Severity

- Fix 1 (delete): **P1** — basic CRUD gap
- Fix 2 (explainer): **P1** — invisible feature, no one will use is_own correctly without docs
- Fix 3 (auto-import): **P2** — UX improvement for Phase 3

Owner: Phase 2.1 for fixes 1+2; Phase 3 ROADMAP for fix 3.
