---
created: 2026-04-28T07:25:00.000Z
title: STRATEGIC IA — three primary views: Sources / Feed / Per-game (chronological feed is the primary nav)
area: planning
files:
  - .planning/PROJECT.md (Architecture — IA section)
  - .planning/ROADMAP.md (Phase 3-6 nav structure)
  - src/routes/feed/ (NEW — primary nav)
  - src/routes/sources/ (NEW — replaces /accounts/youtube)
  - src/routes/games/ (existing)
  - related todos:
    - 2026-04-28-data-sources-unified-model (data layer)
    - 2026-04-28-rethink-items-vs-events-architecture (events unification)
    - 2026-04-28-channel-to-inbox-auto-import-flow (now folded into feed)
---

## Problem

During Phase 2 manual UAT (2026-04-28), user crystallized the navigation model:

> **"У меня как будто есть events это всё что связано с игрой. Есть источники, и есть лента? В ленте я в хронологическом порядке с фильтрами вижу всё, и могу отметить всё что связано с игрой?"**

Translation: *"Events = things connected to a game. Sources = data sources. Feed = chronological view of everything with filters, where I mark what's game-related."*

This is NOT three separate concepts in the data layer — it's **three views over one events table** (post-Phase-2.1 unification). The user's refinement vs my earlier "inbox" framing:

- "Inbox" implies email-style triage of unread items
- "Feed" implies social-media chronological browsing — matches the user's mental model for a promotion-tracking tool
- Per-game view is the **curated output** of the curation that happens in the feed

## Three views, one data model

### View 1 — `/sources` (where data comes from)
- Registry of `data_sources` (per todo `2026-04-28-data-sources-unified-model`)
- Add/remove sources, toggle auto_import, see polling status
- This is configuration, not content browsing

### View 2 — `/feed` (chronological pool — PRIMARY NAVIGATION)
- All events sorted by `occurred_at DESC`, paginated
- Every event row regardless of source_id (auto-imported), game_id (attached or not), kind, author
- Filters as URL params (bookmarkable + shareable):
  - `?source=<id>` — only this data source
  - `?kind=youtube_video|reddit_post|...` — only this kind
  - `?game=<id>` — only this game
  - `?attached=true|false` — only attached / only inbox
  - `?author_is_me=true|false` — only mine / only others
  - `?from=<date>&to=<date>` — date range
- Per-row actions: "Attach to game" picker, "Open detail", "Delete" (with confirm)
- "Mark as not game-related" sets a flag so the row drops out of `attached=false` view (still findable)
- This becomes the **primary daily navigation** — landing page after login

### View 3 — `/games/[id]` (per-game curated)
- Same data, filtered to `events WHERE game_id = :id`
- Grouped by month (current Phase 2 layout)
- Per-game timeline of "what I did for this game" — useful for retrospectives, sprint reviews, marketing post-mortems

## Implications

**Navigation hierarchy (post-Phase-2.1):**
```
/feed              ← landing page after login (was /games)
  ├─ all events, filterable
  └─ this is the user's daily workspace

/games             ← list of games (creation hub)
  └─ /games/[id]   ← per-game curated view (existing)

/sources           ← data source registry (was /accounts/youtube)

/audit             ← system audit log (existing)

/settings          ← settings (existing)
```

**Default landing change:**
- Current: `/` is dashboard with 4 nav links (todo `2026-04-28-redirect-dashboard-to-games` proposed redirect to `/games`)
- New: `/` redirects to `/feed` (the daily workspace)
- Dashboard concept fully retired until Phase 4 LayerChart graphs justify it

**Mobile (360px) considerations:**
- Feed must work on phone — the user is checking "what happened today" between meetings
- Filter chips collapse to a "Filters (3)" button that opens a sheet
- Each event row compact: kind icon + title + game tag (if attached) + relative time

## Phase split

**Phase 2.1 (alongside data_sources rename + events unification):**
- Build /feed page (basic chronological list with kind/source/game/attached filters)
- Per-row "Attach to game" picker
- /accounts/youtube → /sources rename
- Default redirect: / → /feed for authenticated users
- Drop dashboard nav cards entirely

**Phase 3 (when polling lands):**
- Auto-imported events fill the feed naturally
- Inbox highlighting: visually distinguish "new since last visit" rows in feed (like social media unread)
- Per-source polling status indicator in /sources

**Phase 4 (LayerChart):**
- Per-event detail page from feed row click (todo `2026-04-28-event-detail-page`)
- Cross-platform stats correlation in feed row (e.g., "this video → 47 wishlist adds in following week")

## Severity

**P0 IA** — this is the **primary navigation pattern** of the product. Without `/feed` as the daily workspace, the app reverts to "go visit each game one by one" — which doesn't match the promotion-analytics use case.

Bundle into Phase 2.1 along with data_sources + events unification + game_id nullable. The schema is there to support all three views; this todo just defines the navigation+UX layer.

## Risk

The `/feed` route is genuinely new code (no current page corresponds). Phase 2.1 scope expands slightly to include it. But the alternative (ship Phase 2.1 without /feed) leaves the user without the primary workspace they just defined as critical.

Owner: Phase 2.1 — fold into the planning batch as a first-class page (not a stretch goal).
