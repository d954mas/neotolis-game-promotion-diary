// youtube_channels — Phase 3.0 Plan 01 (renamed from youtube_channel_metadata_cache
// during UAT 2026-05-06). Our local copy of YouTube channel metadata.
//
// PUBLIC-DATA — no `user_id` column by design (CONTEXT D-14). Channel
// metadata (uploads_playlist_id, channel_title) is shared across every tenant
// who pastes a video from that channel; the row is keyed on `channel_id` (PK)
// so a paste of the same channel from a second tenant is a hit, not a
// quota burn.
//
// Naming note: the original Phase 3.0 Plan 01 baseline used the suffix
// `_metadata_cache` on this table. "Cache" implies a regeneratable copy of
// some local truth, but this IS our truth — pulled from YouTube once and
// stored. UAT 2026-05-06 renamed both YouTube tables (this one and
// youtube_videos) to drop the misnomer.
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

import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const youtubeChannels = pgTable("youtube_channels", {
  channelId: text("channel_id").primaryKey(),
  uploadsPlaylistId: text("uploads_playlist_id").notNull(),
  channelTitle: text("channel_title"),
  lastBackfillAt: timestamp("last_backfill_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type YoutubeChannel = typeof youtubeChannels.$inferSelect;
export type NewYoutubeChannel = typeof youtubeChannels.$inferInsert;
