// Idempotent per-post snapshot writer for Telegram (mirrors
// instagram/server/snapshots.ts, stripped to VIEWS-ONLY — Telegram exposes
// only a view count on the public t.me/s surface, no likes/comments/shares,
// D-04 → no like/comment columns).
//
// Two-phase, atomic across a single short db.transaction:
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
// Caller owns the HTTP call (which happens OUTSIDE this tx — never hold a row
// lock while waiting on a t.me payload). This service expects the metrics +
// status as already-resolved inputs.

import { sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { telegramPosts, telegramPostSnapshots } from "$lib/server/db/schema/index.js";

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
   * Resolved view count. NULL → no snapshot row (views absent — very new post
   * or views disabled), but the telegram_posts row still updates its polling
   * state.
   */
  viewCount: number | null;
  /** Outcome label written to telegram_posts.last_poll_status. */
  status: TelegramSnapshotStatus;
}

export async function writeTelegramSnapshot(args: WriteTelegramSnapshotArgs): Promise<void> {
  await db.transaction(async (tx) => {
    // 1. UPSERT telegram_posts — public-data, single source of truth for the
    //    post snippet + polling state across all tenants who reference it.
    //    poll_failure_count increments on non-ok, resets on ok.
    const now = new Date();
    await tx
      .insert(telegramPosts)
      .values({
        postId: args.postId,
        channelKey: args.channelKey ?? null,
        textSnippet: args.textSnippet ?? null,
        mediaKind: args.mediaKind ?? null,
        thumbnailUrl: args.thumbnailUrl ?? null,
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
          // Refresh snippet fields. COALESCE keeps a prior non-null value when
          // the caller passes null. An OK poll always carries a fresh
          // thumbnail_url (so COALESCE refreshes the hotlink); a NON-OK poll (a
          // failed/deleted refresh) carries none → COALESCE PRESERVES the last
          // good URL instead of blanking the cover (IG #69 P1-A — a transient
          // Refresh failure must not erase a working thumbnail).
          channelKey: sql`COALESCE(${args.channelKey ?? null}, ${telegramPosts.channelKey})`,
          textSnippet: sql`COALESCE(${args.textSnippet ?? null}, ${telegramPosts.textSnippet})`,
          mediaKind: sql`COALESCE(${args.mediaKind ?? null}, ${telegramPosts.mediaKind})`,
          thumbnailUrl: sql`COALESCE(${args.thumbnailUrl ?? null}, ${telegramPosts.thumbnailUrl})`,
          externalUrl: sql`COALESCE(${args.externalUrl ?? null}, ${telegramPosts.externalUrl})`,
          publishedAt: sql`COALESCE(${args.publishedAt ?? null}, ${telegramPosts.publishedAt})`,
          lastPolledAt: now,
          lastPollStatus: args.status,
          pollFailureCount: args.status === "ok" ? 0 : sql`${telegramPosts.pollFailureCount} + 1`,
          updatedAt: now,
        },
      });

    // 2. Snapshot row — only on success AND when views are present. ON CONFLICT
    //    DO NOTHING makes within-the-same-minute retries idempotent.
    if (args.status === "ok" && args.viewCount !== null) {
      await tx
        .insert(telegramPostSnapshots)
        .values({
          postId: args.postId,
          polledAt: sql`date_trunc('minute', now())` as unknown as Date,
          viewCount: args.viewCount,
        })
        .onConflictDoNothing();
    }
  });
}
