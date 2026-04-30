---
created: 2026-04-28T06:05:00.000Z
title: /settings missing active sessions list (security UX gap)
area: ui
files:
  - src/routes/settings/+page.svelte (no sessions UI)
  - src/lib/server/services/me.ts (no listMySessions)
  - src/lib/server/http/routes/sessions.ts (only POST /me/sessions/all — no GET)
  - src/lib/server/db/schema/auth.ts (session table has ipAddress, userAgent, expiresAt — all displayable)
---

## Problem

During Phase 2 manual UAT (2026-04-28), the user said: **"И в настройках. Мы можем показывать все текущие активные логины? а то непонятно"**

Current /settings shows:
- Theme toggle
- Account name + email
- Two buttons: "Sign out" (current session) + "Sign out all devices" (nuclear)
- Retention badge

The "Sign out all devices" button is destructive but doesn't show **what** you'd be signing out from. The user has no visibility into:
- How many active sessions exist
- From which devices/browsers
- From which IPs (geolocation hint)
- When each session was last active

This is **standard security UX**: every modern app (Google, GitHub, Discord, Slack) shows an active sessions list with per-session revoke. Without it the user can't tell if their account was compromised from a different device.

## Solution

Both backend and frontend need additions.

**Backend (Phase 2.1):**
- Add `listMySessions(userId): Promise<SessionRow[]>` to `src/lib/server/services/me.ts`. Better Auth's `session` table is already in the schema with `ipAddress`, `userAgent`, `expiresAt`, `createdAt`, `updatedAt`.
- Add GET `/api/me/sessions` route in `src/lib/server/http/routes/sessions.ts` returning DTO-projected list (strip `token` — it's the session secret; expose only `id`, `ipAddress`, `userAgent`, `createdAt`, `updatedAt`, `expiresAt`, `isCurrent: boolean`).
- Add `toSessionListDto` to `src/lib/server/dto.ts`.
- Add DELETE `/api/me/sessions/:sessionId` route to revoke one session (and corresponding `revokeMySession(userId, sessionId)` service that asserts the session belongs to the user — cross-tenant 404 invariant).
- Audit log: new actions `session.revoked` (one) + existing `session.signout_all` (already there).

**Frontend (Phase 2.1):**
- New "Active sessions" block in /settings showing each session as a row:
  - Device/browser inferred from User-Agent (use lightweight UA parser or just show truncated UA)
  - IP address
  - "Current" badge on the session matching the request
  - "Last active" timestamp (use `updatedAt`)
  - "Revoke" button with `<ConfirmDialog>` (irreversible)
- Render before "Sign out all devices" — gives the user the inventory before the nuclear button.

**i18n keys** (~6 new):
- `settings_sessions_heading`: "Active sessions"
- `settings_sessions_current`: "Current session"
- `settings_sessions_revoke`: "Revoke"
- `confirm_session_revoke`: "Sign out from {device}? You'll need to sign in again on that device."
- `settings_sessions_last_active`: "Last active {when}"
- `settings_sessions_unknown_device`: "Unknown device"

**Tests:**
- Integration: GET /api/me/sessions returns only the caller's sessions (cross-tenant 404 on revoke of someone else's session)
- Integration: revoking a session removes it from list + the next request from that session gets 401
- Settings page integration test: assert sessions block renders for authenticated user

## Severity

**P1** — security-relevant UX gap. Users can't audit their own login surface. Bundle into Phase 2.1.

Owner: Phase 2.1 gap closure.
