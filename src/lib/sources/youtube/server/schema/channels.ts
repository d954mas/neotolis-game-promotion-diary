// youtube_channels — our local copy of YouTube channel metadata.
//
// PUBLIC-DATA — no `user_id` column by design. Channel metadata
// (uploads_playlist_id, channel_title) is shared across every tenant who
// pastes a video from that channel; the row is keyed on `channel_id` (PK)
// so a paste of the same channel from a second tenant is a hit, not a
// quota burn.
//
// Naming note: an earlier draft used the suffix `_metadata_cache`. "Cache"
// implies a regeneratable copy of some local truth, but this IS our
// truth — pulled from YouTube once and stored.
//
// Populated by the channel-context-backfill worker on first paste of a
// video from an unknown channel. Subsequent paste of any video from the
// same channel = hit, zero quota. ESLint TENANT_TABLES allowlist mirrors
// the no-tenant-scope semantics with an explicit "public external data,
// no tenant scope" comment.
//
// `last_backfill_at` lets the worker decide whether to refresh the row
// (e.g. user pastes a stale upload from 6 months ago and the channel's
// playlist needs a re-walk). NULL = never backfilled.
//
// `handle_aliases` tracks every handle / legacy URL that resolved to this
// UC id. Backfill worker appends the resolved-from URL after
// channels.list?forHandle returns the UC id; ingest's cache lookup widens
// with `= ANY(handle_aliases)` so any future paste of the same handle URL
// hits the row directly. This permanently closes the handle-URL cache
// miss.

import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const youtubeChannels = pgTable(
  "youtube_channels",
  {
    channelId: text("channel_id").primaryKey(),
    uploadsPlaylistId: text("uploads_playlist_id").notNull(),
    channelTitle: text("channel_title"),
    lastBackfillAt: timestamp("last_backfill_at", { withTimezone: true }),
    handleAliases: text("handle_aliases")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // GIN index supports `= ANY(handle_aliases)` membership lookups in
    // the ingest cache check without a seq scan.
    handleAliasesIdx: index("idx_youtube_channels_handle_aliases").using("gin", t.handleAliases),
  }),
);

export type YoutubeChannel = typeof youtubeChannels.$inferSelect;
export type NewYoutubeChannel = typeof youtubeChannels.$inferInsert;
