---
created: 2026-04-28T04:48:00.000Z
title: /games empty state contradicts the actual create flow (Steam URL vs title-only)
area: ui
files:
  - src/routes/games/+page.svelte:119-128
  - src/lib/components/EmptyState.svelte
  - messages/en.json (empty_games_body, empty_games_heading)
---

## Problem

During Phase 2 manual UAT (2026-04-28), real UX bug spotted:

The `/games` empty state copy says **"You'll paste your Steam store URL like https://store.steampowered.com/app/1145360/HADES/ on the next screen"** — implying the user will paste a URL.

But the actual `+ New game` button opens a form that asks **only for a title** (`<input>` for `newTitle`, POST `/api/games` with `{title}`). No URL involved at game-creation time.

The Steam URL paste happens on the `/games/[gameId]` detail page where you add a Steam listing to an existing game (separate flow).

So the empty state actively misleads the user. They expect "paste URL → game appears" but get "type a title → empty game appears → now go paste URL on detail page".

User feedback (verbatim): "как будто хочется чтобы я добавил url прямо тут, я могу не понять. Текст сделай без упоминания стима."

## Solution

Two options:

**Option A — fix the copy (smallest diff)**:
- Drop the Steam URL example from `empty_games_body` and `empty_games_heading` in `messages/en.json`
- New copy: "Add your first game — give it a title. You'll attach Steam, YouTube channels, and tracked videos on the game page."
- Keep the `+ New game` flow as-is (title-only).

**Option B — make the empty state actually paste a URL (better UX, bigger change)**:
- Restructure the create flow so empty state has a single PasteBox: paste Steam URL → server fetches Steam appdetails → creates game with title pre-filled from Steam → redirects to detail page with the listing already attached
- Reuses existing `addSteamListing` service + `fetchSteamAppDetails` from Plan 02-04
- Removes the artificial "title only" intermediate step
- Aligns with the user's mental model

Recommend **Option B** — matches what the empty state copy already promises and removes a confusing two-step flow. The current title-only create + then-paste-URL is an artifact of the schema (game and game_steam_listing are separate tables) leaking into UX.

## Tests

- Update games empty-state integration test to assert the new copy / no Steam URL mention (Option A) OR assert the PasteBox flow (Option B)
- Update `tests/integration/games.test.ts` to cover the URL-first create flow if Option B

Owner: future phase. Not blocking Phase 2 — current flow works (title → blank game → URL on detail page) but is confusing.
