// Idempotent per-post snapshot writer for Telegram (mirrors
// reddit/server/snapshots.ts). Telegram's public t.me/s listing exposes TWO
// metrics: a view count AND a per-post reaction tally (E1 — Phase 9 UAT second
// metric); no likes/comments/shares (D-04). The snapshot table holds the
// view_count + reactions_total time-series; telegram_posts holds the top-5
// reactions_top current-state (parallel to thumbnail_url).
//
// Two phases, each idempotent on its OWN — NO wrapping db.transaction (G2,
// mirrors reddit snapshots which are bare single-statement writes). The atomicity
// is not load-bearing: if the UPSERT lands but the snapshot INSERT is lost to a
// crash, the next poll re-runs the (idempotent) UPSERT and re-inserts the
// snapshot — a missing time-series point on a crash is benign (the same as a
// viewCount=null poll, which writes no snapshot). Dropping the per-post tx means
// a page of N posts is N idempotent writes, not N short transactions.
//   1. UPSERT telegram_posts on post_id PK — refresh the snippet fields
//      (channel_key, text_snippet, media_kind, thumbnail_url, external_url,
//      published_at) + polling state (last_polled_at, last_poll_status,
//      poll_failure_count). thumbnail_url is COALESCE-preserved: an OK poll
//      carries a fresh hotlink (refreshes it), a NON-OK poll carries none →
//      COALESCE keeps the last good URL instead of blanking the cover (IG #69
//      P1-A — a transient Refresh failure must not erase a working thumbnail).
//      poll_failure_count increments on non-ok, resets on 'ok'.
//   2. INSERT telegram_post_snapshots (post_id, polled_at = date_trunc('minute',
//      now()), view_count) ON CONFLICT (post_id, polled_at) DO NOTHING — within
//      -the-minute retries collapse to one row. ONLY when status === 'ok' AND
//      viewCount !== null (a hidden-views post updates polling state but adds no
//      snapshot row — null is a chart GAP, never coerced to 0).
//
// PUBLIC-DATA tables → no userId scope (allowlisted in Plan 01). Multiple
// tenants who reference the same post share one telegram_posts row + one
// snapshot per minute.
//
// Caller owns the HTTP call (which happens OUTSIDE this writer — never hold a row
// lock while waiting on a t.me payload). This service expects the metrics +
// status as already-resolved inputs.

import { sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { telegramPosts, telegramPostSnapshots } from "$lib/server/db/schema/index.js";
import type { TelegramReaction } from "./schema/posts.js";

export type TelegramSnapshotStatus = "ok" | "not_found" | "private" | "rate_limited";

export interface WriteTelegramSnapshotArgs {
  /** telegram_posts.post_id ("<channel>/<messageId>") — keys the UPSERT + the
   *  snapshot INSERT. */
  postId: string;
  /** Intrinsic numeric channel id (rename-proof anchor). Nullable. */
  channelKey?: string | null;
  textSnippet?: string | null;
  /** "photo" | "video" | "album" | null. */
  mediaKind?: string | null;
  /** Hotlink (D-06). Refreshed on every OK poll; COALESCE-preserved on non-ok. */
  thumbnailUrl?: string | null;
  /** Canonical t.me/<channel>/<id>. */
  externalUrl?: string | null;
  /** Drives tier classification. */
  publishedAt?: Date | null;
  /**
   * Resolved view count. NULL → views absent (very new post or views disabled).
   * A snapshot row is written when status==='ok' AND at least one metric
   * (viewCount OR reactionsTotal) is non-null; view_count stays NULL in that
   * row when only reactions are present (the chart draws a GAP, not a 0).
   */
  viewCount: number | null;
  /**
   * Resolved summed reaction count (E1, second metric). NULL → the post carries
   * no reactions block. Written to the snapshot's reactions_total column
   * (parallel to view_count): a present value charts as the reactions trend, a
   * NULL is a GAP (never 0 — D-05). The metric-series reader drops an all-null
   * reactions line. Reactions live ONLY on the t.me/s listing, so the warm-lane
   * embed path passes null here.
   */
  reactionsTotal?: number | null;
  /**
   * Top-5 most-popular reactions for the card's current-state list (E1).
   * UPSERTed onto telegram_posts.reactions_top (parallel to thumbnail_url):
   * COALESCE-preserved on a non-ok poll so a transient failure does not blank a
   * working reactions list. The listing path passes the parsed array (possibly
   * []); the embed path passes undefined → no change to the stored list.
   */
  reactionsTop?: TelegramReaction[] | null;
  /** Outcome label written to telegram_posts.last_poll_status. */
  status: TelegramSnapshotStatus;
}

export async function writeTelegramSnapshot(args: WriteTelegramSnapshotArgs): Promise<void> {
  // 1. UPSERT telegram_posts — public-data, single source of truth for the post
  //    snippet + polling state across all tenants who reference it.
  //    poll_failure_count increments on non-ok, resets on ok. Idempotent on
  //    re-run (last-write-wins on the snippet + monotonic-ish state).
  const now = new Date();
  // reactions_top is jsonb. For the INSERT .values() path Drizzle serializes a
  // JS array automatically. For the UPDATE COALESCE expression we bind a JSON
  // STRING with an explicit ::jsonb cast (a raw JS array bound into a sql`` tag
  // would serialize as a Postgres array literal, not jsonb). `undefined` (embed
  // path / not threaded) → null so COALESCE preserves the stored list; an OK
  // poll with [] (reactions removed upstream) DOES overwrite — [] is non-null.
  const reactionsTop = args.reactionsTop ?? null;
  const reactionsTopJson = reactionsTop === null ? null : JSON.stringify(reactionsTop);
  await db
    .insert(telegramPosts)
    .values({
      postId: args.postId,
      channelKey: args.channelKey ?? null,
      textSnippet: args.textSnippet ?? null,
      mediaKind: args.mediaKind ?? null,
      thumbnailUrl: args.thumbnailUrl ?? null,
      reactionsTop,
      externalUrl: args.externalUrl ?? null,
      publishedAt: args.publishedAt ?? null,
      fetchedAt: now,
      lastPolledAt: now,
      lastPollStatus: args.status,
      pollFailureCount: args.status === "ok" ? 0 : 1,
    })
    .onConflictDoUpdate({
      target: telegramPosts.postId,
      set: {
        // Refresh snippet fields. COALESCE keeps a prior non-null value when the
        // caller passes null. An OK poll always carries a fresh thumbnail_url (so
        // COALESCE refreshes the hotlink); a NON-OK poll (a failed/deleted
        // refresh) carries none → COALESCE PRESERVES the last good URL instead of
        // blanking the cover (IG #69 P1-A — a transient Refresh failure must not
        // erase a working thumbnail).
        channelKey: sql`COALESCE(${args.channelKey ?? null}, ${telegramPosts.channelKey})`,
        textSnippet: sql`COALESCE(${args.textSnippet ?? null}, ${telegramPosts.textSnippet})`,
        mediaKind: sql`COALESCE(${args.mediaKind ?? null}, ${telegramPosts.mediaKind})`,
        thumbnailUrl: sql`COALESCE(${args.thumbnailUrl ?? null}, ${telegramPosts.thumbnailUrl})`,
        // reactions_top (E1): same COALESCE-preserve rule as thumbnail_url — an
        // OK poll carries the fresh top-5 (refreshes the list, [] overwrites a
        // stale one); a non-ok poll carries null → COALESCE keeps the last good
        // list instead of blanking it. jsonb cast keeps the bind typed.
        reactionsTop: sql`COALESCE(${reactionsTopJson}::jsonb, ${telegramPosts.reactionsTop})`,
        externalUrl: sql`COALESCE(${args.externalUrl ?? null}, ${telegramPosts.externalUrl})`,
        publishedAt: sql`COALESCE(${args.publishedAt ?? null}, ${telegramPosts.publishedAt})`,
        lastPolledAt: now,
        lastPollStatus: args.status,
        pollFailureCount: args.status === "ok" ? 0 : sql`${telegramPosts.pollFailureCount} + 1`,
        updatedAt: now,
      },
    });

  // 2. Snapshot row — on success AND when AT LEAST ONE metric (views OR
  //    reactions) is present. ON CONFLICT DO NOTHING makes within-the-same-minute
  //    retries idempotent. Independent of the UPSERT above (see header — no
  //    wrapping tx; a lost snapshot on a crash is a benign missing time-series
  //    point). Each column is written independently: a post with reactions but
  //    hidden views gets a row with view_count NULL + reactions_total set (and
  //    vice versa) — null is a per-metric chart GAP (D-05), never coerced to 0.
  const reactionsTotal = args.reactionsTotal ?? null;
  if (args.status === "ok" && (args.viewCount !== null || reactionsTotal !== null)) {
    await db
      .insert(telegramPostSnapshots)
      .values({
        postId: args.postId,
        polledAt: sql`date_trunc('minute', now())` as unknown as Date,
        viewCount: args.viewCount,
        reactionsTotal,
      })
      .onConflictDoNothing();
  }
}
