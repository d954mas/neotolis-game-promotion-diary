---
created: 2026-04-28T06:27:00.000Z
title: Event detail page /events/[id] with extra metadata (comments, notes)
area: planning
files:
  - src/routes/events/[eventId]/+page.svelte (does not exist yet)
  - src/routes/events/[eventId]/+page.server.ts (does not exist yet)
  - src/lib/server/services/events.ts (getEventById exists — return shape needs enrichment)
  - src/lib/server/db/schema/events.ts (might need notes/comments columns)
---

## Problem

During Phase 2 manual UAT (2026-04-28), user wanted detail page per event:
**"Хочется на каждый эвент свою карточку. С данными, комментариями и тд."**

Current state: events render as inline rows in `/events` timeline + `/games/[id]` events panel. There's no `/events/[id]` route — clicking an event does nothing (no link target).

What "carousel/card" implies (interpretation):
- Dedicated URL for the event (bookmarkable, shareable internally)
- Full metadata view: title, kind, occurredAt, url (if any), creator, audit trail (when created/edited/deleted via the existing audit_log)
- **Notes / comments** field — user wants to add context after the fact (e.g., "this Twitter post got reactions from a publisher")
- Future: cross-reference with metric data (Phase 4 — when wishlist correlation lands)

This is the natural complement to `/games/[id]` — a similar pattern where the row in the list expands into a full page.

## Solution sketch

**Schema (small extension):**
- Add `notes text DEFAULT ''` to `events` table (free-form markdown notes per event)
- Optionally a separate `event_comments` table (rows = thread of timestamped notes) — but for v1 a single notes field is enough

**Backend:**
- `getEventById(userId, eventId)` already exists (Plan 02-06)
- Add `updateEventNotes(userId, eventId, notes)` service
- Add PATCH `/api/events/:id/notes` route
- Audit: extend with `event.notes_edited` action

**Frontend:**
- Route `src/routes/events/[eventId]/+page.svelte` + `+page.server.ts`
- Layout: header (kind chip, title, date, game link, source URL link if any) + notes editor (textarea or simple markdown editor) + audit timeline ("created on X, edited on Y") + (Phase 4) metric cards
- `/events` timeline rows: wrap in `<a href={`/events/${ev.id}`}>` so clicking opens detail
- `/games/[id]` events panel: same — wrap in link

**i18n keys:** ~5 new (event_detail_heading, event_detail_notes, event_detail_no_notes, etc.)

## Severity

**P2** — not blocking Phase 2 (events function via inline rows). Belongs in Phase 4 when LayerChart wishlist-correlation needs per-event metric drilldown anyway.

After Phase 2.1 unifies items + events (todo `2026-04-28-rethink-items-vs-events-architecture`), this becomes **the** detail page for ALL promotion log entries — both YouTube videos and Twitter posts get a card. That's a strong reason to hold this for the unified architecture.

Owner: Phase 4 planner — fold into the LayerChart phase as part of the per-item drilldown work.
