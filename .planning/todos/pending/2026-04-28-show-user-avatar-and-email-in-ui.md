---
created: 2026-04-28T04:15:11.017Z
title: Show user avatar + email in AppHeader (account disambiguation)
area: ui
files:
  - src/lib/components/AppHeader.svelte:1-50
  - src/routes/+layout.svelte
  - src/lib/server/db/schema/auth.ts (image column)
  - src/lib/server/dto.ts (toUserDto — currently strips image?)
---

## Problem

During Phase 2 manual UAT (2026-04-28), the user noticed `AppHeader` only displays the user's *name* — no email, no avatar. If a user has multiple Google accounts (personal + work), they cannot tell from the UI which account they are currently logged into. This is a real-world UX problem: the user explicitly said "Сейчас не понимаю какой это у меня аккаунт".

The DB schema already has a nullable `image` column on the `user` table (Better Auth populates it from Google's `picture` claim automatically when a real Google login happens), so no migration is needed — the data is already there in production. The problem is purely UI: no Svelte component reads or renders `user.image`.

Email is similarly stored on `user.email` but only surfaced on `/settings`. The header should show enough identity at a glance.

## Solution

Two-part change, single small phase:

1. **AppHeader avatar + email**:
   - Update `AppHeader.svelte` to accept `image: string | null` in addition to `name + email`.
   - Render a small circular avatar (32×32) on the left of the name. If `image` is null, render initials in a colored circle (use the same color hashing as Gmail/GitHub).
   - Show email under the name in smaller/muted text (or as a tooltip on hover).
   - At 360px viewport (UX-02 hard requirement), gracefully truncate the email or hide it behind a tap.

2. **DTO surface check**:
   - Verify `toUserDto` in `src/lib/server/dto.ts` includes `image` (Better Auth's column). If currently stripped, expose it — Google avatars are not sensitive.
   - Confirm `+layout.svelte` passes `image` through to `AppHeader`.

3. **Tests**:
   - Extend the existing AppHeader/layout integration test to assert avatar + email render correctly for both `image: null` and `image: 'https://...'` cases.

Out of scope: account-switcher dropdown (would need Better Auth multi-account support — separate phase).

Owner: future phase. Not blocking Phase 2 — UX-02 (360px no-scroll) is satisfied by current AppHeader.
