---
created: 2026-04-28T05:15:00.000Z
title: /games/[id] missing rename + add-Steam-listing UI (functional gap)
area: ui
files:
  - src/routes/games/[gameId]/+page.svelte
  - src/lib/server/http/routes/games.ts (PATCH /games/:id — exists, just no UI)
  - src/lib/server/http/routes/game-listings.ts (POST /games/:gameId/listings — exists, just no UI)
  - src/lib/server/services/games.ts (updateGame — exists)
  - src/lib/server/services/game-steam-listings.ts (addSteamListing — exists)
---

## Problem

During Phase 2 manual UAT (2026-04-28), real **functional gaps** spotted on `/games/[gameId]`:

**Gap 1: No rename UI.**
The header just renders `<h1>{game.title}</h1>` — read-only. The user has no way to fix a typo or change the title after creation. The `updateGame` service + `PATCH /api/games/:id` route both exist; only the UI is missing.

User feedback (verbatim): "Нет возможности переименовать"

**Gap 2: No way to attach a Steam listing.**
The "Store listings" panel renders `<p>No Steam listings attached yet.</p>` with NO add affordance. The `addSteamListing` service + `POST /api/games/:gameId/listings` route both exist (see Plan 02-04 SUMMARY) and accept a Steam URL — only the UI is missing. The user pasted a Steam URL on /games empty state expecting it to attach, but that flow doesn't exist (it's only the title-only create).

User feedback (verbatim): "Не понимаю как добавить стим ссылку"

This is **the entire reason the app exists** — the Steam URL is the foundation of the whole "track wishlist signals" feature. Without UI to attach a Steam listing, the user cannot do the primary use case.

## Solution

Both gaps are pure UI additions on top of already-shipped backend.

**Fix 1 — Rename UI:**
- Add an inline-edit affordance to the title `<h1>` (click-to-edit pattern, or pencil icon → input).
- On save: PATCH `/api/games/:id` with `{title}` → invalidateAll().
- Render-time validation: maxlength 200 (matches schema), no empty.
- Show `InlineError` on 4xx response.

**Fix 2 — Add Steam listing UI:**
- Add a `<PasteBox>` (or specialized form) inside the "Store listings" panel above the list.
- On paste: POST `/api/games/:gameId/listings` with `{url}` → server fetches Steam appdetails (already in addSteamListing) → invalidateAll() reloads listings.
- Empty state copy should change from "No Steam listings attached yet." to a CTA prompting to paste a Steam URL.
- Once first listing exists, the PasteBox can stay (multi-listing per game is allowed in schema, see GAMES-04a regional storefronts).

**Tests:**
- Update games-detail integration test to assert title-edit POST and Steam-listing POST flows.
- Update tests/integration/games.test.ts as needed.

## Severity

**P0/P1 — functional gap, not polish.** This blocks the primary use case of the app. Phase 2 verification should classify these as `gaps_found` and trigger gap closure.

Owner: Phase 2.1 gap closure (must land before Phase 2 is declared done in roadmap).
