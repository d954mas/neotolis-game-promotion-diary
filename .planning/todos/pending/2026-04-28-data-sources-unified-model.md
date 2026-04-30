---
created: 2026-04-28T07:05:00.000Z
title: STRATEGIC REDESIGN — "data sources" abstraction (replaces per-platform channel tables)
area: planning
files:
  - .planning/PROJECT.md (Constraints + Architecture sections need this concept)
  - .planning/ROADMAP.md (Phase 3-6 need re-evaluation against this model)
  - src/lib/server/db/schema/youtube-channels.ts (generalize to data_sources)
  - src/lib/server/db/schema/events.ts (add source_id FK; game_id nullable; kind enum extends)
  - src/lib/server/services/youtube-channels.ts (generalize to data-sources.ts service)
  - src/lib/server/integrations/ (each platform = one adapter implementing same interface)
  - related todos:
    - 2026-04-28-rethink-items-vs-events-architecture (P0 unification — prerequisite)
    - 2026-04-28-channel-to-inbox-auto-import-flow (becomes one specific data_source kind)
    - 2026-04-28-youtube-channels-ux-gaps (becomes /data-sources page UX)
---

## Problem

During Phase 2 manual UAT (2026-04-28), user articulated a much cleaner product model:

> **"По сути идея такая. Я из связанного аккаунта, ютуб, реддит и тд, могу получить и посмотреть все видео, посты и тд. И легко помечать видео связанные с конкретной игрой и заодно полную статистику. Например если ютуб то все просмотры. По сути это не совсем аккаунты. Это как источник данных из которого я беру все. Там в основном будут мои. Но например если я куплю реддит аккаунт и попрошу другого человека постить. То там могу захотеть видеть свой и его аккаунты"**

Translation: *"Essentially these aren't accounts. They're data sources from which I pull everything. Mostly mine. But if I hire a Reddit poster, I want to see both my and their accounts."*

Current Phase 2 architecture has the wrong abstraction:
- `youtube_channels` table — YouTube-specific
- `tracked_youtube_videos` table — YouTube-specific
- `events` table — everything else (manual log)
- `/accounts/youtube` page — YouTube-only UI

This means every new platform (Reddit, Twitter, Telegram, Discord, future TikTok/Bluesky/Mastodon...) needs:
- Its own table
- Its own service
- Its own UI page
- Its own polling adapter

And the user has to navigate to N different pages to see "their content" across platforms.

## Proposed model: data sources

Single abstraction `data_sources` replaces all per-platform channel tables:

```sql
data_sources:
  id                 text PRIMARY KEY
  user_id            text NOT NULL                     -- tenant
  kind               source_kind NOT NULL              -- youtube_channel | reddit_account | twitter_account | telegram_channel | discord_server | ...
  handle             text NOT NULL                     -- @username or channel id or board name
  display_name       text                              -- human-readable
  external_url       text                              -- canonical URL (channel page / profile)
  is_owned_by_me     boolean NOT NULL DEFAULT true     -- mine vs someone else's I want to track (e.g. blogger)
  auto_import        boolean NOT NULL DEFAULT true     -- pull content automatically (Phase 3+)
  metadata           jsonb DEFAULT '{}'                -- per-platform adapter state (e.g. uploads_playlist_id, last_polled_at)
  created_at, updated_at, deleted_at (soft-delete pattern)

source_kind ENUM:
  youtube_channel
  reddit_account
  twitter_account     -- when API affordable
  telegram_channel
  discord_server
  -- forward-compat: bluesky, mastodon, tiktok, ...
```

After Phase 2.1 unification (todo `2026-04-28-rethink-items-vs-events-architecture`), the `events` table:

```sql
events:
  ...
  source_id          text REFERENCES data_sources(id)  -- nullable: manual entries have no source
  game_id            text REFERENCES games(id)         -- nullable: inbox items not yet attached
  metadata           jsonb DEFAULT '{}'                -- per-kind stats: youtube view_count, reddit upvotes, ...
  author_is_me       boolean NOT NULL DEFAULT false    -- inherited from data_sources.is_owned_by_me at create time (snapshot, not FK lookup)
```

## Generalized polling architecture (Phase 3)

Each platform = one adapter implementing the same interface:

```typescript
interface DataSourceAdapter {
  kind: SourceKind;
  pollContent(source: DataSource, since: Date): Promise<RawEvent[]>;
  pollStats(event: Event): Promise<StatsSnapshot>;
}

const adapters: Record<SourceKind, DataSourceAdapter> = {
  youtube_channel: youtubeAdapter,    // playlistItems.list + videos.list
  reddit_account:  redditAdapter,     // user/<u>/submitted + per-post stats
  twitter_account: twitterAdapter,    // when affordable
  telegram_channel: telegramAdapter,  // public channel scrape (no API auth needed for public)
  discord_server:  discordAdapter,    // bot integration?
};
```

Phase 3 polling worker = generic loop "for each source, run its adapter". Adding a new platform = implement one adapter.

## UI implications

- `/accounts/youtube` → renamed to `/sources` (one page for all platforms)
- Add data-source picker UI: kind dropdown + URL/handle input
- Inbox view: events with `game_id IS NULL` grouped by source kind
- Per-game tracked items: events with `game_id = <gameId>` grouped by source kind
- Filter chips: "YouTube only / Reddit only / All" + "Mine only / Others / All"

## Stats per item (the Phase 4 promise)

The `events.metadata` jsonb captures per-kind stats:
- YouTube: `{view_count, like_count, comment_count, last_polled_at}`
- Reddit: `{upvotes, num_comments, awards, last_polled_at}`
- Twitter: `{retweets, likes, replies, last_polled_at}`

Phase 3 polling worker writes stats snapshots into a separate time-series table `event_stats_snapshots(event_id, snapshot_at, metric_key, metric_value)` for trend graphs (Phase 4 LayerChart).

## Phase split

**Phase 2.1 (alongside items+events unification):**
- Rename `youtube_channels` → `data_sources`; add `kind`, `auto_import`, `metadata` columns
- Make `events.game_id` nullable
- Add `events.source_id` FK
- UI: `/accounts/youtube` becomes `/sources` (still YouTube-only in P2.1, but generic page)
- Future-proof: `kind` enum has all values, but only `youtube_channel` is functional

**Phase 3:**
- DataSourceAdapter interface + YouTube adapter implementation
- Polling worker (generic loop)
- Stats snapshots table for time-series

**Phase 4:**
- LayerChart per-event trend graphs
- Inbox UI with attach-to-game flow
- Cross-platform dashboard

**Phase 5+:**
- Reddit adapter (KEYS-02)
- Telegram adapter (public channel scrape)
- Discord adapter (bot)

**Phase 6+:**
- Twitter adapter (if API becomes affordable)
- Other platforms

## Why this matters strategically

The user reached this through actual product use — they want a **promotion analytics platform**, not a "YouTube + manual log" tool. The data_sources abstraction:

1. **Matches user mental model** — "I have content sources, I want to see and measure all of them in one place"
2. **Future-proofs the schema** — new platforms = new enum value + adapter, no schema migration
3. **Makes Phase 3-6 polling worker simpler** — one generic worker, not N hand-coded ones
4. **Multi-account scenario works naturally** — user can register multiple sources of the same kind (their personal Reddit + a hired writer's Reddit)
5. **Matches market positioning** — every promotion-analytics product uses "sources" framing (Hootsuite, Buffer, Sprout Social, etc.)

## Severity

**P0 STRATEGIC** — bigger than Phase 2.1, smaller than v2. Bundle the schema rename with Phase 2.1 unification (already touching everything in events/items domain). The actual multi-platform features land in Phase 5+.

## Required PROJECT.md / ROADMAP updates

- PROJECT.md "Architecture" section: introduce data_sources as the core abstraction
- ROADMAP.md Phase 3-6: re-evaluate against the generic polling worker model (probably simplifies, doesn't expand scope)
- REQUIREMENTS.md: KEYS-01 (YouTube key) becomes "first concrete use of data_source kind=youtube_channel"; KEYS-02 (Reddit) becomes data_source kind=reddit_account; INGEST-01 (Reddit URL) becomes a manual-paste fallback for users without a registered Reddit data_source

## Manual paste coexists with auto-import (clarification)

User explicitly confirmed (2026-04-28): "И при этом я же могу добавить одно видео, без целого канала?"

The model supports both ingestion paths cleanly via nullable `source_id`:

**Path 1 — auto-import (Phase 3):**
- Registered data_source → polling worker → events with `source_id = <data_source.id>`

**Path 2 — manual paste (works in Phase 2 today):**
- User pastes one URL → service calls oEmbed → creates event with `source_id = NULL`
- INGEST-03 enrichment: oEmbed `author_url` is matched against user's registered data_sources to set `author_is_me`
  - Match found → `author_is_me` inherited from the matched data_source
  - No match → `author_is_me = false` (default to "blogger / not mine")
- User can manually flip `author_is_me` from the event detail page (Phase 4)

Three real-world scenarios, all clean:
1. *"I want my own channel auto-tracked"* → register data_source(kind=youtube_channel, is_owned_by_me=true, auto_import=true) → all videos flow in
2. *"I want to record one blogger review"* → just paste URL → event with source_id=NULL, author_is_me=false (default)
3. *"I want to continuously track a specific blogger"* → register data_source(kind=youtube_channel, is_owned_by_me=false, auto_import=true) → all their videos flow in (with author_is_me=false)

This makes data_sources a **convenience for high-volume ingestion**, not a requirement. The manual paste path stays first-class.

## Open questions for Phase 2.1 planning

1. Should Phase 2.1 keep "/accounts/youtube" as the URL or rename to "/sources" now? (User-facing rename = bookmark breakage; internal-only = no impact yet — vote internal, since Phase 2 is dev-only data)
2. How does this interact with the existing audit_log entries for `channel.added` / `channel.removed`? → audit becomes `source.added` / `source.removed` (rename action enum)
3. Multi-tenant scoping: data_sources is per-user; another user could register the same channel — that's fine (each row scoped by user_id, no uniqueness constraint across users)

Owner: PROJECT.md re-architecture decision. Phase 2.1 schema landing is dependent on this decision being made.
