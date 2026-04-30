---
created: 2026-04-28T04:38:00.000Z
title: Redirect "/" to "/games" until dashboard has real metrics (Phase 4)
area: ui
files:
  - src/routes/+page.svelte
  - src/routes/+page.server.ts (would need creation)
  - .planning/ROADMAP.md (Phase 4 — LayerChart wishlist metrics land here)
---

## Problem

During Phase 2 manual UAT (2026-04-28), the user asked: **"Главная как интро получается, почему не начать сразу и всегда с games?"**

The current dashboard `/` shows:
- Welcome greeting with name
- 4 nav links (Games / Events / Audit / Settings)

That's it. No metrics, no summary, no actionable content. It's a landing page that exists *to be navigated away from* — every user who arrives there has to make exactly one click to get somewhere useful.

The user's mental model: **"I open the app to log promotion activity → I should land on the games list."** The dashboard adds zero value before the Phase 4 wishlist-metrics land.

## Solution

**Until Phase 4 lands**, redirect `/` → `/games` for authenticated users:

1. Add `src/routes/+page.server.ts` with a `load` function:
   ```ts
   import { redirect } from "@sveltejs/kit";
   export const load = ({ locals }) => {
     if (locals.user) throw redirect(303, "/games");
     // anon → fall through to current intro page (or redirect to /login)
   };
   ```

2. Anonymous users still see the public landing page (current `/+page.svelte` becomes the marketing/intro for non-logged-in visitors).

3. **In Phase 4**, when `LayerChart` wishlist metrics land on the dashboard, **revisit this decision**:
   - If the dashboard becomes a real summary page → remove the redirect, restore `/` as the post-login landing
   - If the dashboard stays nav-only → keep the redirect

## Tests

- Auth integration test: GET `/` with valid session → 303 to `/games`
- Anon test: GET `/` without session → 200 with intro/marketing content (or 303 to `/login` per existing PROTECTED_PATHS contract)

## Open question

Phase 4 owner: please re-evaluate this redirect when wishlist-metrics ship. The redirect is a *temporary* UX shortcut for the games-only Phase 2 era. If kept, document the rationale; if removed, restore the dashboard intro.

Owner: future phase (could be Phase 2.1 polish or Phase 3 ingest hardening — small enough to fit anywhere). Not blocking Phase 2.
