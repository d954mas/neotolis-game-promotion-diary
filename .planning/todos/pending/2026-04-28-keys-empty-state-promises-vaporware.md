---
created: 2026-04-28T06:08:00.000Z
title: /keys/steam empty state promises features that don't exist
area: ui
files:
  - messages/en.json (empty_keys_steam_body)
  - src/routes/keys/steam/+page.svelte
---

## Problem

During Phase 2 manual UAT (2026-04-28), user reading /keys/steam empty state:
> "A Steam Web API key is optional — manual wishlist entry and Steamworks CSV import work without one. Get a key at https://steamcommunity.com/dev/apikey if you want auto-fetch in Phase 3."

User feedback: **"Не понятно что за ключ. Как получить csv. Это будет потом?"**

Two real problems with this copy:

1. **"manual wishlist entry"** — does NOT exist anywhere in Phase 2. There's no UI for entering wishlist counts. Will probably land in Phase 4 (LayerChart wishlist metrics).
2. **"Steamworks CSV import"** — does NOT exist anywhere in Phase 2. There's no CSV upload UI. Probably a future Phase 4+ feature.

So the empty state is making promises about vaporware. The user sees "manual wishlist entry" and "CSV import" mentioned, looks for them, can't find them, and gets confused. The Steam Web API key purpose itself is also unclear — empty state doesn't explain WHAT the key actually does or WHEN it will be used.

## Solution

Rewrite the empty state copy to:
1. Explain what a Steam Web API key DOES (in plain language, not just "auto-fetch in Phase 3")
2. Stop mentioning features that don't exist yet
3. Make the "this is optional, you can use the app fine without it" clearer

Suggested new copy (English, then translate via Paraglide):

```
Heading: "No Steam Web API key saved"
Body:    "Adding a Steam Web API key lets the app automatically fetch
          your game's wishlist counts and review stats once Phase 3
          ships. You can use everything in Phase 2 without one — the
          key is purely for upcoming auto-polling. Get a key at {url}
          if you want to be ready for Phase 3."
```

Or even simpler — defer the key UI entirely until Phase 3 actually uses it:

```
Heading: "Steam Web API keys"
Body:    "Phase 3 will add automatic wishlist polling. For that we'll
          need your Steam Web API key. You can save one now to be ready,
          or wait until Phase 3 lands. Get a key at {url}."
```

The second variant honestly tells the user "this page exists but its main consumer is a future phase" — matches the actual product state.

## i18n updates

- Replace `empty_keys_steam_body` with the new copy
- Add `keys_steam_phase3_explainer` if we adopt the deferred variant

## Severity

**P1** — misleading copy that promises vaporware. Bundle into Phase 2.1.

Owner: Phase 2.1 gap closure.
