// data_sources — unified per-tenant registry of content sources.
//
// One row per (user, kind, handle): YouTube channels, Reddit accounts,
// Twitter accounts, Telegram channels, Discord servers. Pollable via
// per-kind `SourceAdapter`; today only YouTube has a functional
// adapter implementation.
//
// Lives at user level (NOT cascaded by game soft-delete). Two ways the user can
// paste a YouTube source: (a) handle URL like https://youtube.com/@RickAstleyYT,
// (b) canonical channel URL like https://youtube.com/channel/UC.... handle_url
// is ALWAYS set (the user-pasted form); channel_id is set only if (b) was pasted
// OR a future resolver fetches the canonical id. For non-YouTube kinds,
// channel_id stays NULL — the per-kind metadata jsonb carries platform-specific
// resolved identifiers (e.g. `uploads_playlist_id` for YouTube; `subreddit`
// for Reddit; etc.).
//
// is_owned_by_me: true => own content (videos auto-mark as own); false =>
// blogger / community coverage. UI heuristic: first source defaults to true,
// subsequent default false.
//
// auto_import: when true and is_owned_by_me=true, the worker pulls new
// content for this source automatically. false = passive registry only.
//
// deleted_at: soft-delete (60-day retention via RETENTION_DAYS). The
// unique index `data_sources_user_handle_active_unq` is partial over
// `WHERE deleted_at IS NULL` so a soft-deleted source does not block
// re-add of the same handle.

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
//
// `reddit_subreddit` joined `reddit_account` in Phase 03.1: a user can
// register either an OWNED account (`/user/X` — their own posting
// activity) OR a subreddit they want to track (`/r/X` — community
// metadata + growth). Both are non-OAuth, public-`.json` adapter
// kinds per DV-RDT-7.
export const sourceKindEnum = pgEnum("source_kind", [
  "youtube_channel",
  "reddit_account",
  "reddit_subreddit",
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
    // Free-form per-user note attached to this source. The source title is
    // read-only canonical (channelTitle / r/<sub> / u/<handle>) — the user
    // cannot rename what arrives from the upstream platform, but can
    // annotate it with a private remark to disambiguate similar handles
    // ("press contact", "asked for review codes", etc.). NULL when unset;
    // empty-string saves are normalized back to NULL by the route layer.
    // 500-char ceiling enforced at the API boundary (z.string().max(500)).
    note: text("note"),
    isOwnedByMe: boolean("is_owned_by_me").notNull().default(true),
    autoImport: boolean("auto_import").notNull().default(true),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // AdapterError surface. Updated by worker handlers when an
    // AdapterError of category operator-issue / permanent / not-found
    // is caught against this source. `transient` and `rate-limited`
    // errors do NOT touch these columns (transient retries via pg-boss;
    // rate-limited is a service-wide signal, not a per-source one).
    needsReconnect: boolean("needs_reconnect").notNull().default(false),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    lastErrorKind: text("last_error_kind"),
    // Per-user backfill preference. Channel-scoped state lives in
    // `data_source_channel_state` and is shared across subscribers.
    //
    //   backfillTargetSince — absolute date — earliest boundary user
    //                         wants. Per-user preference (different
    //                         users on the same channel may have
    //                         different targets). Semantics:
    //                           NULL → no historical pull, only
    //                                  newer-than-frontier incremental
    //                           date → pull until events.occurred_at >= date
    //                           '1970-01-01' → "everything" sentinel
    backfillTargetSince: timestamp("backfill_target_since", { withTimezone: true }),
  },
  (t) => ({
    userIdIdx: index("data_sources_user_id_idx").on(t.userId),
    userKindIdx: index("data_sources_user_kind_idx").on(t.userId, t.kind),
    userDeletedAtIdx: index("data_sources_user_deleted_at_idx").on(t.userId, t.deletedAt),
    // Partial unique index — soft-deleted rows do not block re-adding
    // the same handle.
    userHandleActiveUnq: uniqueIndex("data_sources_user_handle_active_unq")
      .on(t.userId, t.handleUrl)
      .where(sql`${t.deletedAt} IS NULL`),
  }),
);
