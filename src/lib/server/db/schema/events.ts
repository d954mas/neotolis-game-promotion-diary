// events — unified timeline of every promotion artifact.
//
// One row per (user, occurrence). `kind` enum (closed picklist)
// discriminates platform; `author_is_me` boolean discriminates the user's
// own content from blogger / community coverage; nullable `source_id`
// distinguishes auto-imported events (source_id set) from manually-pasted
// ones (source_id NULL); events have ZERO-or-MORE attached games via the
// event_games junction; inbox criterion is event_games.length === 0.
//
// occurred_at is the user-meaningful timestamp (when the talk / post / drop
// happened); created_at is the row insertion time.
//
// external_id: per-platform identifier (YouTube videoId, Reddit post id, etc.).
// Used together with `(user_id, kind, source_id)` to dedup auto-imported events.
// NULL for events without a stable external id (some manual `other` entries).
//
// Polling state DOES NOT live here. `last_polled_at` + `last_poll_status`
// live on `youtube_videos` — they are properties of the video, not of the
// user-logged event. Multiple events for the same external_id (one user
// logging "Released video X" + "Streamed promo for X" + "Reddit post for
// X") share polling state via JOIN on external_id. See PROJECT.md
// "Architecture" section for the per-video polling model.

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
// `youtube_video` and `reddit_post` are pollable kinds.
// `post` is the generic platform-agnostic kind for Mastodon / LinkedIn /
// Bluesky / Threads / unmapped platforms beyond the platform-tagged kinds.
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
    // Events relate to ZERO-or-MORE games via the event_games junction
    // table. Inbox criterion is event_games.length === 0 (no attached rows).
    // Nullable: NULL for manually-pasted events; set when auto-imported
    // from a registered data_source.
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    userIdx: index("events_user_id_idx").on(t.userId),
    // Per-game lookups JOIN through event_games and rely on the
    // event_games(user_id, game_id) index plus the (user_id,
    // occurred_at DESC) cursor index below.
    // /feed cursor pagination: ORDER BY occurred_at DESC, id DESC.
    userOccurredAtIdx: index("events_user_occurred_at_idx").on(
      t.userId,
      sql`${t.occurredAt} DESC`,
      sql`${t.id} DESC`,
    ),
    // events_per_day quota counts rows where userId = ? AND createdAt
    // >= now()-24h. The (userId, occurredAt) index above is the wrong
    // shape — occurredAt is the user-meaningful timestamp, createdAt is
    // the wall-clock INSERT time the quota window keys off of. Without
    // this index Postgres index-seeks userId then row-fetch-filters
    // createdAt; on a heavy user (10k+ events) every quota check pays
    // the tail-row scan. ~28 bytes/row × 18k rows/active-year ≈
    // 0.5MB/user — cheap.
    userCreatedAtIdx: index("events_user_created_at_idx").on(t.userId, sql`${t.createdAt} DESC`),
    userSourceIdx: index("events_user_source_idx").on(t.userId, t.sourceId),
    // Dedup auto-imported events — only enforced where both source_id and
    // external_id are present (manual paste leaves source_id NULL; some
    // manual events have no external_id).
    userKindSourceExtUnq: uniqueIndex("events_user_kind_source_ext_unq")
      .on(t.userId, t.kind, t.sourceId, t.externalId)
      .where(sql`${t.sourceId} IS NOT NULL AND ${t.externalId} IS NOT NULL`),
    // Polling-state queries go through youtube_videos (one row per video,
    // JOINed on external_id from events). The previous partial index on
    // events.last_polled_at and the column itself were dropped in an
    // earlier migration.
    //
    // The previous unique (user_id, kind, external_id) partial index was
    // also dropped. Original intent ("one event per user per external
    // video — paste-twice updates existing") collided with the operator's
    // actual use case: a single review video covering 5 different games
    // warrants 5 separate events, each with its own attached game and
    // notes. Idempotency for the auto-import worker is enforced via an
    // explicit pre-insert SELECT in the handler. Duplicate-detection on
    // manual paste is a UI concern (offer "add another note" vs "view
    // existing") — wired in the /events/[id] detail-view path.
    //
    // The dedup unique above (eventsUserKindSourceExtUnq, partial
    // WHERE source_id IS NOT NULL) remains in place. That one only fires
    // when the auto-import worker mistakenly tries to insert a video twice
    // for the SAME source — a worker bug, not user intent. Manual paste
    // leaves source_id NULL so it never trips there.
  }),
);
