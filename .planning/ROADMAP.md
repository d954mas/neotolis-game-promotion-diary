# Roadmap: Neotolis Game Promotion Diary

## Overview

Six phases derived from the architecture's locked 6-tier build order. Phase 1 lays the multi-tenant foundation (auth, envelope encryption, tenant-scope middleware, self-host CI smoke test). Phase 2 ships the spreadsheet replacement end-to-end without polling (games, ingest, secrets, events, audit). Phase 3 turns it into a tracker by landing the polling pipeline (pg-boss, scheduler, workers, YouTube/Reddit/Steam adapters, CSV wishlist import). Phase 4 makes it visible with charts, including the headline annotated wishlist correlation chart. Phase 5 ships the Reddit Rules Cockpit — the primary competitive moat with no equivalent in the indie game dev space. Phase 6 polishes trust and self-host parity (export, quota dashboard, account deletion, KEK-rotation runbook, OSS release). Phases follow strict tier order because Tier 0 chokepoints (tenant scoping, envelope encryption) cannot be retrofitted, Tier 2 (polling) is pitfall-dense and co-dependent, and the differentiators require the full stack.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (1.1, 2.1): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Foundation** - Bootable image with Google OAuth, envelope encryption, tenant scoping, and self-host CI smoke test gating every PR
- [!] **Phase 2: Ingest, Secrets, and Audit** - Games CRUD, paste-URL ingest, write-once API key storage, events timeline, owner-visible audit log *(closed gaps_found 2026-04-28 via UAT — 4 P0 architectural redesigns + 1 P0 functional gap surfaced; closure in Phase 2.1)*
- [ ] **Phase 2.1: Architecture Realignment (INSERTED)** - Unified `data_sources` abstraction + 3-view IA (`/feed` primary nav + `/sources` + `/games/[id]`) + auto-import inbox + unified `events` table with `author_is_me` discriminator; closes the 4 P0 architectural gaps from Phase 2 UAT plus the rename/add-Steam UI gap on `/games/[id]`
- [ ] **Phase 3: Polling Pipeline** - Adaptive hot/warm/cold polling driven by per-kind `DataSourceAdapter`; YouTube + Reddit + Steam concrete adapters; both wishlist ingest paths
- [ ] **Phase 4: Visualization** - Per-event charts, combined per-game timeline, and the annotated wishlist correlation chart with UX baseline
- [ ] **Phase 5: Reddit Rules Cockpit** - Subreddit rules ingestion, structured cooldown/flair fields, curated seed for top ~10 indie subs
- [ ] **Phase 6: Trust and Self-Host Parity Polish** - Export, account deletion, quota dashboard, deploy parity, KEK-rotation runbook, OSS release

## Phase Details

### Phase 1: Foundation
**Goal**: One Docker image boots in three roles (app/worker/scheduler) with Google OAuth working, envelope encryption unit-tested, tenant-scope middleware enforced, and a self-host smoke test gating every change in CI from day one.
**Depends on**: Nothing (first phase)
**Requirements**: AUTH-01, AUTH-02, AUTH-03, PRIV-01, UX-04, DEPLOY-05
**Success Criteria** (what must be TRUE):
  1. User signs in with Google OAuth and lands on an empty dashboard scoped to their own user_id; signing out invalidates the server-side session and re-visiting any protected page redirects to login
  2. A second user signing in for the first time gets a fresh empty dashboard; an existing user signing back in resumes their data — and a cross-tenant integration test in CI proves user A cannot read user B's resources (returns 404, never 403)
  3. Every endpoint refuses anonymous traffic (anonymous-401 integration test passes for every route in CI) and no public dashboard, share-link, or read-only viewer route exists
  4. Self-host CI smoke test passes on every PR: boots the image with minimal env, signs in via OAuth mock, asserts auth happy path + tenant scope holds + all three roles (app/worker/scheduler) dispatch correctly + no SaaS-only assumption leaked (this gate prevents parity rot from day one per PITFALLS P14/P20). *Phase 1 scope per user decision 2026-04-27: the literal "creates a game" clause is deferred to Phase 2 smoke and "runs a poll stub" to Phase 3 smoke.*
  5. The codebase carries an i18n-aware key-lookup structure (Paraglide compiled messages); adding a locale later requires only dropping a JSON file, not a refactor
**Plans**: 10 plans
**Plan list**:
- [x] 01-01-PLAN.md — Bootstrap pinned deps + ESLint/Prettier/tsconfig + zod env + Pino redaction + UUIDv7 helper
- [x] 01-02-PLAN.md — Wave 0 test scaffolding (vitest split, Wave 0 placeholder tests) + Dockerfile + GitHub Actions CI skeleton
- [x] 01-03-PLAN.md — Drizzle pg client + advisory-locked migrate runner + Better Auth schema + audit_log table + pg-boss queue registry
- [x] 01-04-PLAN.md — TDD envelope encryption module (AES-256-GCM, KEK→DEK, kek_version, rotation)
- [x] 01-05-PLAN.md — Better Auth instance (Google OAuth, DB sessions, sign-out-all-devices) + UserDto/SessionDto + oauth2-mock-server lifecycle helpers
- [x] 01-06-PLAN.md — Hono app + trusted-proxy middleware (D-19/D-20 + CVE-2026-27700 mitigation) + /healthz + /readyz + APP_ROLE=app entrypoint + SvelteKit pass-through + minimal pages
- [x] 01-07-PLAN.md — Tenant-scope middleware (404 not 403) + /api/me + anonymous-401 sweep + cross-tenant integration test
- [x] 01-08-PLAN.md — APP_ROLE=worker + APP_ROLE=scheduler entrypoints + pg-boss createBoss/stopBoss with graceful drain
- [x] 01-09-PLAN.md — Paraglide JS 2 wiring + messages/en.json + thread m.* through Svelte pages + locale-add snapshot test
- [x] 01-10-PLAN.md — Self-host smoke test (D-15 six assertions; OAuth dance via oauth2-mock-server; human-verify checkpoint) + finalize VALIDATION.md (completed 2026-04-27)

### Phase 2: Ingest, Secrets, and Audit
**Goal**: Ship a usable end-to-end product without the polling worker. Validate the data model, the secret write path, and the audit story. After this phase the user can do everything they did in their spreadsheet, with encryption and audit on top.
**Depends on**: Phase 1
**Requirements**: GAMES-01, GAMES-02, GAMES-03, GAMES-04a, KEYS-03, KEYS-04, KEYS-05, KEYS-06, INGEST-02, INGEST-03, INGEST-04, EVENTS-01, EVENTS-02, EVENTS-03, PRIV-02, UX-01, UX-02, UX-03 *(KEYS-01, KEYS-02, INGEST-01 moved to Phase 3 per CONTEXT.md DV-1/DV-7; GAMES-04 split into GAMES-04a (P2) + GAMES-04b/c/d (backlog) per DV-8)*
**Success Criteria** (what must be TRUE):
  1. User creates a game card with title, Steam URL, optional cover, optional release date or "TBA", tags/genres, and free-form notes; can attach multiple YouTube channels per game (Telegram channels, Twitter handles, and optional Discord deferred to backlog by trigger per CONTEXT.md DV-8); can soft-delete and recover within the documented retention window
  2. User pastes a YouTube video URL on a game and a tracked item is created (with own/blogger flag, toggleable later); user pastes a Twitter or Telegram URL and a free-form events row is created; user pastes a Reddit URL and sees an inline "Reddit support arrives in Phase 3" message (Reddit ingest moves to Phase 3 alongside poll.reddit per CONTEXT.md DV-7); a malformed URL is rejected with a clear error and never half-writes a row
  3. User saves a Steam Web API key (YouTube API key paste UI and Reddit OAuth flow move to Phase 3 alongside their respective poll adapters per CONTEXT.md DV-1); after save the value is shown only as `••••••••XYZW`, the plaintext is never returned to the browser, the row is envelope-encrypted at rest, and rotation immediately invalidates the previous ciphertext
  4. User creates free-form timeline events (conferences, talks, Twitter/Telegram/Discord posts) with title, date, optional URL/category/notes; edits and deletes are recorded in the audit log
  5. User opens the audit log and sees a paginated, owner-only list of logins (timestamp + IP + user-agent), key add/rotate/remove, and event edit/delete entries — with cursors that are tenant-relative so listing one tenant never observes another's IDs
  6. Every page renders legibly on a 360px-wide phone viewport, honors `prefers-color-scheme` with a user override for dark/light, and every empty state shows a copy-paste example of the next action
  7. *Phase 2 smoke extension (per Phase 1 DEPLOY-05 scope deferral, 2026-04-27):* CI self-host smoke test additionally exercises "user A creates a game" via the new GAMES endpoints; cross-tenant matrix expands from /api/me sentinel to /api/games (read/write/delete returns 404 for cross-tenant access).
**Plans**: 11 plans
**Plan list**:
- [x] 02-01-traceability-and-test-scaffolds-PLAN.md — Wave 0: REQUIREMENTS / ROADMAP / AGENTS.md traceability uplift + 12 placeholder test files
- [x] 02-02-eslint-tenant-scope-rule-PLAN.md — Wave 0: custom ESLint AST rule no-unfiltered-tenant-query (D-38) + RuleTester suite
- [x] 02-03-schema-and-migration-PLAN.md — Wave 0: 7 new tables + audit-log enum + user.theme_preference + RETENTION_DAYS env + one Drizzle migration
- [x] 02-04-games-services-PLAN.md — Wave 1: games + game-steam-listings + youtube-channels services with soft-cascade transactional restore
- [x] 02-05-api-keys-steam-service-PLAN.md — Wave 1: api_keys_steam service with envelope encryption + Steam validateKey + DTO ciphertext-strip
- [x] 02-06-ingest-and-events-services-PLAN.md — Wave 1: URL parser + oEmbed integrations + items-youtube + events services + ingest orchestrator
- [x] 02-07-audit-read-service-PLAN.md — Wave 1: audit-read with cursor pagination + audit append-only behavioural test
- [x] 02-08-routes-and-sweeps-PLAN.md — Wave 2: 8 Hono sub-routers + theme route + anonymous-401 + cross-tenant matrix extensions
- [x] 02-09-theme-components-paraglide-PLAN.md — Wave 3: theme cookie SSR + design tokens + 18 reusable Svelte components + ~30 Paraglide keys
- [x] 02-10-svelte-pages-PLAN.md — Wave 3: 7 SvelteKit pages composing Plan 09 components + cookie-DB theme reconciliation
- [x] 02-11-smoke-360-validation-PLAN.md — Wave 4: smoke gate Phase 2 GAMES-01 extension + Vitest browser 360px + VALIDATION.md sign-off + checkpoint:human-verify (cleared 2026-04-28 via 60min UAT — 20 todos surfaced; phase verdict: gaps_found)
**UI hint**: yes
**Phase 2 closure note (2026-04-28)**: phase verdict `gaps_found`. UAT surfaced 4 P0 architectural redesigns (data_sources unified abstraction / 3-view feed-first IA / auto-import inbox flow / unified events table with author_is_me) plus 1 P0 functional gap (rename + add-Steam UI missing on `/games/[id]`). Closure delegated to Phase 2.1 (INSERTED below); see PROJECT.md "Architecture" section + 4 todos in `.planning/todos/pending/2026-04-28-{data-sources-unified-model,three-views-feed-sources-games,channel-to-inbox-auto-import-flow,rethink-items-vs-events-architecture}.md`.

### Phase 2.1: Architecture Realignment
*INSERTED — gap closure from Phase 2 UAT (2026-04-28)*

**Goal**: Replace per-platform channel tables and the tracked_items / events split with the unified `data_sources` + single `events` table model surfaced during Phase 2 UAT (2026-04-28). Ship the three primary views (`/feed`, `/sources`, `/games/[id]`) so the user has a daily workspace. Close the rename + add-Steam-listing UI gap on `/games/[id]`. Schema migration is destructive but cheap — zero production data (Phase 2 is dev-only).
**Depends on**: Phase 2
**Requirements**: SOURCES-01, SOURCES-02, FEED-01, INBOX-01 (new — see REQUIREMENTS.md "Phase 2.1 Realignment Additions"); reframes GAMES-04a + INGEST-02 + INGEST-03 + EVENTS-01 + EVENTS-02 + VIZ-01 under the unified events / data_sources / `/feed` model
**Success Criteria** (what must be TRUE):
  1. Forward-only Drizzle migration runs on a Phase 2 dev DB: `youtube_channels` → `data_sources` (rename + add columns: `kind` enum [`youtube_channel`, `reddit_account`, `twitter_account`, `telegram_channel`, `discord_server`], `is_owned_by_me` bool, `auto_import` bool, `metadata` jsonb); `tracked_youtube_videos` dropped; `events` extended with `kind` enum, `author_is_me` bool, nullable `source_id` FK to `data_sources`, nullable `game_id`; audit_action enum: `channel.*` → `source.*`, `item.*` folded into `event.*`
  2. Service + route layer: `data_sources` service replaces `youtube-channels` service with kind-aware semantics; `events` service handles all kinds (`youtube_video`, `twitter_post`, `telegram_post`, `discord_drop`, `reddit_post` forward-compat, `conference`, `talk`, `press`, `other`) with `author_is_me` inherited from a matching `data_source` on auto-import or oEmbed `author_url` match on manual paste; HTTP routes under `/api/sources` and `/api/events` (existing `/api/items-youtube` + `/api/youtube-channels` removed)
  3. Three-view UI ships: `/sources` page (data source registry — add/remove, kind picker, auto-import toggle, polling status placeholder); `/feed` page (chronological pool with `kind` / `source` / `game` / `attached` / `author_is_me` / date-range filters as URL params, "Attach to game" picker per row, "Mark not game-related" toggle); `/games/[id]` rebuilt to show events filtered to that game grouped by month plus inline rename UI plus add-Steam-listing UI (closes the P0 functional gap)
  4. Default route after authenticated login: `/` redirects to `/feed`; the dashboard concept is fully retired (was placeholder until Phase 4 LayerChart)
  5. Manual paste path coexists with auto-import: pasting a YouTube URL creates an event with `source_id=NULL`; if oEmbed `author_url` matches a registered `data_source` of `kind=youtube_channel`, `author_is_me` inherits, otherwise defaults to `false`. Phase 2.1 ships only the YouTube-functional path; other kinds accept manual paste but no auto-import (gated by their poll adapter phase)
  6. Cross-tenant + anonymous-401 invariants extend to `/api/sources`, `/api/events`, `/feed` and `/sources` SvelteKit loaders; `eslint-plugin-tenant-scope/no-unfiltered-tenant-query` covers the renamed `data_sources` and the extended `events` table; `MUST_BE_PROTECTED` allowlist gains the new routes
  7. UI polish bundled because cheap to land alongside the rebuild: `/settings` active sessions list, `/keys/steam` empty-state copy fix (no fictitious manual-wishlist mention), event delete confirm dialog, AppHeader avatar+email; theme toggle moved out of AppHeader to `/settings`
  8. Phase 2.1 smoke extension: CI self-host smoke test asserts the unified flow end-to-end — register a YouTube `data_source`, paste a YouTube URL, see the event in `/feed` with `source_id=NULL`, attach to a game, verify it appears in `/games/[id]` curated view; cross-tenant matrix extends to `/api/sources` + `/api/events`
**Plans**: 10 plans
**Plan list**:
- [ ] 02.1-01-PLAN.md — Wave 0: single new baseline migration (Phase 1+2 collapsed) + final 2.1 schema modules + AUDIT_ACTIONS rename + ESLint TENANT_TABLES update
- [x] 02.1-02-PLAN.md — Wave 0: 5 new placeholder test files (data-sources, feed, inbox, events-attach, browser feed-360) with named-plan it.skip per Phase 1+2 Wave 0 pattern
- [x] 02.1-03-PLAN.md — Wave 0: ~53 new Paraglide keys (UI-SPEC Copywriting Contract) + extended keyset snapshot test + DataSourceAdapter interface + youtube_channel STUB
- [ ] 02.1-04-PLAN.md — Wave 1: data_sources service (CRUD + soft-delete + restore + toggle + findSourceByAuthorUrl) + toDataSourceDto + extended toEventDto + Phase 2 youtube-channels deletion
- [ ] 02.1-05-PLAN.md — Wave 1: unified events service (listFeedPage + attachToGame + dismissFromInbox + extended createEvent/createEventFromPaste) + ingest rewrite + items-youtube deletion
- [ ] 02.1-06-PLAN.md — Wave 2: /api/sources router + /api/events extension (feed + attach + dismiss-inbox) + Hono app composition + anonymous-401 + cross-tenant matrix sweeps
- [ ] 02.1-07-PLAN.md — Wave 3: /feed page (default landing) + root redirect + 6 new feed components (FeedRow, AttachToGamePicker, FilterChips, FiltersSheet, InboxBadge, PollingBadge) + KindIcon extension
- [ ] 02.1-08-PLAN.md — Wave 3: /sources + /sources/new + SourceRow + SourceKindIcon + Nav update + /accounts/youtube + ChannelRow deletion
- [ ] 02.1-09-PLAN.md — Wave 3: /games/[id] rebuild (RenameInline + AddSteamListingForm + MonthHeader + curated FeedRows) + /events/new + /events/[id] stub + Settings polish (sessions list, theme blurb, ThemeToggle relocation) + AppHeader UserChip + /keys/steam empty-state copy fix + /events list deletion
- [ ] 02.1-10-PLAN.md — Wave 4: smoke extension (Phase 2.1 unified flow + cross-tenant probes per CONTEXT D-11) + manual UAT checkpoint + VALIDATION.md sign-off
**UI hint**: yes

### Phase 3: Polling Pipeline
**Goal**: Adaptive polling worker pool actually fetches metrics through the per-kind `DataSourceAdapter` interface defined in Phase 2.1. pg-boss queues, scheduler, three concrete adapters (YouTube + Reddit + Steam wishlist), and the two wishlist ingest paths land together because they are co-dependent and pitfall-dense (P4–P9, P11). Snapshots accumulate in `event_stats_snapshots` so Phase 4 has data to chart.
**Depends on**: Phase 2.1
**Requirements**: POLL-01, POLL-02, POLL-03, POLL-04, POLL-05, POLL-06, WISH-01, WISH-02, WISH-03, KEYS-01, KEYS-02, INGEST-01 *(KEYS-01, KEYS-02, INGEST-01 deferred from Phase 2 per CONTEXT.md DV-1/DV-7 — land alongside their respective poll adapters)*
**Spike (gate at phase start, MEDIUM-confidence area)**:
  - One live authenticated `GET /r/IndieDev/about/rules.json` to confirm the JSON schema (raw rule text vs. structured `cooldown_days`/`flair_required` fields). Locks the `subreddit_rules` table shape used downstream in Phase 5.
  - Confirm batched `videos.list` quota math: a single `videos.list?id=v1,v2,...,v50&part=snippet,statistics` call returns 50 videos for 1 quota unit (the 50× saving over per-video calls). Validate against current YouTube Data API v3 documentation and a real call before committing the worker design.
**Success Criteria** (what must be TRUE):
  1. After a user adds a Reddit post or YouTube video event (via manual paste or auto-import from a registered `data_source`), a stats snapshot is recorded within ~30 minutes, and the per-event polling badge in the UI reads "Hot — checked Xm ago"; an event older than 24h reads "Warm — every 6h", older than 30 days reads "Cold — daily", and one with no successful poll in >48h reads "Stale"
  2. A 5,000-event cold backlog never blocks a fresh hot poll: hot, warm, cold, and on-demand "refresh now" each have separate pg-boss queues with their own concurrency caps (4/2/1/2), and a user-triggered refresh executes ahead of scheduled work
  3. When a per-user API key returns 429 / quota-exhausted, the affected job defers with backoff, the condition is surfaced visibly to that user (not silently retried forever), and other users' jobs are unaffected
  4. Every successful poll appends an immutable row to `event_stats_snapshots` (`event_id`, `polled_at`, `metric_key`, `metric_value`); the live `events` row carries only `last_polled_at` and `last_poll_status` — chart history is never mutated, which is what enables the Phase 4 differentiator
  5. The user can record a wishlist count manually for a date, upload a Steamworks `Wishlists.csv` and see daily counts imported, or — if a Steam Web API key is configured — the daily worker auto-fetches the wishlist count without any user action
  6. Operator runs `docker compose up -d` to redeploy and no in-flight poll is lost: workers honor SIGTERM with a configurable grace period (default 60s), pg-boss drains, snapshot inserts are idempotent on `(event_id, polled_at, metric_key)`, and audit log records the shutdown event
  7. *(Deferred from Phase 2)* User saves a YouTube Data API v3 key (envelope-encrypted at rest); the key is consumed by the `youtube_channel` adapter. User authorizes Reddit via OAuth (per-user, BYO Reddit app credentials) and rotates / revokes at any time; the credentials are consumed by the `reddit_account` adapter.
  8. *(Deferred from Phase 2)* User pastes a Reddit post URL on a game and an event of `kind=reddit_post` is created; ingest validates against Reddit API; on success the event enters the polling pipeline alongside YouTube videos via the same generic worker loop.
  9. **Auto-import via DataSourceAdapter** *(promoted from Phase 2.1 todo):* When a `data_source` of `kind=youtube_channel` has `auto_import=true`, the `youtube_channel` adapter polls `playlistItems.list` against the channel's uploads playlist and inserts new events with `source_id` set + `game_id=NULL` (inbox); user attaches via the `/feed` "Attach" picker. Quota math validated against the spike (1 unit per 50-video page).
  10. *Phase 3 smoke extension (per Phase 1 DEPLOY-05 scope deferral, 2026-04-27):* CI self-host smoke test additionally enqueues and processes a poll-stub job end-to-end, asserting `event_stats_snapshots` records an immutable row and the worker drains on SIGTERM.

**Phase 3 deferred items (filed by Plan 02-03 W-4):**
  - TODO: add partial index `idx_events_last_polled_at` `WHERE last_polled_at IS NOT NULL` on `events`. Deferred from Phase 2.1 because the unified events table inserts NULL on every row until the polling worker lands — the index would be bloat over an all-NULL column. Add it in the migration that lands the first `DataSourceAdapter` worker. Use raw SQL in a companion migration if Drizzle 0.45's `.where(sql\`...\`)` on `index()` does not emit cleanly for the locked version. *(Originally filed against `tracked_youtube_videos.last_polled_at`; rebased onto `events.last_polled_at` after Phase 2.1 unification.)*

**Plans**: TBD

### Phase 4: Visualization
**Goal**: Turn the time-series data from Phase 3 into the actual product. Without charts the data is invisible. The annotated wishlist correlation chart (D-03 / VIZ-03) is the headline screenshot — it must read clearly on the first try.
**Depends on**: Phase 3
**Requirements**: VIZ-01, VIZ-02, VIZ-03, VIZ-04, WISH-04
**Spike note**: Monitor LayerChart 2.x Svelte 5 stability at phase start; fallback to Apache ECharts via svelte-echarts is documented in STACK.md and ready with no rework.
**Success Criteria** (what must be TRUE):
  1. User opens any event's detail page (reachable from a `/feed` row click or a `/games/[id]` curated row) and sees its full polling history rendered as a line chart — upvotes and comments over time for a `reddit_post`, view count over time for a `youtube_video` — sourced from `event_stats_snapshots`, never from a mutable "current value" field
  2. User opens a per-game timeline and sees own actions, blogger coverage, and the daily-granularity wishlist line overlaid on a single shared time axis with an honest "last updated Xh ago" caption on the wishlist
  3. User sees the annotated wishlist correlation chart: every promotion event is a vertical marker on the wishlist line; clicking a marker opens a side panel with that event's metrics and a 24h / 7d wishlist delta computed from the snapshot history after the event — answering "did this post move the needle?"
  4. Every chart on every page reflows legibly under a 600px viewport width — markers stay tappable, labels do not overlap, and the user can read the differentiator chart on a phone
  5. `/feed` rows for events with stats history surface a sparkline preview inline (e.g., "47 wishlist adds in following 7 days" computed from snapshot deltas) so the daily workspace is informative, not just chronological
**Plans**: TBD
**UI hint**: yes

### Phase 5: Reddit Rules Cockpit
**Goal**: Ship the primary competitive moat — D-01..D-04. Every other phase is "good indie spreadsheet replacement"; this phase is "the only tool in the market that combines wishlist correlation with Reddit-rules hygiene." Lands late because it requires the full stack to be working.
**Depends on**: Phase 4
**Requirements**: REDDIT-01, REDDIT-02, REDDIT-03, REDDIT-04, REDDIT-05
**Success Criteria** (what must be TRUE):
  1. User registers a subreddit on a game (subreddit registration is a separate concept from a `data_source` of `kind=reddit_account` — subreddits are *targets* the user posts *to*, accounts are *identities* the user posts *from*) and the system fetches `/r/{sub}/about/rules` via Reddit API on attach, storing raw rule text and short names; if the API call fails, a clear "rules pending" badge surfaces in the UI rather than a silent empty state
  2. User can author and edit structured rules per subreddit (`cooldown_days`, `min_account_age_days`, `min_karma`, `allowed_flairs[]`, `requires_flair`, `megathread_only`, `self_promo_ratio_cap`); per-game overrides are stored separately from the shared rule cache so rotating a global default never wipes a user's customization
  3. From first install, the user sees curated structured rules for the top ~10 indie subreddits (r/IndieDev, r/IndieGaming, r/indiegames, r/playmygame, r/DestroyMyGame, r/godot, r/Unity3D, r/Unity2D, r/unrealengine, r/WebGames) — the product is useful before the user enters any data
  4. For every subreddit attached to a game, the cockpit displays an accurate "last posted N days ago" countdown computed from that user's `events` of `kind=reddit_post` in that subreddit (filtered by the `metadata->>'subreddit'` jsonb field set at ingest time)
  5. The structured-rule schema lives in a community-PR-friendly seed file shared identically by SaaS and self-host installs, so a self-host operator and the canonical SaaS instance receive the same updates from a community PR
**Plans**: TBD
**UI hint**: yes

### Phase 6: Trust and Self-Host Parity Polish
**Goal**: Convert "interesting tool" into "I am switching off the spreadsheet." Export, account deletion, quota dashboard, deploy parity polish, and a rehearsed disaster-recovery runbook are individually small but together signal honesty. Self-host parity (DEPLOY-01..04) is finalized here as the cross-cutting concern that has been preserved phase-by-phase via the Phase 1 CI gate.
**Depends on**: Phase 5
**Requirements**: PRIV-03, PRIV-04, QUOTA-01, QUOTA-02, DEPLOY-01, DEPLOY-02, DEPLOY-03, DEPLOY-04
**Success Criteria** (what must be TRUE):
  1. User exports all of their data as a single JSON file and as CSV-per-table from the UI; the export is audit-logged, the export schema explicitly excludes the `secrets` table (snapshot-tested), and a re-import path is documented even if not yet implemented — anti-lock-in trust is visible
  2. User requests account and data deletion and sees the documented two-stage procedure execute (soft-delete → purge after retention window); after purge, only the deletion event itself remains in the audit log; the procedure is reversible during the soft-delete window
  3. For each per-user API key, the user sees today's usage versus quota in a dashboard — YouTube units used / 10,000, Reddit requests used in the last hour; at 80% of any quota a visible warning appears and non-essential cold polling for that key automatically pauses until the next reset
  4. The same Docker image runs identically as SaaS multi-tenant on the canonical aeza VPS and as single-tenant self-host on any Linux machine — only environment variables differ. The application correctly resolves the real client IP behind any of: bare port, nginx, Caddy, or Cloudflare Tunnel, honoring `X-Forwarded-For`, `CF-Connecting-IP`, and `X-Forwarded-Proto` against a configurable trusted-proxy CIDR list
  5. The repository ships an MIT LICENSE, a self-host README with a working Docker compose example, an `.env.example` documenting every required variable, a `THIRD_PARTY_LICENSES.md` generated from `npm ls --prod` with CI failing on AGPL-3.0 in production deps, and a KEK-rotation runbook that has been **rehearsed** against a staging dataset (not just written) — the disaster-recovery procedure is real, not aspirational (per PITFALLS P20)
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 2.1 → 3 → 4 → 5 → 6

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 10/10 | Complete | 2026-04-27 |
| 2. Ingest, Secrets, and Audit | 11/11 | Gaps Found | 2026-04-28 (closure in 2.1) |
| 2.1. Architecture Realignment (INSERTED) | 0/10 | Not started | - |
| 3. Polling Pipeline | 0/TBD | Not started | - |
| 4. Visualization | 0/TBD | Not started | - |
| 5. Reddit Rules Cockpit | 0/TBD | Not started | - |
| 6. Trust and Self-Host Parity Polish | 0/TBD | Not started | - |
