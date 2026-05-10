// data_source_channel_state — Phase 03.0.1 Wave 1 (channel-scoped polling).
//
// Channel-level backfill state, NOT per-user. One row per (kind, channel_key)
// shared across all subscribers to the same channel. Replaces per-source
// last_polled_at / backfill_oldest_at / backfill_complete /
// metadata.lastBackfillPageToken in `data_sources`.
//
// Why: 10 users subscribed to UCxxx → previously 10 separate walks per cron
// tick = 10× quota burn for identical playlist data. With channel-scoped
// state, ONE walk per channel per tick fans out events to all subscribers.
// Triggering user pays quota; subscribers free-ride.
//
// Generic across platforms (Reddit/Twitter/Telegram) — channel_key is a
// platform-specific stable identifier:
//   - youtube_channel:    channel_id (UCxxx)
//   - reddit_account:     subreddit slug or account handle (Phase 03.1+)
//   - twitter_account:    handle (Phase 03.1+)
//   - telegram_channel:   channel id or @-handle (Phase 03.1+)
//
// Per-user state (target_since, auto_import, is_owned_by_me, display_name)
// remains in `data_sources`. Per-channel cache fields (uploads_playlist_id,
// channel_title) stay in platform-specific cache tables (youtube_channels).
//
// Tenant scoping: this table is intentionally CROSS-TENANT (channels are
// global). Tenant scoping happens at INSERT-into-events time via fan-out
// loop — each subscriber gets their own events.user_id row, idempotency
// UNIQUE (user_id, source_id, kind, external_id) protects per-user.
//
// Migration: drizzle/0027_phase03_01_channel_state.sql.

import { boolean, jsonb, pgTable, primaryKey, text, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { sourceKindEnum } from "./data-sources.js";

export const dataSourceChannelState = pgTable(
  "data_source_channel_state",
  {
    kind: sourceKindEnum("kind").notNull(),
    /**
     * Stable platform-specific channel identifier. For YouTube this is the
     * canonical channelId (UCxxx); other platforms use their native id.
     * NEVER user-pasted handle (handles can be renamed); MUST be the
     * platform's canonical id, resolved at onboarding time.
     */
    channelKey: text("channel_key").notNull(),
    /**
     * When this channel was last successfully polled by ANY trigger
     * (cron incremental, cron auto-backfill, user click). UI displays
     * "Channel last checked: N min ago" — same value seen by ALL
     * subscribers (Q3-A semantics).
     */
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    /**
     * Earliest event.publishedAt the deepest walk has fetched. Frontier for
     * resume; channel-level (not per-user). When a new subscriber joins,
     * we compare their target_since against this and decide whether to
     * deepen the walk OR bulk-INSERT from cache (if oldest_at <= target).
     */
    backfillOldestAt: timestamp("backfill_oldest_at", { withTimezone: true }),
    /**
     * True when adapter.pollContent returned endOfPlaylist=true (platform
     * confirmed no more older content). Cron auto-backfill picker
     * excludes complete channels. Daily incremental cron still walks
     * complete channels (page 1 only) to discover new uploads.
     */
    backfillComplete: boolean("backfill_complete").notNull().default(false),
    /**
     * Channel-level metadata bag. Currently holds `lastBackfillPageToken`
     * (resume cursor for paginated walks); future fields can be added by
     * platforms without schema migration.
     */
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.kind, t.channelKey] }),
    /**
     * Cron picker — incomplete channels ordered by oldest-poll-first.
     * Partial index (only incomplete) keeps it tiny. Used by both
     * auto-backfill cron (deep walk) and incremental cron (page-1 walk).
     */
    pickerIdx: index("data_source_channel_state_picker_idx")
      .on(t.lastPolledAt)
      .where(sql`${t.backfillComplete} = false`),
  }),
);

export type DataSourceChannelStateRow = typeof dataSourceChannelState.$inferSelect;
