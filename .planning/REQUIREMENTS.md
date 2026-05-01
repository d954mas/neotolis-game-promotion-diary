# Requirements

**Project:** Neotolis Game Promotion Diary
**Source:** PROJECT.md (locked context) + research/FEATURES.md (P1 selections) + research/ARCHITECTURE.md (build order)
**Last updated:** 2026-04-28 after Phase 2 UAT — added Phase 2.1 Realignment Additions and reframed REQ-IDs touched by the unified `data_sources` + events / 3-view IA model

This document is the v1 contract. Every requirement here is a hypothesis until shipped and validated. The roadmap maps each REQ-ID to exactly one phase.

> **2026-04-28 — Phase 2.1 Architecture Realignment.** Phase 2 UAT surfaced 4 P0 architectural redesigns that change the v1 data model and IA. Per-platform channel tables collapse into a unified `data_sources` registry; `tracked_youtube_videos` collapses into a unified `events` table with an `author_is_me` discriminator; primary navigation becomes a chronological `/feed` over the events table, with `/sources` for source config and `/games/[id]` for the per-game curated view. REQ-IDs touched by this realignment are reframed in-place (terminology aligned with the new model — see notes inline below); 4 new REQ-IDs are added in the "Phase 2.1 Realignment Additions" section. Authoritative narrative lives in PROJECT.md "Architecture" section + ROADMAP Phase 2.1 detail.

---

## v1 Requirements

### Authentication & Identity (AUTH)

- [x] **AUTH-01**: User can sign in to the service with Google OAuth as the only supported login method (no email/password, no GitHub, no in-app TOTP — Google's own 2FA is the security boundary)
- [x] **AUTH-02**: User can sign out from any page; session is invalidated server-side
- [x] **AUTH-03**: First sign-in automatically creates a developer account; existing accounts resume their data on subsequent sign-ins

### Game Catalog (GAMES)

- [x] **GAMES-01**: User can create a game card with title, Steam app URL, optional cover image, optional release date (or "TBA"), tags/genres, and free-form notes
- [x] **GAMES-02**: User can edit and delete their own game cards; deletion is soft and recoverable for a documented retention window before purge
- [x] **GAMES-03**: User can have multiple games per developer account; every other entity (post, video, event, snapshot) is scoped to a specific game
- [x] **GAMES-04a**: User can attach a YouTube data source's content to a game by attaching individual events (events of `kind=youtube_video` with `source_id` set get attached to a game by setting `game_id`); the data source itself is a per-user registry entry, not a per-game association *(reframed Phase 2.1: per-game channel attachment → per-user `data_sources` registry + per-event `game_id` attachment via the `/feed` "Attach to game" picker; see SOURCES-01 / FEED-01 / INBOX-01)*
- [ ] **GAMES-04b**: ~~User can attach Telegram channels per game~~ **superseded** by SOURCES-01 — `data_source.kind=telegram_channel` covers this *(Phase 2.1 schema accepts the kind; functional adapter gated by Phase 5+ trigger)*
- [ ] **GAMES-04c**: ~~User can attach Twitter/X handles per game~~ **superseded** by SOURCES-01 — `data_source.kind=twitter_account` covers this *(Phase 2.1 schema accepts the kind; functional adapter gated by Twitter API affordability — out of scope for v1)*
- [ ] **GAMES-04d**: ~~User can attach an optional Discord invite per game~~ **superseded** by SOURCES-01 — `data_source.kind=discord_server` covers this *(Phase 2.1 schema accepts the kind; functional adapter gated by Phase 5+ trigger)*

### Secrets & Per-User API Keys (KEYS)

- [ ] **KEYS-01**: User can paste a YouTube Data API v3 key into settings; the key is encrypted at rest with envelope encryption (KEK from env, DEK per row) before being persisted
- [ ] **KEYS-02**: User can authorize Reddit via OAuth (per-user, BYO Reddit app credentials) and rotate or revoke at any time
- [x] **KEYS-03**: User can optionally paste a Steam Web API key; the wishlist tracker works without it (manual entry / CSV path remains available)
- [x] **KEYS-04**: After saving, every secret displays as `••••••••XYZW` (last 4 characters only); the plaintext is never returned to the browser
- [x] **KEYS-05**: User can rotate or remove any key; rotation immediately invalidates the previous ciphertext and all in-flight worker jobs reload the new value
- [x] **KEYS-06**: Audit log records every secret add / rotate / remove with timestamp and source IP

### URL Ingestion (INGEST)

- [ ] **INGEST-01**: User can paste a Reddit post URL; the system parses subreddit + post ID, validates with Reddit API, and creates an event of `kind=reddit_post` linked to the chosen game (or to inbox via `game_id=NULL` for later attachment) *(reframed Phase 2.1: tracked item → event)*
- [x] **INGEST-02**: User can paste a YouTube video URL; the system parses video ID, fetches metadata via oEmbed (Phase 2) or YouTube Data API v3 (Phase 3+), and creates an event of `kind=youtube_video` *(reframed Phase 2.1: tracked item → event)*
- [x] **INGEST-03**: System sets `author_is_me=true` on a created `youtube_video` event when the oEmbed `author_url` matches a registered `data_source` of `kind=youtube_channel` (with `is_owned_by_me=true`); user can toggle later from the event detail page *(reframed Phase 2.1: separate `is_own` column → `author_is_me` discriminator on unified events table; the distinction surfaces in every `/feed` filter and chart)*
- [x] **INGEST-04**: System rejects malformed URLs with a clear error and never partially writes an event *(reframed Phase 2.1: tracked item → event)*

### Polling Engine (POLL)

- [ ] **POLL-01**: A scheduler enqueues poll jobs on adaptive tiers — `hot` (item <24h old, 30–60 min cadence), `warm` (item 1–30 days old, 4×/day), `cold` (item >30 days old, 1×/day)
- [ ] **POLL-02**: A worker pool consumes jobs across separate concurrency lanes per tier; cold backlogs cannot starve hot polling
- [ ] **POLL-03**: Workers honor per-user API key rate limits; a 429 / quota-exhausted response defers the job with backoff and surfaces the condition to the user
- [x] **POLL-04**: Each successful poll appends an immutable row to `event_stats_snapshots` (`event_id`, `polled_at`, `metric_key`, `metric_value`); the live `events` row carries only `last_polled_at` and `last_poll_status` *(reframed Phase 2.1: tracked_items + metric_snapshots → events + event_stats_snapshots; same chart-history-is-immutable invariant)*
- [x] **POLL-05**: Each event in `/feed` and on `/games/[id]` displays a polling status badge — "Hot — checked Xm ago" / "Warm — every 6h" / "Cold — daily" / "Stale" (no successful poll in >48h) *(reframed Phase 2.1: per-tracked-item badge → per-event badge in feed and curated views)*
- [ ] **POLL-06**: Workers shut down gracefully on SIGTERM (configurable grace period) so deploys do not lose in-flight jobs

### Wishlist Tracking (WISH)

- [ ] **WISH-01**: User can record a wishlist count for a given date manually (one row per game per day)
- [ ] **WISH-02**: User can upload the Steamworks `Wishlists.csv` export and the system imports daily counts into `wishlist_snapshots`
- [ ] **WISH-03**: If a Steam Web API key is configured, a daily worker job auto-fetches wishlist counts via the Steamworks Wishlist Reporting API
- [ ] **WISH-04**: Wishlist data is rendered as a daily-granularity line chart on the per-game timeline; "last updated Xh ago" is shown honestly

### Visualization (VIZ)

- [x] **VIZ-01**: User can open a per-event detail page for any event with `last_poll_status` non-null and see its full snapshot history (upvotes/comments for `reddit_post`, views for `youtube_video`); chart sources from `event_stats_snapshots`, never from a mutable "current value" field on the event row *(reframed Phase 2.1: per-item → per-event; metric_snapshots → event_stats_snapshots)*
- [ ] **VIZ-02**: User can view a per-game combined timeline that overlays own actions, blogger coverage, and the wishlist line on a single chart with shared time axis
- [ ] **VIZ-03**: User can see annotated wishlist correlation — every promotion event is a vertical marker on the wishlist line; clicking a marker opens a side panel with the event's metrics and a 24h / 7d wishlist delta after that event
- [ ] **VIZ-04**: All charts render legibly under 600px viewport width

### Reddit Rules Cockpit (REDDIT)

- [ ] **REDDIT-01**: User can register a subreddit per game; the system fetches `/r/{sub}/about/rules` via Reddit API and stores raw rule text + short names
- [ ] **REDDIT-02**: User can author structured rules per subreddit — `cooldown_days`, `min_account_age_days`, `min_karma`, `allowed_flairs[]`, `requires_flair`, `megathread_only`, `self_promo_ratio_cap`
- [ ] **REDDIT-03**: System ships a curated seed database of structured rules for the top ~10 indie subreddits (r/IndieDev, r/IndieGaming, r/indiegames, r/playmygame, r/DestroyMyGame, r/godot, r/Unity3D, r/Unity2D, r/unrealengine, r/WebGames); seed values are baseline, user can override per game
- [ ] **REDDIT-04**: For every tracked subreddit per game, system computes and shows "last posted N days ago" countdown
- [ ] **REDDIT-05**: System exposes the structured-rule schema as community-PR-friendly seed files (one source of truth shared by SaaS and self-host installs)

### Free-form Events Timeline (EVENTS)

- [x] **EVENTS-01**: User can create an event with `kind` (free-form `conference` / `talk` / `press` / `other` for non-pollable activity; pollable kinds `youtube_video` / `reddit_post` / `twitter_post` / `telegram_post` / `discord_drop` are created via the paste flow per INGEST-01..04, not free-form), title, `occurred_at` date, optional URL, optional notes; can attach to a game (`game_id`) or leave in inbox (`game_id=NULL`) *(reframed Phase 2.1: free-form events + tracked items collapse into one unified table with a `kind` enum)*
- [x] **EVENTS-02**: Events render in the chronological `/feed` view (primary daily workspace, FEED-01) and on the per-game `/games/[id]` curated view; both are projections over the unified events table *(reframed Phase 2.1: per-game-only timeline → primary `/feed` + per-game projection)*
- [x] **EVENTS-03**: User can edit and delete events; deletes are audit-logged and require a confirm dialog (data-loss UX safety)

### Privacy, Audit, Export (PRIV)

- [x] **PRIV-01**: All data is private to the user_id that owns it; there is no public dashboard, share link, or read-only viewer in v1
- [x] **PRIV-02**: User can view an audit log in the UI showing logins (timestamp + IP + user-agent), key add/rotate/remove, exports, and bulk deletes — paginated, owner-only
- [ ] **PRIV-03**: User can export all of their data as a single JSON file and as CSV-per-table; export is audit-logged
- [ ] **PRIV-04**: User can request account + data deletion; deletion runs as a documented procedure (soft-delete → purge) with audit-log retention only of the deletion event

### Quota Dashboard (QUOTA)

- [x] **QUOTA-01**: For each per-user API key, the user can see today's usage vs. quota — YouTube units used / 10,000, Reddit requests used in the last hour
- [x] **QUOTA-02**: When usage crosses 80% of available quota, the dashboard surfaces a visible warning and pauses non-essential cold polling for that key

### UX Baseline (UX)

- [x] **UX-01**: UI supports dark mode and light mode; honors `prefers-color-scheme` and lets the user override
- [x] **UX-02**: UI is responsive — every screen is usable on a phone viewport (≥360px wide); charts reflow legibly
- [x] **UX-03**: Every empty state shows a copy-paste example of what the user can do next (e.g., "Paste a Reddit post URL like `https://reddit.com/r/IndieDev/...`")
- [x] **UX-04**: All user-facing copy is in English; the codebase carries an i18n structure (locale-aware key lookups) so adding locales later is a content-only change

### Phase 2.1 Realignment Additions (SOURCES, FEED, INBOX)

These REQ-IDs are the new contract pieces introduced by the Phase 2.1 realignment (see banner at top + ROADMAP Phase 2.1 detail). Together with the reframed GAMES-04a / INGEST-02..04 / EVENTS-01..03 / VIZ-01 / POLL-04..05 above, they replace the v1.0 per-platform-channels mental model.

- [x] **SOURCES-01**: User can register data sources of `kind` ∈ {`youtube_channel`, `reddit_account`, `twitter_account`, `telegram_channel`, `discord_server`}; each source carries `is_owned_by_me` (mine vs someone else's I want to track), `auto_import` toggle, `display_name`, `external_url`, and per-platform `metadata` jsonb (e.g. `uploads_playlist_id`). Phase 2.1 ships the UI shell and CRUD for all kinds; only `youtube_channel` is functional end-to-end in 2.1, other kinds gated by their poll adapter phase.
- [x] **SOURCES-02**: User can soft-delete a data source (with retention window, consistent with games + events); rotating display_name is a free-form edit; toggling `auto_import` immediately stops/starts the polling adapter for that source (Phase 3+ when adapters land); audit log records every add / remove / toggle / rotate event.
- [x] **FEED-01**: `/feed` shows all events for the authenticated user sorted by `occurred_at DESC`, paginated via tenant-relative cursor, filterable by URL params (`source`, `kind`, `game`, `attached`, `author_is_me`, `from`, `to`); per-row actions: "Attach to game" picker, "Open detail", "Mark not game-related", "Delete" (with confirm). `/feed` is the default landing page after authenticated login (replaces the dashboard). Renders legibly on 360px viewport with filter chips collapsing to a "Filters (N)" sheet button on mobile.
- [x] **INBOX-01**: Auto-imported events arrive with `game_id=NULL`; user attaches via the `/feed` "Attach to game" picker (sets `game_id`); a "Mark not game-related" toggle sets `metadata->>'inbox_dismissed' = 'true'` so the row drops out of `attached=false` view but stays findable by other filters and is not deleted. The `attached=false` filter is the inbox view; auto-imported events flow into it as the polling adapters (Phase 3+) come online.

### Deployment & Self-Host Parity (DEPLOY)

- [ ] **DEPLOY-01**: The same Docker image runs as SaaS multi-tenant on the canonical aeza VPS and as single-tenant self-host on any Linux machine; only environment variables differ between the two
- [ ] **DEPLOY-02**: Application honors `X-Forwarded-For`, `CF-Connecting-IP`, and `X-Forwarded-Proto` headers when behind a trusted proxy (configurable trusted-proxy CIDR list); audit log records the real client IP, not the proxy
- [ ] **DEPLOY-03**: Application can run behind any of: bare port, nginx, Caddy, Cloudflare Tunnel, with no code change
- [ ] **DEPLOY-04**: Repository ships an MIT license, a self-host README with Docker compose example, an `.env.example` documenting every required variable, and a documented KEK-rotation runbook
- [x] **DEPLOY-05**: CI runs a self-host smoke test on every change — boots the image with a minimal env, signs in via OAuth mock, creates a game, runs a poll, and asserts no SaaS-only assumptions leaked into the codebase

---

## v1.x Deferred (post-launch, trigger-gated)

These are explicitly v1.x — they ship after MVP based on the trigger noted, not on the roadmap.

- **D-02 Pre-post Reddit warning UI** — trigger: at least one user reports averting a near-shadowban via the rules cockpit
- **D-07 First-class blogger coverage entity** (creator table, cross-game view) — trigger: users start asking "which YouTuber drives wishlists across my catalog?"
- **D-10 Promotion-intensity heatmap** — trigger: users hit ~6 months of data and timelines become unreadable
- **D-11 Campaign tag grouping** — trigger: same as D-10
- **D-12 "What's stale" inbox** — trigger: users report missing that some items stopped polling silently
- **D-04 expansion** to ~25+ curated subreddits with community PRs — trigger: organic PR contributions begin

## Out of Scope (v1)

Explicit exclusions with reasoning. These are NOT bugs; they are decisions.

- **Auto-posting to Reddit / YouTube / Telegram** — read-only social posture is the product. Auto-posting tools risk shadowbanning the user's own account, fall under Reddit's Responsible Builder Policy with stricter limits, and create a massive support surface.
- **Public dashboards / shareable game pages** — wishlist + sales data is commercially sensitive; one ACL bug is a category-extinction event. Deferred to v2 share-link model.
- **Steam page scraping (when no API key is provided)** — violates Steam ToS at high frequency and risks IP bans for the SaaS host. Manual entry / CSV import is the honest fallback.
- **Auto-discovery of mentions** ("find all YouTubers/Redditors talking about my game") — burns YouTube quota (`search.list` is 100 units/call) and requires fuzzy matching that produces false positives. Deferred to v2 paid tier.
- **Twitter/X API tracking** — paid API ($100/mo basic) is uneconomical for indie tooling. Twitter posts logged manually as timeline events.
- **Telegram channel auto-tracking** (Bot API or MTProto) — Bot API requires admin access (privacy-invasive); MTProto is fragile and abuse-prone. Manual entries in v1; reconsider in v2.
- **Email / password / GitHub auth** — each method adds attack surface (password reset flows, credential stuffing). Indie devs all have Google accounts (YouTube ties to Google).
- **In-app TOTP / 2FA** — Google OAuth already enforces Google's 2FA. Building parallel 2FA duplicates that stack at zero added security.
- **Public catalog of indie games on the platform** — exposes which devs use the tool plus indirect wishlist-health signals to competitors.
- **Real-time WebSocket wishlist counter** — Steam wishlist data is daily-granularity at best; a real-time number would be theatrically real-time but factually wrong.
- **Built-in AI suggestions for "what to post next"** — LLM API costs per tenant break the free-tier model; hallucination on subreddit rules is exactly the failure mode REDDIT-01..05 prevent.
- **Native mobile app (iOS/Android)** — doubles maintenance, requires app store accounts, breaks the cost story. Responsive web + Add-to-Home-Screen suffices.
- **Public leaderboards / "top promoted indie games this week"** — privacy violation plus actively rewards vanity-metric chasing.
- **Generic project-management features** (kanban, sprint board, todos) — scope creep into a saturated category. Single-purpose tool wins.
- **Per-game custom domains / white-label** — pulls in multi-tenant TLS automation and billing tiers. Self-host is the white-label path.
- **Multi-language UI beyond English in v1** — i18n structure is in place; locales are content additions deferred to post-launch.

## Traceability

Each REQ-ID maps to exactly one phase. Coverage: 54/54 v1 requirements.

| REQ-ID | Phase |
|--------|-------|
| AUTH-01 | Phase 1 |
| AUTH-02 | Phase 1 |
| AUTH-03 | Phase 1 |
| GAMES-01 | Phase 2 |
| GAMES-02 | Phase 2 |
| GAMES-03 | Phase 2 |
| GAMES-04a | Phase 2 (shipped) → reframed Phase 2.1 |
| GAMES-04b | Superseded by SOURCES-01 |
| GAMES-04c | Superseded by SOURCES-01 |
| GAMES-04d | Superseded by SOURCES-01 |
| KEYS-01 | Phase 3 |
| KEYS-02 | Phase 3 |
| KEYS-03 | Phase 2 |
| KEYS-04 | Phase 2 |
| KEYS-05 | Phase 2 |
| KEYS-06 | Phase 2 |
| INGEST-01 | Phase 3 (reframed Phase 2.1) |
| INGEST-02 | Phase 2 (shipped) → reframed Phase 2.1 |
| INGEST-03 | Phase 2 (shipped) → reframed Phase 2.1 |
| INGEST-04 | Phase 2 (shipped) → reframed Phase 2.1 |
| POLL-01 | Phase 3 |
| POLL-02 | Phase 3 |
| POLL-03 | Phase 3 |
| POLL-04 | Phase 3 |
| POLL-05 | Phase 3 |
| POLL-06 | Phase 3 |
| WISH-01 | Phase 3 |
| WISH-02 | Phase 3 |
| WISH-03 | Phase 3 |
| WISH-04 | Phase 4 |
| VIZ-01 | Phase 4 (reframed Phase 2.1: per-event detail; data layer ready in 2.1, chart UI in 4) |
| VIZ-02 | Phase 4 |
| VIZ-03 | Phase 4 |
| VIZ-04 | Phase 4 |
| REDDIT-01 | Phase 5 |
| REDDIT-02 | Phase 5 |
| REDDIT-03 | Phase 5 |
| REDDIT-04 | Phase 5 |
| REDDIT-05 | Phase 5 |
| EVENTS-01 | Phase 2 (shipped) → reframed Phase 2.1 |
| EVENTS-02 | Phase 2 (shipped) → reframed Phase 2.1 |
| EVENTS-03 | Phase 2 (shipped) → reframed Phase 2.1 |
| SOURCES-01 | Phase 2.1 |
| SOURCES-02 | Phase 2.1 |
| FEED-01 | Phase 2.1 |
| INBOX-01 | Phase 2.1 (UI shell + manual attach); Phase 3 (auto-import-fed inbox) |
| PRIV-01 | Phase 1 |
| PRIV-02 | Phase 2 |
| PRIV-03 | Phase 6 |
| PRIV-04 | Phase 6 |
| QUOTA-01 | Phase 6 |
| QUOTA-02 | Phase 6 |
| UX-01 | Phase 2 |
| UX-02 | Phase 2 |
| UX-03 | Phase 2 |
| UX-04 | Phase 1 |
| DEPLOY-01 | Phase 6 |
| DEPLOY-02 | Phase 6 |
| DEPLOY-03 | Phase 6 |
| DEPLOY-04 | Phase 6 |
| DEPLOY-05 | Phase 1 |

### Coverage by Phase

| Phase | Requirement Count | Categories |
|-------|-------------------|------------|
| Phase 1 — Foundation | 6 | AUTH (3), PRIV (1), UX (1), DEPLOY (1) |
| Phase 2 — Ingest, Secrets, Audit | 18 | GAMES (4: GAMES-01..03 + GAMES-04a), KEYS (4: KEYS-03..06), INGEST (3: INGEST-02..04), EVENTS (3), PRIV (1), UX (3) — *7 of these reframed in 2.1; data shipped, model realigned* |
| Phase 2.1 — Architecture Realignment | 4 new (+ reframes 7 existing P2 + 1 P3 + 1 P4) | SOURCES (2), FEED (1), INBOX (1); reframes GAMES-04a, INGEST-02..04, EVENTS-01..03, INGEST-01, VIZ-01 |
| Phase 3 — Polling Pipeline | 12 | POLL (6), WISH (3), KEYS (2: KEYS-01..02), INGEST (1: INGEST-01) |
| Phase 4 — Visualization | 5 | VIZ (4), WISH (1) |
| Phase 5 — Reddit Rules Cockpit | 5 | REDDIT (5) |
| Phase 6 — Trust & Self-Host Polish | 8 | PRIV (2), QUOTA (2), DEPLOY (4) |
| **Total** | **58 v1 + 0 backlog** | *(GAMES-04b/c/d superseded by SOURCES-01; v1 count grows from 54 → 58 via the 4 Phase 2.1 additions)* |

---

*v1 = MVP that beats the Google-Sheets baseline plus ships the two unique differentiators (REDDIT-01..05 + VIZ-03). Without those differentiators, this is "another spreadsheet replacement"; with them, it's the only tool in the market that combines wishlist correlation with Reddit-rules hygiene for indie game devs.*
