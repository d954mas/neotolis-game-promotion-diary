---
created: 2026-04-28T06:18:00.000Z
title: /events layout — game tag eats space + missing per-game filter
area: ui
files:
  - src/routes/events/+page.svelte:178-185 (game-tag rendered as separate row above EventRow)
  - src/routes/events/+page.svelte:234-246 (game-tag styles — margin around chip)
  - src/lib/components/EventRow.svelte (currently doesn't accept gameTitle slot)
  - src/lib/server/services/events.ts (listAllEventsForUser — returns global merged list, no filter param)
  - src/lib/server/http/routes/events.ts (GET /api/events — does it accept ?gameId=?)
---

## Problem

During Phase 2 manual UAT (2026-04-28), three issues on /events (global timeline):

**1. Confirmed it's a global pool across all games.** User wanted clarification — yes, `/events` shows events for ALL games merged (per `listAllEventsForUser` service / +page.server.ts via parallel `listEventsForGame` calls). This is by design (timeline view), not a bug.

**2. Game tag layout is ugly — eats space.**
Current markup (line 180):
```svelte
<li>
  <a class="game-tag" href={`/games/${ev.gameId}`}>{ev.gameTitle}</a>
  <EventRow event={ev} onDelete={() => deleteEvent(ev.id)} />
</li>
```
The game-tag chip renders as a separate block ABOVE the EventRow, with `margin: var(--space-xs) var(--space-md)` plus the EventRow's own padding. Each event takes ~2× the vertical space it should. The game tag should sit INLINE with the event metadata (e.g., next to the time or next to the kind chip), not on its own line.

User feedback (verbatim): "странно выглядит ссылка на игру, она сверху, и все занимает больше места чем должно"

**3. No per-game filter on /events.**
The user has to scroll through every event of every game with no way to narrow to "just events for Hades". There's no `<select>`, no chip filter, no URL param. With multiple games this becomes unusable.

User feedback (verbatim): "вот тут хочется добавить фильтрацию по играм"

## Solution

**Fix 1 — Inline game tag:**
- Update `EventRow.svelte` to accept an optional `gameTitle?: string` prop and `gameId?: string`. When set, render the game name as a small inline link next to the kind chip (within the EventRow grid).
- Drop the separate `<a class="game-tag">` from `/events/+page.svelte` line 180 — pass `gameTitle` to EventRow instead.
- On `/games/[gameId]` (per-game detail), do NOT pass gameTitle (we're already in that game's context).

**Fix 2 — Per-game filter:**
- Add a game `<select>` filter at the top of /events (or chip group like /audit will get).
- URL state: `/events?gameId=<id>` — bookmarkable, sharable, browser back/forward works.
- Server-side: `listAllEventsForUser(userId, { gameId? })` — pass through to underlying query.
- "All games" is the default option.

**Optional bonus:**
- Date range filter (last 30 / 90 / all)
- Kind filter (mirrors /audit)

(Both bonuses can be deferred if scope creeps.)

## Tests

- /events integration test: assert ?gameId= filter narrows the list to that game only
- EventRow unit test: assert gameTitle slot renders only when prop is set
- /games/[id] integration test: assert events panel does NOT render game name (we're in game context already)

## Severity

**P1** — layout is functional but visually wrong (UX-02 risk: at 360px the doubled height makes the timeline scroll forever). Bundle into Phase 2.1.

## Note

After Phase 2.1 unification (todo `2026-04-28-rethink-items-vs-events-architecture`), `/events` becomes the unified promotion log. This todo's fixes apply to that unified page — the game tag + filter logic is the same.

Owner: Phase 2.1 gap closure.
