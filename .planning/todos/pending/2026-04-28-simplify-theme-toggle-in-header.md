---
created: 2026-04-28T04:25:00.000Z
title: Move ThemeToggle out of AppHeader to /settings only
area: ui
files:
  - src/lib/components/ThemeToggle.svelte
  - src/lib/components/AppHeader.svelte
  - src/routes/settings/+page.svelte
  - .planning/phases/02-ingest-secrets-and-audit/02-UI-SPEC.md (theme toggle contract)
---

## Problem

During Phase 2 manual UAT (2026-04-28), two issues with the `ThemeToggle` in `AppHeader`:

1. **3-state toggle (light / dark / system) is confusing to a real user.** The user said "в переключателе темы 3 состояния. Не понимаю" — they didn't grok that "system" means "follow OS preference". Standard practice across products (GitHub, Slack, etc.) but our user found it non-obvious. The icon/label may not communicate the third state clearly.

2. **Takes too much space in the header**, especially at 360px viewport (UX-02 hard requirement). The toggle competes with `AppHeader`'s name + nav, eating horizontal real estate that's already tight.

User's suggested fix: **remove ThemeToggle from `AppHeader` entirely; keep it only on `/settings`.**

## Solution

Two-part change:

1. **Remove from header**:
   - Delete the `<ThemeToggle />` slot from `AppHeader.svelte`
   - Update `02-UI-SPEC.md` to reflect "ThemeToggle lives only on /settings" (not blocking — UI-SPEC is a contract, not a law).

2. **Replace 3-state with simpler UI on /settings**:
   - Option A (simplest): keep current 3-state but with clearer labels/icons + tooltip explaining "system = follow your OS"
   - Option B (cleaner): split into a 2-state toggle (light/dark) + a separate "Match my OS theme" checkbox below it. More familiar metaphor.
   - Option C (smallest diff): keep 3-state radio buttons with explicit labels under each: "Light", "Dark", "Match system". Less ambiguous than icon-only.

Recommend Option C — minimal diff, semantically clearest.

3. **Tests**:
   - Update theme integration tests (`tests/integration/theme.test.ts`) — assert ThemeToggle no longer renders in AppHeader.
   - Add /settings page test for theme switching.

Out of scope: changing the cookie+DB plumbing (UX-01 contract is fine; this is purely UI placement).

Owner: future phase. Not blocking Phase 2 — UX-02 (360px no-scroll) is currently satisfied even with the toggle in the header (the layout doesn't break, it's just cluttered).
