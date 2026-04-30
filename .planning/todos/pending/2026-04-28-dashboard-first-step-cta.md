---
created: 2026-04-28T04:32:00.000Z
title: Dashboard needs a clear "first step" CTA for empty state
area: ui
files:
  - src/routes/+page.svelte
  - src/lib/components/EmptyState.svelte
  - messages/en.json
  - .planning/phases/02-ingest-secrets-and-audit/02-UI-SPEC.md (dashboard contract)
---

## Problem

During Phase 2 manual UAT (2026-04-28), the dashboard `/` showed:
- "Hello Dev User. Your dashboard is empty — Phase 2 lands games."
- 4 nav links: Games / Events / Audit log / Settings

The user feedback: **"4 доп кнопки и это путает, я не понимаю куда. Нужен какой-то текст. Типа первый шаг добавить игру."**

The current empty-state text says the dashboard is empty but doesn't tell the new user what to *do*. They land on the dashboard for the first time and see 4 navigation cards with no guidance on which one matters first. For someone whose mental model is "I just signed up, what now?" — this is friction.

The 4 nav links are valuable navigation but they all look equal. The user can't tell that "Games → Add your first game" is the *only* path forward when nothing exists yet.

## Solution

When `data.user` exists AND there are zero games (load this signal in `+page.server.ts` — either count games or check first page is empty):

1. **Prominent CTA above the nav grid** (or replacing it):
   - Headline: "Add your first game" (or "Шаг 1: добавь игру" in i18n)
   - Subtext: 1-2 sentences explaining "Paste a Steam URL — we'll track wishlist signals automatically as you log promotion activity."
   - Big primary button → links directly to `/games` (or opens PasteBox inline if we want zero-click)

2. **De-emphasize the 4 nav cards** when in empty state:
   - Either hide them entirely until a first game exists
   - Or show them smaller below the CTA with text "Once you add a game, you'll log activity here ↓"

3. **Once at least one game exists**, the dashboard reverts to its current "navigation hub" layout — the CTA is a one-time onboarding nudge.

4. **i18n keys** to add to `messages/en.json`:
   - `dashboard_empty_cta_title`: "Add your first game"
   - `dashboard_empty_cta_body`: "Paste a Steam URL to start tracking wishlist signals."
   - `dashboard_empty_cta_button`: "Add a game →"

## Tests

- Update dashboard integration test to assert empty-state CTA renders when `games.length === 0`
- Assert nav grid still renders when at least one game exists
- 360px viewport: CTA button reachable without horizontal scroll

Out of scope: a multi-step onboarding flow (would need a new "onboarding done" flag on user — separate phase).

Owner: future phase. Not blocking Phase 2 — current dashboard renders without errors and is technically usable, just not optimal UX for cold-start users.
