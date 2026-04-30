# Neotolis Game Promotion Diary

## What This Is

A self-tracking diary for indie game developers to log promotion activity across multiple platforms (YouTube, Reddit, Telegram, Twitter, Discord, conferences, press) and watch how it moves wishlists and engagement over time. The user registers data sources (their channels and accounts), the service auto-imports content from them, and stats accumulate so charts surface what actually moved the needle. Manual paste of one-off URLs remains a first-class fallback. Multi-tenant SaaS hosted by the author plus open-source code so anyone can self-host their own instance.

## Core Value

Replace messy Google Sheets / markdown files with a structured, secure, query-friendly diary so an indie developer can see — in one chronological feed across all their promotion channels — which actions actually moved the needle on wishlists and engagement.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Google OAuth login (the only auth method in MVP)
- [ ] Multiple games per developer account (game cards with title, Steam URL, cover, release date, tags/genres, free-form comments)
- [ ] Unified `data_sources` abstraction (YouTube channels, Reddit accounts, Telegram channels, Twitter accounts, Discord servers — one table, one per-kind adapter pattern); each source is owned-by-me or someone-else's; supports auto-import on/off
- [ ] Three primary views over the same events data:
      - `/feed` — chronological pool of all events with filters (kind, source, game, attached, author), primary daily workspace and default landing page
      - `/sources` — data source registry (add/remove sources, toggle auto-import, polling status)
      - `/games/[id]` — per-game curated view (events filtered to that game), grouped by month
- [ ] Auto-import flow: registered data_source → polling worker pulls content → events appear in feed with `game_id = NULL` ("inbox") → user attaches each event to a game (or marks not-game-related)
- [ ] Manual paste path (first-class fallback): user pastes any supported URL → service calls oEmbed/equivalent → creates event with `source_id = NULL`; if URL author matches a registered data_source, `author_is_me` is inherited
- [ ] Unified `events` table with `kind` enum + `author_is_me` discriminator + nullable `game_id` (inbox) + nullable `source_id` (manual paste); replaces the Phase 2 `tracked_youtube_videos` / `events` split
- [ ] Per-user encrypted API key storage (YouTube Data API, Reddit OAuth, optional Steam Web API key)
- [ ] Reddit subreddit rules: pull rules text via API + let user define structured rules per popular subreddit (cooldown, allowed flairs, self-promo limits) and warn before posting
- [ ] Wishlist tracking: optional Steam Web API key auto-pull OR manual entry / CSV import from Steamworks dashboard
- [ ] Adaptive polling worker: new content polled hourly (or every 30 min) for first 24h, then 4×/day, items >30 days old → 1×/day; one generic loop driven by per-kind `DataSourceAdapter`
- [ ] Background job queue + scheduler architecture (cron-like enqueue, worker pool consumes)
- [ ] Per-game timeline view combining own actions, blogger coverage, and wishlist line on a single chart
- [ ] Per-event detail views: stats over time (YouTube views, Reddit upvotes/comments, etc.) sourced from immutable snapshot history
- [ ] Privacy: data is private to its owner — no public dashboards, no sharing in MVP
- [ ] User-visible audit log (logins, IPs, key add/remove, source add/remove, event edit/delete, exports)
- [ ] Envelope encryption for stored secrets (KEK in env, DEK per row); write-once secret UI (show last 4 chars only)
- [ ] English-only UI (i18n-ready structure but only `en` shipped)
- [ ] Open-source repo with MIT license + self-host docs (Docker compose + env-var config)
- [ ] Deployable to a small VPS (aeza) behind Cloudflare Free tier (TLS, DDoS, WAF) with optional Cloudflare Tunnel for hidden origin
- [ ] Trusted-proxy header handling (`X-Forwarded-For`, `CF-Connecting-IP`, `X-Forwarded-Proto`) so audit logs and rate-limits work behind any reverse proxy

### Out of Scope

- **Scheduling/auto-posting to social platforms** — service is read-only on social platforms; user posts manually, service tracks the result
- **Public catalog of indie games / public dashboards** — privacy-only model; sharing deferred to v2
- **Twitter/X API tracking** — paid API ($100/mo), too costly for indie. The schema accepts `twitter_account` as a `data_source` kind, but the polling adapter is deferred until Twitter API is affordable; manual paste of Twitter URLs works in v1
- **Telegram / Discord polling adapters** — schema accepts `telegram_channel` and `discord_server` as `data_source` kinds, but the adapters land in Phase 5+ by trigger (see ROADMAP). Manual paste of Telegram/Discord URLs works in v1
- **Auto-discovery of mentions** ("system finds my game on YouTube/Reddit") — explicitly v2; v1 requires the user to register a data source or paste a URL
- **Email/password and GitHub auth** — only Google OAuth in MVP to reduce attack surface
- **Service-level TOTP / 2FA** — relies on Google's 2FA; no in-app TOTP in MVP
- **Public/shared reports for investors/colleagues** — deferred to v2 (share-link model)
- **Multi-language UI** — English only in MVP; i18n structure ready, locales added later
- **File attachments (presskits, conference photos, screenshots)** — needs storage backend (R2 / local FS / S3-compat adapter) + upload UI + signed-URL download + per-tenant quota; deferred to v1.1 milestone, see todo `2026-04-28-attachments-feature-new-milestone`
- **Steamworks Partner API in self-host setup notes** — supported but explicitly the user's responsibility to obtain and rotate keys

## Context

- **Author profile**: indie developer, technical (asks about workers/queues/quotas/encryption), Russian-speaking, on a tight budget — cost-sensitivity drives every infra choice toward free tiers.
- **Trigger**: author currently tracks promotion activity in Google Sheets / markdown files; this is brittle, hard to query, and doesn't surface "what worked".
- **Domain**: Steam wishlists are the dominant proxy for an indie game's pre-launch health; Reddit and YouTube are the highest-leverage promotion channels for indies in 2025.
- **Reddit nuance**: every subreddit has its own rules (cooldowns, allowed flairs, self-promo caps); accidentally violating them risks shadowbans, which destroys promotion runway. Surfacing rules in-app prevents this.
- **Distribution model**: author hosts the canonical SaaS instance on aeza VPS; code is MIT-licensed so security-conscious devs can self-host. Code must run identically in both modes.
- **API quotas — why per-user keys matter**: YouTube Data API quota is per Google Cloud project (10k units/day); Reddit API is per OAuth app. Pooling under one app key fails at scale. Each user supplies their own keys → quotas distribute, attack surface shrinks, blast radius of a leaked server is bounded.
- **Steam Web API key risk**: it's per-publisher (one key per Steamworks account, not per game), grants read access to wishlist + sales data but cannot deploy builds or change store pages (those need a separate Steamworks login). Users can rotate the key in Steamworks at any time, which fully invalidates the leaked one — this is the primary mitigation.
- **Design workflow**: author wants to use the design.md workflow (Google Stitch generates UI → exported as `design.md` spec → Claude Code implements). This shapes the UI phase but not earlier phases.
- **Model evolved during Phase 2 UAT (2026-04-28)**: hands-on use surfaced four P0 architectural redesigns — `data_sources` unified abstraction (replaces per-platform channel tables), `/feed` chronological pool as primary navigation, auto-import inbox flow (own source → events with null `game_id` → user attaches), and unified `events` table with `author_is_me` discriminator (replaces `tracked_youtube_videos` + `events` split). Codified in todos `2026-04-28-data-sources-unified-model`, `-three-views-feed-sources-games`, `-channel-to-inbox-auto-import-flow`, `-rethink-items-vs-events-architecture`. Phase 2.1 lands the schema + UI shell; Phase 3+ extend adapters and polling.

## Constraints

- **Auth**: Google OAuth only — no email/password, no GitHub. Reduces auth attack surface.
- **Privacy**: private-by-default. No public dashboards in MVP. All data scoped to `user_id`.
- **Security — at-rest secrets**: API keys must be envelope-encrypted (KEK from env, DEK per row), write-once in UI (show only last 4 chars after save), never logged, never returned in API responses.
- **Security — transport**: TLS 1.3 + HSTS via Cloudflare. No raw HTTP in production.
- **Budget**: indie/zero-budget. Every infra component must work on free tier (Cloudflare Free, small aeza VPS, no paid SaaS dependencies for critical path).
- **Tech stack**: deferred to research phase — author trusts the researcher to pick the standard 2025 stack for this kind of multi-tenant SaaS. Required: Docker-deployable to a Linux VPS, Postgres-compatible storage acceptable, must support a background worker pool.
- **Hosting**: aeza VPS as primary, Cloudflare Free tier (with optional Tunnel for hidden origin) as edge.
- **License**: MIT.
- **Languages**: English-only UI in MVP; code must be i18n-structured.
- **Open-source compatibility**: must run identically in SaaS multi-tenant mode and self-host single-tenant mode. Trusted-proxy headers must be honored so the service works behind any of: bare port, nginx, Caddy, Cloudflare Tunnel.
- **Polling cadence**: adaptive (hot/warm/cold) to stay inside YouTube and Reddit quotas with comfortable headroom.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| SaaS + open-source self-host (single multi-tenant codebase) | Author hosts canonical instance; security-conscious devs self-host. One codebase serves both. | — Pending |
| Per-user API keys (YouTube/Reddit/Steam), encrypted at rest | Distributes quotas, bounds blast radius of a leaked server, makes self-host trivial. | — Pending |
| Steam Web API key is optional (manual/CSV fallback) | Lets risk-averse devs use the service without exposing a high-privilege key. | — Pending |
| Hybrid ingestion: user pastes URL → service auto-fetches metrics over time | Matches author's mental model ("I add a thing, system tracks it"); avoids ToS-risky scraping/auto-discovery. | — Pending |
| Reddit rules: API-pulled text + user-curated structured rules per popular subreddit | API exposes raw rules; structured cooldown/flair fields require manual curation. Hybrid is the only honest model. | — Pending |
| Adaptive polling (hot/warm/cold tiers) | Matches API quota envelope; spends polling budget where data is actually changing. | — Pending |
| Google OAuth as the only auth method in MVP | Smallest auth attack surface; offloads 2FA to Google; no password reset flows to build. | — Pending |
| Privacy-only (no public dashboards in MVP) | Promotion data is sensitive (financials via Steam); shareable views deferred to v2. | — Pending |
| MIT license | Permissive, standard for indie tools, encourages self-host adoption. | — Pending |
| English-only MVP, i18n structure ready | Indie scene is global; English maximizes reach; structure ready when contributors add locales. | — Pending |
| Cloudflare Free + optional Tunnel | Free tier covers TLS/DDoS/WAF + Tunnel hides origin. Zero recurring infra cost. | — Pending |
| Envelope encryption (KEK in env, DEK per row) for secrets | A leaked DB without server env doesn't disclose secrets. | — Pending |
| Stack choice deferred to researcher | Author has no strong preference; standard 2025 multi-tenant SaaS stack will surface from research. | — Pending |
| Design via design.md workflow (Google Stitch + Claude Code) | Author wants to try this handoff style for UI phases. | — Pending |
| Unified `data_sources` abstraction (one table, per-kind adapter) replaces per-platform channel tables | Future-proofs schema (new platform = new enum value + adapter, no migration); matches user mental model ("content sources I want to measure in one place"); enables one generic polling worker instead of N hand-coded ones. Surfaced 2026-04-28 during Phase 2 UAT. | — Pending Phase 2.1 |
| Three-view IA: `/feed` (primary nav, chronological pool) + `/sources` (config) + `/games/[id]` (curated) | Promotion-tracking is "what happened across my channels today" — feed-first matches the daily workflow; per-game view is the curated output of attaching events to games in feed. Surfaced 2026-04-28 during Phase 2 UAT. | — Pending Phase 2.1 |
| Auto-import flow: own data_source → events with `game_id=NULL` (inbox) → user attaches to games | Without auto-import, registering a source has no point ("иначе смысла как будто бы и нет" — user verbatim 2026-04-28). Manual paste remains first-class via nullable `source_id`. | — Pending Phase 2.1 (schema + UI shell), Phase 3 (polling) |
| Unified `events` table with `author_is_me` discriminator (replaces `tracked_youtube_videos` + `events` split) | "Author = me vs blogger" is the user's natural division; "pollable vs not" is a technical attribute of `kind`, not a data-model split. Cheapest moment to migrate is now (zero production data). Surfaced 2026-04-28 during Phase 2 UAT. | — Pending Phase 2.1 |

## Architecture

Core data abstractions (post-Phase-2.1):

- **`games`** — per-tenant game cards. Identity unit for the per-game curated view.
- **`data_sources`** — per-tenant registry of where content comes from. One row per (user, source) — kind enum (`youtube_channel`, `reddit_account`, `twitter_account`, `telegram_channel`, `discord_server`, forward-compat extensions). Carries `is_owned_by_me` (mine vs someone else's), `auto_import` (pull content automatically vs passive registration only), per-platform `metadata` jsonb (e.g. `uploads_playlist_id`, `last_polled_at`). Stats columns and time-series live elsewhere — this table is identity + config.
- **`events`** — single timeline table. Every promotion artifact is an event regardless of platform: `kind` (per-platform enum), `author_is_me` (the user's natural discriminator), nullable `source_id` (NULL when manually pasted), nullable `game_id` (NULL when in inbox awaiting attachment), `occurred_at`, `url`, `title`, per-kind `metadata` jsonb. Replaces the Phase 2 `tracked_youtube_videos` + `events` split.
- **`event_stats_snapshots`** (Phase 3) — immutable time-series of per-event metrics (`event_id`, `polled_at`, `metric_key`, `metric_value`). Charts source from this; the live `events` row is never mutated.
- **`api_keys_*`** — per-tenant encrypted credentials (envelope encryption: KEK from env, DEK per row). Steam in Phase 2; YouTube + Reddit in Phase 3.
- **`audit_log`** — INSERT-only, tenant-relative cursor-paginated audit trail.

Three views over the events table:

- **`/feed`** — primary navigation. All events sorted by `occurred_at DESC`, paginated, filterable by URL params (`source`, `kind`, `game`, `attached`, `author_is_me`, date range). Per-row "Attach to game" picker. Default landing after login. The user's daily workspace.
- **`/sources`** — data source registry. Add/remove, toggle auto-import, see polling status. Configuration, not content.
- **`/games/[id]`** — per-game curated view. Same data filtered to `events WHERE game_id = :id`, grouped by month. Useful for retrospectives and post-mortems.

Polling architecture (Phase 3+) is one generic worker driven by per-kind `DataSourceAdapter`:

```typescript
interface DataSourceAdapter {
  kind: SourceKind;
  pollContent(source: DataSource, since: Date): Promise<RawEvent[]>;  // imports new events
  pollStats(event: Event): Promise<StatsSnapshot>;                    // updates time-series
}
```

Adding a new platform = implementing one adapter + adding a kind to the enum. Schema migrations are not required per platform.

Two ingestion paths coexist by design (nullable `source_id`):

1. **Auto-import** — registered `data_source` (`auto_import=true`) → polling worker → events with `source_id` set
2. **Manual paste** — user pastes URL → oEmbed/equivalent → event with `source_id=NULL`; if oEmbed `author_url` matches a registered data_source, `author_is_me` inherits, otherwise defaults to false

Manual paste is the fallback for one-off URLs (a single blogger video to track without committing to importing the whole channel) and stays first-class.

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-28 after Phase 2 UAT — folded in 4 P0 architectural redesigns (data_sources / 3-view IA / auto-import inbox / unified events table)*
