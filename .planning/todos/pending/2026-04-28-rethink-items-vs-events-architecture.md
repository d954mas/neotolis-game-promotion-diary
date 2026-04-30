---
created: 2026-04-28T05:35:00.000Z
updated: 2026-04-28T05:50:00.000Z
title: ARCH P0: unify tracked_items + events into single events table (user's proposal)
area: planning
files:
  - src/lib/server/db/schema/tracked-youtube-videos.ts (DROP)
  - src/lib/server/db/schema/events.ts (EXTEND with kind enum + author_is_me + url)
  - src/lib/server/services/items-youtube.ts (FOLD INTO events.ts)
  - src/lib/server/services/events.ts (extend)
  - src/lib/server/http/routes/items-youtube.ts (DROP — events route covers all)
  - src/lib/server/services/audit/actions.ts (item.* actions fold into event.*)
  - .planning/REQUIREMENTS.md (INGEST-02..04 + EVENTS-01..03 reconcile)
  - drizzle/0002_unify_events.sql (NEW migration)
---

## Problem

During Phase 2 manual UAT (2026-04-28), the user surfaced two related observations and proposed a clean architectural simplification:

**Observation 1** — "Tracked items vs Events panels are confusing — what's the difference?"
**Observation 2** — "Can I track Twitter posts? Or YouTube videos? Why is one auto-tracked and the other not?"

After my answer (split is driven by API cost: free YouTube vs paid Twitter), the user proposed a much simpler model:

> **"Все это события. Просто есть события где автор я, мое видео. И где автор не я блоггер. И так со всеми источниками данных. И тогда например конференция, доклад, просто не трекаем."**

In English: **everything is an event. The dimension that matters is "author = me vs author = blogger". Polling/auto-stats apply only to the kinds where we have a free adapter (currently YouTube). Conferences and talks are events with no auto-stats, period.**

This nails the fundamental mismatch in the current Phase 2 schema:

- We split `tracked_youtube_videos` from `events` because **we** thought "things we can poll" vs "things we can't" was the natural division
- The **user** thinks "promotion activity I did" is the natural division — and the dimension that matters is "author = me" vs "author = blogger"
- The polling capability is a **technical attribute of the kind**, not a categorical division at the data-model level

## Proposed schema (user's model)

Single `events` table:

```sql
events:
  id              text PRIMARY KEY
  user_id         text NOT NULL
  game_id         text NOT NULL REFERENCES games(id)
  kind            event_kind NOT NULL
  author_is_me    boolean NOT NULL DEFAULT false   -- ← user's discriminator
  url             text                              -- nullable: conferences/talks have no url
  title           text NOT NULL
  occurred_at     timestamptz NOT NULL
  added_at        timestamptz NOT NULL DEFAULT now()
  metadata        jsonb DEFAULT '{}'                -- e.g. youtube views snapshot, conference location
  -- soft-delete + audit invariants from Phase 2 schema preserved

event_kind ENUM:
  youtube_video       -- pollable (Phase 3 YouTube Data API)
  twitter_post        -- not pollable (no free Twitter API)
  telegram_post       -- not pollable
  discord_drop        -- not pollable
  reddit_post         -- pollable (Phase 3 Reddit OAuth) — INGEST-01 deferred
  conference          -- not pollable (no API)
  talk                -- not pollable (no API)
  press               -- not pollable (could scrape but out of scope)
  other               -- not pollable
```

**Polling worker (Phase 3):** `WHERE kind IN ('youtube_video', 'reddit_post') AND url IS NOT NULL` — clean conditional, no table split needed.

**INGEST-03 own/blogger detection:** moves to setting `author_is_me = true | false` on YouTube event creation, based on `findOwnChannelByHandle(oembed.author_url)`.

## Why now (not Phase 4)

The strategic todo I previously wrote (and replaced with this version) said "defer to Phase 4". **Wrong call** — the user is right that NOW is the cheapest time:

- Phase 2 just shipped, **zero production data** (one test game + one test event in dev DB only)
- Migrating Phase 2 schema → unified schema = simple destructive `DROP TABLE tracked_youtube_videos` + extend `events` (no data preservation needed)
- Phase 3 polling worker hasn't been written yet — designing it against the unified schema is cheaper than writing it twice
- Audit log entries reference both tables — migrating cleanup is a one-time cost
- Every additional Phase makes this refactor more expensive

## Phase 2.1 (gap closure) scope

This todo + the existing P0 gap (rename + add Steam UI) + any other functional gaps from continuing UAT all roll into Phase 2.1. Suggested wave breakdown:

**Wave A (schema + data layer):**
1. Drop `tracked_youtube_videos` table; extend `events` table; new migration `0002_unify_events.sql`
2. Update `event_kind` enum to add `youtube_video` (and `reddit_post` for forward-compat)
3. Add `author_is_me` boolean column on `events`
4. Update audit actions enum: `item.add` / `item.remove` fold into `event.add` / `event.remove`

**Wave B (service + route layer):**
5. Fold `items-youtube.ts` service into `events.ts` (parseIngestUrl already routes to the right kind)
6. Drop `items-youtube.ts` HTTP route; events route handles all kinds
7. Update INGEST-03 logic: `findOwnChannelByHandle` sets `author_is_me` instead of separate `is_own` column

**Wave C (UI):**
8. Drop "Tracked items" panel on `/games/[id]`; rename "Events" panel to "Promotion log" (or keep "Events")
9. Filter chips in panel: "Mine only / Others only / All", "Pollable only", per-kind filter
10. PasteBox accepts any supported URL kind, routes via parseIngestUrl

**Wave D (other gaps):**
11. Rename UI on /games/[id]
12. Add Steam listing UI on /games/[id]
13. (other UAT findings)

**Wave E (smoke + verify):**
14. Smoke test extends to assert unified events flow
15. Re-run Nyquist coverage check

## Risk

- This is a P0 architectural change. Plan checker should flag if anything in current Phase 2 makes assumptions that the unified model breaks (audit invariants, cursor pagination, anonymous-401 sweep).
- Constraint check: must hold "SaaS = self-host parity" after migration. Migration must work for both modes.

Owner: Phase 2.1 gap closure. **Block Phase 2 verifier from declaring `passed`** — surface this as `gaps_found` so the next step is `/gsd:plan-phase 2.1`.
