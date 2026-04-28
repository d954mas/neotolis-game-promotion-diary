---
created: 2026-04-28T05:25:00.000Z
title: /games/[id] panels "Tracked items" vs "Events" semantics unclear
area: ui
files:
  - src/routes/games/[gameId]/+page.svelte (panels)
  - messages/en.json (panel headings + helper text)
  - .planning/phases/02-ingest-secrets-and-audit/02-UI-SPEC.md (panel contracts)
---

## Problem

During Phase 2 manual UAT (2026-04-28), the user said: **"Тракед айтемs и эвенты это про одно и тоже. Или в чем разница?"**

The two panels render side-by-side on `/games/[id]` with bare headings ("Tracked items" / "Events") and no explanation of when to use which. Real semantic difference:

- **Tracked items** = YouTube videos (own or blogger) — auto-tracked via oEmbed, will get view-count polling in Phase 3
- **Events** = all other promotion activity (Twitter/Telegram/Discord posts, conferences, talks, press) — manual log, no auto-polling

The distinction matters for Phase 4 analytics ("when I did X event, did my Y video views go up?") but is invisible in current UI. A user dropping into the page for the first time sees two similar-looking panels and can't tell which to use for what.

## Solution

Three small additions:

1. **Helper subtitle under each panel heading** (i18n key):
   - Under `Tracked items`: "YouTube videos to monitor — yours or bloggers'. We'll pull view counts automatically."
   - Under `Events`: "Everything else: tweets, conference talks, Discord drops, press articles. Manual log."

2. **Distinct panel iconography or color treatment** so they visually read as different categories at a glance.

3. **Empty-state copy** should reinforce the difference — currently both empty states just say "No X yet" with example URL, which is symmetric and reinforces the confusion.

Optional: add a small `?` info-tooltip in each panel header that opens a 2-line explanation on hover/tap.

## Tests

- Update games-detail integration test to assert the new helper text renders (i18n key present + non-empty).

Owner: future phase or part of Phase 2.1 polish gap closure batch. Not blocking — both panels function, just confuses cold-start users.
