// events — unified timeline of every promotion artifact (Phase 2.1).
//
// One row per (user, occurrence). Replaces the Phase 2 `tracked_youtube_videos`
// + `events` split. `kind` enum (closed picklist — D-28) discriminates platform;
// `author_is_me` boolean discriminates the user's own content from blogger /
// community coverage; nullable `source_id` distinguishes auto-imported events
// (source_id set) from manually-pasted ones (source_id NULL); events have
// ZERO-or-MORE attached games via the event_games junction (Plan 02.1-27);
// inbox criterion is event_games.length === 0.
//
// occurred_at is the user-meaningful timestamp (when the talk / post / drop
// happened); created_at is the row insertion time.
//
// external_id: per-platform identifier (YouTube videoId, Reddit post id, etc.).
// Used together with `(user_id, kind, source_id)` to dedup auto-imported events.
// NULL for events without a stable external id (some manual `other` entries).
//
// last_polled_at / last_poll_status: Phase 3 worker writes these. NULL on every
// row inserted in Phase 2.1. Phase 3 also adds `event_stats_snapshots` for the
// immutable per-event time-series.

import {
  pgTable,
  text,
  timestamp,
  pgEnum,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user } from "./auth.js";
import { dataSources } from "./data-sources.js";
import { uuidv7 } from "../../ids.js";

// EXPORTED — drizzle-kit silently drops non-exported pgEnums (#5174).
//
// Phase 2.1 adds `youtube_video` and `reddit_post` (both pollable kinds);
// existing kinds are carried forward unchanged.
//
// Plan 02.1-12 (Gap 12): adds `post` — generic platform-agnostic kind for
// Mastodon / LinkedIn / Bluesky / Threads / unmapped platforms beyond the
// platform-tagged kinds. Forward-only enum extension via migration 0001.
export const eventKindEnum = pgEnum("event_kind", [
  "youtube_video",
  "reddit_post",
  "twitter_post",
  "telegram_post",
  "discord_drop",
  "conference",
  "talk",
  "press",
  "other",
  "post",
]);

export const events = pgTable(
  "events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Plan 02.1-27 (UAT-NOTES.md §4.24.G): the legacy `game_id` FK was DROPPED;
    // events relate to ZERO-or-MORE games via the event_games junction table.
    // Inbox criterion is event_games.length === 0 (no attached rows).
    // Nullable: NULL for manually-pasted events; set when auto-imported from
    // a registered data_source.
    sourceId: text("source_id").references(() => dataSources.id, { onDelete: "set null" }),
    kind: eventKindEnum("kind").notNull(),
    authorIsMe: boolean("author_is_me").notNull().default(false),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    title: text("title").notNull(),
    url: text("url"),
    notes: text("notes"),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    externalId: text("external_id"),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    lastPollStatus: text("last_poll_status"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    userIdx: index("events_user_id_idx").on(t.userId),
    // Plan 02.1-27 dropped the (user_id, game_id, occurred_at) composite index
    // — per-game lookups now JOIN through event_games and rely on the
    // event_games(user_id, game_id) index plus the (user_id, occurred_at DESC)
    // cursor index below.
    // /feed cursor pagination: ORDER BY occurred_at DESC, id DESC.
    userOccurredAtIdx: index("events_user_occurred_at_idx").on(
      t.userId,
      sql`${t.occurredAt} DESC`,
      sql`${t.id} DESC`,
    ),
    userSourceIdx: index("events_user_source_idx").on(t.userId, t.sourceId),
    // Dedup auto-imported events — only enforced where both source_id and
    // external_id are present (manual paste leaves source_id NULL; some
    // manual events have no external_id).
    userKindSourceExtUnq: uniqueIndex("events_user_kind_source_ext_unq")
      .on(t.userId, t.kind, t.sourceId, t.externalId)
      .where(sql`${t.sourceId} IS NOT NULL AND ${t.externalId} IS NOT NULL`),
  }),
);
