---
title: Detail views — Event / Video / Channel browser
captured: 2026-05-06
captured_during: Phase 3.0 UAT (live local stack)
priority: P1 — Phase 3.0 surfaced the missing read paths; ship before
          v1.0 launch so the polling pipeline has a UI to back it up.
related_phase: 3.0 (built the polling backend; the consumer UIs are gaps)
---

## Context

Phase 3.0 ships the YouTube polling pipeline + per-video snapshot history +
auto-import discovery, but the user-facing read paths are limited to:

- `/feed` — list of events (carries view/like/comment count after this
  session's fix, but no detail surface).
- `/events/[id]/edit` — edit form for an event (write path, not read).
- `/admin` — operator dashboard.

UAT operator (2026-05-06) surfaced the conceptual model that the data
layer already supports but the UI doesn't:

> "вот у меня есть страница события. Там событие и мои комментарии.
>  И еще может быть отдельно вью для видео? Например потом я буду
>  смотреть ютуб канал, и там не будет евента на это видео"

Three distinct concepts, three distinct views needed.

## Domain model recap

| Entity | Storage | Public/Tenant | Identity |
|---|---|---|---|
| Channel | `data_sources` (tenant) + `youtube_channel_metadata_cache` (public) | both | `channel_id` (UC*) shared; `data_source.id` per-tenant |
| Video | `youtube_video_snapshots` (public) | public | `video_id` (external YouTube id) |
| Event | `events` (tenant) | tenant | `event.id` per-tenant; `external_id` links to a Video |

A Video has 0..N snapshot rows (time series). An Event has 0..1 attached
Video (via `external_id`). A Channel has 0..N Videos (via uploads playlist).
A user has 0..N Events; a Video can have 0..N Events across all users
(but at most one per user — schema unique on (user_id, kind, external_id)).

## Proposed views

### A. Event detail — `/events/[id]` (read view)

Replaces the "open the edit form to see what's there" workaround.

Shape:
- Event header: title, kind, occurred_at, source chip (if auto-imported)
- For kind=youtube_video: lazy YouTube iframe (click thumbnail → load).
  youtube-nocookie.com variant for privacy (no cookie set unless user
  clicks the player). Aspect 16:9, max-width matches feed card width.
- User panel: notes (markdown? plain text?), attached games (junction
  rows), tier badge (the resurrected PollingBadge — Hot/Cold/Frozen
  vocabulary belongs here, not on /feed).
- Stats panel for kind=youtube_video: latest counters + 30-day sparkline
  (view count over time, sourced from youtube_video_snapshots history).
  Refresh button → POST /api/events/:id/refresh-poll (Phase 3.0 plan 08
  already shipped this endpoint, now it gets a UI).
- Action row: edit, mark standalone, attach game, delete.

Wires up:
- existing PollingBadge component (currently unused after Phase 3.0
  post-build polish)
- existing RefreshNowButton component (currently unused)
- existing /api/events/:id/refresh-poll route

### B. Video detail — `/videos/[externalId]`

Standalone view of a YouTube video, regardless of whether the user has
an Event attached. Use case: while browsing a channel's uploads you spot
a video you didn't paste. You want to see its stats and decide whether
to create an Event.

Shape:
- Video iframe (lazy, same pattern as event detail)
- Latest snapshot stats + 30-day sparkline (same as event detail)
- Channel chip → /sources/[id]
- Bottom bar: "Create event from this video" CTA. POSTs to ingest
  service with the canonical watch URL — reuses the manual-paste flow.
  If an event already exists for this user+video, swap the CTA for
  "View your event" → /events/[that event id].

Tenant-scope: video stats are public-data, so this view renders for any
authenticated user. The "your event" chip + CTA branch on `event` lookup
scoped to the caller.

### C. Channel browser — `/sources/[id]`

Listing of every upload from a channel — both events the user has
attached AND videos they haven't (yet). Discovery surface.

Shape:
- Channel header: title, handle, channel_id chip, last backfill at
- Upload list (cursor pager): each row shows thumbnail, title,
  publishedAt, latest viewCount. Right-side chip:
  - "Your event" if events exists for (this user, this video)
  - "Create event" otherwise (links to Video detail with the CTA primed)
- Filter toggle: "Show events only" vs "All uploads".
- Backfill status: "1000 of ~5000 imported. Continuation drains at 10%
  quota reserve" — surfaces the continuation-backfill behavior captured
  in 2026-05-06-continuation-backfill-quota-reserve.md.

Backfill data path: on demand the loader fetches the channel's uploads
playlist again (cached against the channel_id key). For channels with
>1000 history we walk the same MAX_PAGES bound — pagination is a UI
concern, not a backend gap.

## Schema deltas

None for views A and B. View C may want a small denormalization (a
materialized view "latest stats per (channel, video)") if the join cost
shows up under load — defer until profiling says so.

## Acceptance hint

Three plans, one phase (3.0.1 or 3.1):
- W0: route scaffolding + Paraglide keys + DTO additions
- W1: Event detail read view + iframe + sparkline component
- W2: Video detail view + create-event CTA wiring
- W3: Channel browser + filter toggle + backfill-status surface
- W4: Integration tests + smoke gate
- W5: VERIFICATION

Estimated 3–5 days depending on test coverage depth + sparkline component
ambition (custom SVG vs a chart library — recommend `chart.js` for
indie-budget reasons; ~30KB gzip, no telemetry).
