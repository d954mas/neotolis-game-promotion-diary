// youtube_channel_metadata_cache — Phase 3.0 Plan 01.
//
// PUBLIC-DATA CACHE — no `user_id` column by design (CONTEXT D-14). Channel
// metadata (uploads_playlist_id, channel_title) is shared across every tenant
// who pastes a video from that channel; the cache row is keyed on
// `channel_id` (PK) so a paste of the same channel from a second tenant
// is a cache hit, not a quota burn.
//
// Populated by the Plan 03.0-10 channel-context-backfill worker on first
// paste of a video from an unknown channel. Subsequent paste of any video
// from the same channel = cache hit, zero quota. ESLint TENANT_TABLES
// allowlist mirrors the no-tenant-scope semantics with an explicit
// "public external data, no tenant scope" comment.
//
// `last_backfill_at` lets the Plan 03.0-10 worker decide whether to refresh
// the cache (e.g. user pastes a stale upload from 6 months ago and the
// channel's playlist needs a re-walk). NULL = never backfilled.

import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const youtubeChannelMetadataCache = pgTable("youtube_channel_metadata_cache", {
  channelId: text("channel_id").primaryKey(),
  uploadsPlaylistId: text("uploads_playlist_id").notNull(),
  channelTitle: text("channel_title"),
  lastBackfillAt: timestamp("last_backfill_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type YoutubeChannelMetadataCache = typeof youtubeChannelMetadataCache.$inferSelect;
export type NewYoutubeChannelMetadataCache = typeof youtubeChannelMetadataCache.$inferInsert;
