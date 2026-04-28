// data_sources — unified per-tenant registry of content sources (Phase 2.1).
//
// Replaces the Phase 2 `youtube_channels` table. One row per (user, kind, handle):
// YouTube channels, Reddit accounts, Twitter accounts, Telegram channels, Discord
// servers. Pollable in Phase 3 via per-kind `DataSourceAdapter`; in Phase 2.1
// only the schema + the `youtube_channel` STUB exist.
//
// Lives at user level (NOT cascaded by game soft-delete). Two ways the user can
// paste a YouTube source: (a) handle URL like https://youtube.com/@RickAstleyYT,
// (b) canonical channel URL like https://youtube.com/channel/UC.... handle_url
// is ALWAYS set (the user-pasted form); channel_id is set only if (b) was pasted
// OR a future resolver fetches the canonical id. For non-YouTube kinds,
// channel_id stays NULL — the per-kind metadata jsonb carries platform-specific
// resolved identifiers (e.g. `uploads_playlist_id` for YouTube once Phase 3
// resolves it; `subreddit` for Reddit; etc.).
//
// is_owned_by_me: true => own content (videos auto-mark as own); false =>
// blogger / community coverage. UI heuristic: first source defaults to true,
// subsequent default false.
//
// auto_import: when true and is_owned_by_me=true, the Phase 3 worker pulls
// new content for this source automatically. false = passive registry only.
//
// deleted_at: soft-delete per SOURCES-02 (60-day retention via RETENTION_DAYS).
// The unique index `data_sources_user_handle_active_unq` is partial over
// `WHERE deleted_at IS NULL` so a soft-deleted source does not block re-add
// of the same handle.

import {
  boolean,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user } from "./auth.js";
import { uuidv7 } from "../../ids.js";

// EXPORTED — drizzle-kit silently drops non-exported pgEnums (#5174).
export const sourceKindEnum = pgEnum("source_kind", [
  "youtube_channel",
  "reddit_account",
  "twitter_account",
  "telegram_channel",
  "discord_server",
]);

export const dataSources = pgTable(
  "data_sources",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: sourceKindEnum("kind").notNull(),
    handleUrl: text("handle_url").notNull(),
    channelId: text("channel_id"),
    displayName: text("display_name"),
    isOwnedByMe: boolean("is_owned_by_me").notNull().default(true),
    autoImport: boolean("auto_import").notNull().default(true),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    userIdIdx: index("data_sources_user_id_idx").on(t.userId),
    userKindIdx: index("data_sources_user_kind_idx").on(t.userId, t.kind),
    userDeletedAtIdx: index("data_sources_user_deleted_at_idx").on(t.userId, t.deletedAt),
    // Partial unique index — soft-deleted rows do not block re-adding the
    // same handle (SOURCES-02 retention semantics).
    userHandleActiveUnq: uniqueIndex("data_sources_user_handle_active_unq")
      .on(t.userId, t.handleUrl)
      .where(sql`${t.deletedAt} IS NULL`),
  }),
);
