// telegram_channels — our local copy of a public Telegram channel's own
// metadata (title, @username slug, avatar, description, subscriber count),
// scraped from the t.me/s listing header (Phase 9).
//
// PUBLIC-DATA — no `user_id` column by design. A channel's title / subscriber
// count is identical regardless of which tenant looked it up; per-tenant copies
// would waste disk for no privacy benefit (mirrors youtube_channels /
// telegram_posts / instagram_posts public-data semantics). ESLint TENANT_TABLES
// allowlist extends `telegramChannels` with an explicit "public external data,
// no tenant scope" comment so the no-unfiltered-tenant-query rule does not trip
// on legitimate `db.select().from(telegramChannels)` calls.
//
// SOURCE-OF-TRUTH, NOT a denorm of data_sources. This row is OUR truth for the
// channel's OWN upstream metadata — the same role youtube_channels plays (see
// its "this IS our truth" header). It is NOT a copy of a value another table
// owns: `data_sources.display_name` is the user-facing label a tenant may
// rename freely; `telegram_channels.title` is the upstream channel name as
// scraped from Telegram. The two coexist by design and never alias each other
// (AGENTS.md no-denorm rule forbids caching data_sources.display_name HERE, and
// equally forbids caching this title onto a data_sources / telegram_posts row).
// The renameable @username handle still lives on data_sources for feed
// enrichment; `slug` here is the current scraped @username, retained on the
// entity for the future channel page + a handle_aliases history (mirrors
// youtube_channels.handle_aliases).
//
// PK = `channel_key` — the intrinsic numeric channel id Telegram embeds in each
// post block's base64 `data-view` payload (`{"c":<channelId>,...}`). Stored as
// TEXT to match telegram_posts.channel_key (the join key for future per-channel
// analytics). It is rename-proof: the @username changes, the numeric id does
// not — so it is the stable group key, never a renameable display value.
//
// Populated by the listing-poll + backfill handlers: each poll UPSERTs from the
// parsed channel header (insert sets first_seen_at; update refreshes
// title/slug/avatar/description/subscriber_count + last_refreshed_at). On a
// non-ok / partial parse the writer COALESCE-preserves the prior good metadata
// so a transient miss never blanks a working row (same rule as
// telegram_posts.thumbnail_url, IG #69 P1-A).
//
// Retention forever — NO garbage collection (mirrors youtube_channels /
// telegram_posts). The row IS the historical anchor for the channel's per-post
// stats; future channel-level analytics (percentiles / baselines, a channel
// page) require it to persist independently of any referencing event /
// data_source.
//
// FOUNDATION ONLY (Phase 9 scope): this table is the subject entity that future
// per-channel percentile baselines + a channel page will read. Those are NOT
// built now — designed for, not implemented. The canonical percentile pattern
// to copy when they land is reddit_subreddit_baselines (a separate public-data
// aggregate table keyed by the subject key). The backfill depth cap
// (TELEGRAM_BACKFILL_MAX_POSTS, currently 100) will be revisited when
// percentiles land, since meaningful per-channel baselines may want a deeper
// historical sample than the steady-state feed needs.

import { pgTable, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const telegramChannels = pgTable(
  "telegram_channels",
  {
    // Intrinsic numeric channel id from the data-view base64 payload (`c`),
    // stored as text to match telegram_posts.channel_key. Rename-proof PK.
    channelKey: text("channel_key").primaryKey(),
    // Current scraped @username (without the leading '@'). Renameable upstream →
    // a change appends the old value to handle_aliases and updates this column.
    slug: text("slug"),
    // Upstream channel title (display name as Telegram shows it). OUR truth for
    // the channel's own name — NOT a denorm of data_sources.display_name.
    title: text("title"),
    avatarUrl: text("avatar_url"),
    description: text("description"),
    subscriberCount: integer("subscriber_count"),
    // Every @username this channel id has been seen under. The current slug is
    // also kept here historically; the list widens on a slug change so a future
    // channel page can resolve any historical handle to this id (mirrors
    // youtube_channels.handle_aliases).
    handleAliases: text("handle_aliases")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // GIN index supports `= ANY(handle_aliases)` membership lookups (future
    // channel-page resolution of a historical @username to this id).
    handleAliasesIdx: index("idx_telegram_channels_handle_aliases").using("gin", t.handleAliases),
  }),
);

export type TelegramChannel = typeof telegramChannels.$inferSelect;
export type NewTelegramChannel = typeof telegramChannels.$inferInsert;
