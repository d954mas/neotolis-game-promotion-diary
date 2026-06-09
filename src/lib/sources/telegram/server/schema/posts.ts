// telegram_posts — our local copy of a public Telegram channel post's metadata
// + polling state. Sourced from the free t.me/s listing scrape (Phase 9).
//
// One row per post, keyed on `post_id` (PK = "<channel>/<messageId>" — the full
// data-post attr value). PUBLIC-DATA — no `user_id` column by design. A
// channel post's view count is identical regardless of which tenant looked it
// up, so per-tenant copies would waste disk for no privacy benefit (mirrors the
// youtube_videos / instagram_posts public-data semantics). ESLint
// TENANT_TABLES allowlist extends `telegramPosts` with an explicit "public
// external data, no tenant scope" comment (added in Plan 01) so the
// no-unfiltered-tenant-query rule does not trip on legitimate
// `db.select().from(telegramPosts)` calls.
//
// Message ids are per-channel sequential — NOT globally unique — so the channel
// slug is part of the key (RESEARCH Q3). events.external_id carries the SAME
// "<channel>/<messageId>" value (set by parseUrl).
//
// Polling state lives here (not on `events`):
//   - `last_polled_at` / `last_poll_status` — last successful or failed attempt
//     to fetch this post's metrics. Properties of the POST, not of the
//     user-logged event. Multiple events referencing the same external_id share
//     this state via JOIN.
//   - `poll_failure_count` — increments on every non-ok poll, resets on 'ok'.
//
// Tier classification (Active/Cold/Frozen/Pending/Unavailable) keys on
// `published_at`, not on `events.occurred_at` — a "I logged a promo today for a
// year-old post" paste correctly resolves to Cold/Frozen.
//
// NO denormalized channel display name / @username handle here (AGENTS.md
// no-denorm rule). The renameable @username handle lives on data_sources (the
// source-of-truth row); feed-enrichment JOINs at read time so a handle rename
// reflects everywhere. `channel_key` (the intrinsic numeric channel id from the
// data-view base64 payload) is the only safe identifier to carry — it is the
// rename-proof channel key, part of the canonical identity, not a renameable
// display value.
//
// Retention contract mirrors youtube_videos / instagram_posts: rows are NEVER
// garbage-collected, even when the last referencing event / data_source has
// been deleted. The row IS the historical record for that channel's per-post
// stats; future channel-level analytics require the full historical record.

import { pgTable, text, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** One reaction entry for the card's top-5 list (E1 — current-state, lives on
 *  telegram_posts like thumbnail_url / text_snippet, NOT the snapshot table).
 *  - `emoji` is the unicode char for a standard emoji; null for a custom/premium
 *    sticker (only an emoji-id, no unicode) and for a paid Telegram-Stars
 *    reaction (a stars glyph, no emoji). The card renders a per-kind fallback
 *    glyph when emoji is null.
 *  - `kind` distinguishes the three reaction families the t.me/s markup exposes.
 *  - `count` is the normalized integer (K/M-expanded, same as view counts). */
export interface TelegramReaction {
  emoji: string | null;
  kind: "standard" | "custom" | "paid";
  count: number;
}

export const telegramPosts = pgTable(
  "telegram_posts",
  {
    // PK = "<channel>/<messageId>" (the full data-post attr value). Message
    // ids are per-channel sequential — NOT globally unique — so the channel
    // slug is part of the key (RESEARCH Q3). events.external_id carries the
    // SAME "<channel>/<messageId>" value (set by parseUrl).
    postId: text("post_id").primaryKey(),
    // Intrinsic numeric channel id from the data-view base64 payload — the
    // rename-proof anchor. The @username handle is renameable → held on
    // data_sources, NEVER denormalized here (AGENTS.md no-denorm).
    channelKey: text("channel_key"),
    textSnippet: text("text_snippet"),
    mediaKind: text("media_kind"), // 'photo' | 'video' | 'album' | null
    thumbnailUrl: text("thumbnail_url"), // hotlink (D-06); refreshed each poll
    // Top-5 most-popular reactions (E1 current-state — parallels thumbnail_url /
    // text_snippet: the card's reactions list reads THIS, while the
    // reactions_total time-series lives on telegram_post_snapshots). Array of
    // {emoji, kind, count} sorted desc, capped at 5. null until first resolved;
    // COALESCE-preserved on a non-ok poll (a transient failure must not blank a
    // working reactions list, same rule as thumbnail_url). A post with no
    // reactions block stores [] (resolved, but empty) → the card renders no row.
    reactionsTop: jsonb("reactions_top").$type<TelegramReaction[]>(),
    externalUrl: text("external_url"), // canonical t.me/<channel>/<id>
    publishedAt: timestamp("published_at", { withTimezone: true }), // drives tier
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    lastPollStatus: text("last_poll_status"),
    pollFailureCount: integer("poll_failure_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Scheduler tier filter — published_at is the load-bearing signal for
    // Active/Cold/Frozen classification. Partial index keeps it narrow over
    // the rare null-published rows (posts pre-backfill, the 'pending' tier).
    publishedAtIdx: index("idx_telegram_posts_published_at")
      .on(t.publishedAt)
      .where(sql`${t.publishedAt} IS NOT NULL`),
  }),
);

export type TelegramPost = typeof telegramPosts.$inferSelect;
export type NewTelegramPost = typeof telegramPosts.$inferInsert;
