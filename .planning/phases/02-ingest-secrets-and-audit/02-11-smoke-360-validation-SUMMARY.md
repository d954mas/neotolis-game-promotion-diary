---
phase: 02-ingest-secrets-and-audit
plan: 11
status: complete-with-checkpoint-cleared
checkpoint: human-verify (cleared 2026-04-28T07:30Z by d954mas via manual UAT)
---

# Plan 02-11 — smoke + 360 + validation SUMMARY

## Outcome

3 of 4 tasks committed atomically; Task 4 (`checkpoint:human-verify`) cleared via 60+ minute live manual UAT against a locally-built production bundle running on http://localhost:3000.

## Commits (Tasks 1-3)

- `210a734` — feat(02-11): extend self-host smoke with Phase 2 GAMES-01 + cross-tenant + anon-401 sweep (5 P2.x assertions appended after the 6 D-15 invariants; oauth-mock-driver reused)
- `5ca700f` — feat(02-11): Vitest 4 browser project + UX-02 360px viewport gate (`@vitest/browser` + `@vitest/browser-playwright` + `playwright` devDeps; CI `browser-tests` job)
- `6eb8a32` — docs(02-11): finalize 02-VALIDATION.md (25-row per-task verification map, sign-off ticked)

Local verification on dev workstation: `tsc --noEmit`, `eslint .`, `pnpm typecheck`, `pnpm test:unit` all green; smoke + browser-tests gated locally on Postgres/Docker/Chromium availability — exercise on CI on push.

## Task 4 — manual UAT (clearance evidence)

**UAT setup (executed inline by orchestrator):**
- Generated dev `.env` with random `BETTER_AUTH_SECRET` + `APP_KEK_BASE64`
- Started Postgres 16 container (`neotolis-pg-dev`, port 5432 published to host)
- Applied Phase 2 migrations via `npx drizzle-kit migrate` (12 tables present: 5 Better Auth + 7 Phase 2)
- Started `oauth2-mock-server` programmatically via `dev-mock-oauth.mjs` (sub=`dev-user-001`, email=`dev@neotolis.local`) — CLI variant didn't inject email and Better Auth tripped `email_is_missing`
- Built production bundle (`pnpm build`) and ran `node build/server.js` on port 3000
- d954mas browsed all 7 Phase 2 pages at 360×640 viewport via Chrome DevTools device toolbar

**UAT participant:** d954mas (project owner)

**Pages exercised:** `/`, `/games`, `/games/[gameId]`, `/events`, `/audit`, `/accounts/youtube`, `/keys/steam`, `/settings`

## Post-execution P0 fix landed in this branch (8 additional commits)

During UAT, a critical production bug surfaced: every `+page.server.ts` loader using `event.fetch('/api/...')` failed with `TypeError: fetch failed` because SvelteKit's `internal_fetch` cannot dispatch to Hono-owned `/api/*` routes (those routes don't live in SvelteKit's route tree), and the fallback network fetch from inside the same Node process failed.

**Fix (10 commits, all in this branch):**
- `aa27768` — fix(02-10): replace event.fetch with direct service call in /keys/steam loader
- `2fae7d8` — fix(02-10): replace event.fetch with direct service call in /accounts/youtube loader
- `ff1fac7` — fix(02-10): replace event.fetch with direct service calls in /games loader
- `d2a8607` — fix(02-10): replace event.fetch with direct service calls in /games/[gameId] loader
- `9694d35` — fix(02-10): replace event.fetch with direct service calls in /events loader
- `e95e172` — fix(02-10): replace event.fetch with direct service call in /audit loader
- `c5468a4` — fix(02-10): narrow EnrichedEvent type with Omit so occurredAt: string compiles
- `326bcb5` — docs(02-10): document post-execution P0 fix
- `ddf37b0` — fix(02-10): widen +page.svelte local date types to Date | string
- `5b0cbc5` — docs(02-10): note +page.svelte type widening in post-execution P0 fix log

Documented in `02-10-svelte-pages-SUMMARY.md` "## Post-execution P0 fix" section.

After the fix: server rebuilt + restarted, all loaders working in production mode against Postgres + mock OAuth.

## UAT findings — surfaced to .planning/todos/pending/

20 todo files captured during the UAT session (commits `7f908ee` through `97ed8af`). Categorized:

### P0 STRATEGIC (architectural redesigns — surfaced through user dialogue)
1. `2026-04-28-rethink-items-vs-events-architecture` — unify `tracked_youtube_videos` + `events` into single `events` table with `author_is_me` discriminator
2. `2026-04-28-data-sources-unified-model` — rename "channels" → "data sources", generalize across YouTube/Reddit/Twitter/Telegram/Discord
3. `2026-04-28-channel-to-inbox-auto-import-flow` — own data source → auto-import all content → user attaches to games (replaces manual paste-only flow)
4. `2026-04-28-three-views-feed-sources-games` — primary IA: `/sources` (config) / `/feed` (chronological pool, primary nav) / `/games/[id]` (curated)

### P0 GAP (functional Phase 2 gaps that block primary use)
5. `2026-04-28-game-detail-missing-rename-and-add-steam` — `/games/[id]` has no rename UI + no Steam-listing-attach UI (backend ready, UI not composed)

### P1 (UX improvements with significant impact)
6. `2026-04-28-audit-ux-improvements` — `/audit` needs grouped checkbox filters + table headers
7. `2026-04-28-settings-active-sessions-list` — security UX gap: no active-sessions inventory
8. `2026-04-28-keys-empty-state-promises-vaporware` — `/keys/steam` empty state mentions features that don't exist
9. `2026-04-28-events-page-layout-and-filter` — `/events` inline game tag + per-game filter
10. `2026-04-28-event-delete-needs-confirm` — event delete needs ConfirmDialog (data-loss UX risk)
11. `2026-04-28-youtube-channels-ux-gaps` — `/accounts/youtube` missing channel delete + own/not-own explainer
12. `2026-04-28-tracked-items-vs-events-unclear` — panels need helper text (becomes moot after #1 unification)

### P2 (polish)
13. `2026-04-28-show-user-avatar-and-email-in-ui` — AppHeader account disambiguation
14. `2026-04-28-simplify-theme-toggle-in-header` — move ThemeToggle out of header
15. `2026-04-28-dashboard-first-step-cta` — dashboard "first step" CTA
16. `2026-04-28-redirect-dashboard-to-games` — `/` → `/games` redirect (becomes `/feed` per #4)
17. `2026-04-28-games-empty-state-misleading` — `/games` empty state says "paste URL" but create flow is title-only

### Phase 4 (existing roadmap fits)
18. `2026-04-28-event-detail-page` — `/events/[id]` detail page (folds into #4 + Phase 4)
19. `2026-04-28-phase4-video-detail-cards-with-charts` — internal video detail with view-count chart

### NEW MILESTONE
20. `2026-04-28-attachments-feature-new-milestone` — file attachments (presskits, conf photos) — needs storage backend, ~4-6 phases of work

## Verdict

**Phase 2 Plan 02-11 itself: complete.** Smoke + browser tests + VALIDATION.md shipped as planned. Checkpoint cleared via UAT.

**Phase 2 as a whole: gaps_found.** UAT surfaced both functional gaps (rename + Steam UI missing) and architectural deficits that the user crystallized through hands-on use. The gsd-verifier should classify Phase 2 as `gaps_found`. Phase 2.1 gap-closure planning needs to integrate the architectural redesigns (todos 1-4) — this is bigger than mechanical gap fixes; PROJECT.md and ROADMAP need updates first.

**Recommended next steps (after `/clear`):**
1. Update `.planning/PROJECT.md` to reflect data_sources + 3-view IA + attachments milestone
2. Re-evaluate `.planning/ROADMAP.md` Phase 3-6 against the data_source adapter pattern
3. Plan Phase 2.1 with full scope (architectural redesigns + functional gaps + UX polish)
