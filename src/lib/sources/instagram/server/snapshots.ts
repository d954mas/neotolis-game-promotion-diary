// Idempotent per-post snapshot writer (mirrors youtube/server/snapshots.ts).
//
// Two-phase, atomic across a single short db.transaction:
//   1. UPSERT instagram_posts on post_id PK — refresh the snippet fields
//      (media_type, caption, permalink, thumbnail_url, published_at, account_id)
//      + polling state (last_polled_at, last_poll_status, poll_failure_count).
//      thumbnail_url is REFRESHED on every write because the IG CDN URL expires
//      (D-08). poll_failure_count increments on non-ok, resets on 'ok'.
//   2. INSERT instagram_post_snapshots (post_id, polled_at = date_trunc('minute',
//      now()), view/like/comment) ON CONFLICT (post_id, polled_at) DO NOTHING —
//      within-the-minute retries collapse to one row.
//
// PUBLIC-DATA tables → no userId scope (allowlisted in Plan 01). Multiple
// tenants who reference the same post share one instagram_posts row + one
// snapshot per minute.
//
// Caller owns the HTTP call (which happens OUTSIDE this tx — never hold a row
// lock while waiting on a multi-hundred-KB provider payload). This service
// expects the metrics + status as already-resolved inputs.

import { sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { instagramPosts, instagramPostSnapshots } from "$lib/server/db/schema/index.js";

export type SnapshotStatus = "ok" | "not_found" | "private" | "auth_error" | "rate_limited";

export interface WriteSnapshotArgs {
  /** instagram_posts.post_id — keys the UPSERT + the snapshot INSERT. */
  postId: string;
  /** Stable IG user id (the channel key). Nullable until resolveAccount runs. */
  accountId?: string | null;
  /** NormalizedPost.kind — "image" | "carousel" | "video" | "reel". */
  mediaType?: string | null;
  caption?: string | null;
  permalink?: string | null;
  /** Fresh IG CDN URL — refreshed on every write (D-08; the URL expires). */
  thumbnailUrl?: string | null;
  /** Drives tier classification (BACK-04). */
  publishedAt?: Date | null;
  /**
   * Resolved metrics. NULL when status !== 'ok' (no snapshot row inserted; only
   * the instagram_posts row updates its polling state). `views` is null for
   * photos/carousels (D-05); `shares` is never stored (D-04 — no column).
   */
  metrics: { views: number | null; likes: number | null; comments: number | null } | null;
  /** Outcome label written to instagram_posts.last_poll_status. */
  status: SnapshotStatus;
}

export async function writeSnapshot(args: WriteSnapshotArgs): Promise<void> {
  await db.transaction(async (tx) => {
    // 1. UPSERT instagram_posts — public-data, single source of truth for the
    //    post snippet + polling state across all tenants who reference it.
    //    thumbnail_url is refreshed every write (D-08 expiring CDN URL).
    //    poll_failure_count increments on non-ok, resets on ok.
    const now = new Date();
    await tx
      .insert(instagramPosts)
      .values({
        postId: args.postId,
        accountId: args.accountId ?? null,
        mediaType: args.mediaType ?? null,
        caption: args.caption ?? null,
        permalink: args.permalink ?? null,
        thumbnailUrl: args.thumbnailUrl ?? null,
        publishedAt: args.publishedAt ?? null,
        fetchedAt: now,
        lastPolledAt: now,
        lastPollStatus: args.status,
        pollFailureCount: args.status === "ok" ? 0 : 1,
      })
      .onConflictDoUpdate({
        target: instagramPosts.postId,
        set: {
          // Refresh snippet fields. COALESCE keeps a prior non-null value when
          // the caller passes null (e.g. a metrics-only re-poll that did not
          // re-resolve the account id), but ALWAYS refreshes thumbnail_url —
          // the expiring CDN URL must reflect the latest poll.
          accountId: sql`COALESCE(${args.accountId ?? null}, ${instagramPosts.accountId})`,
          mediaType: sql`COALESCE(${args.mediaType ?? null}, ${instagramPosts.mediaType})`,
          caption: args.caption ?? null,
          permalink: sql`COALESCE(${args.permalink ?? null}, ${instagramPosts.permalink})`,
          thumbnailUrl: args.thumbnailUrl ?? null,
          publishedAt: sql`COALESCE(${args.publishedAt ?? null}, ${instagramPosts.publishedAt})`,
          lastPolledAt: now,
          lastPollStatus: args.status,
          pollFailureCount: args.status === "ok" ? 0 : sql`${instagramPosts.pollFailureCount} + 1`,
          updatedAt: now,
        },
      });

    // 2. Snapshot row — only on success. ON CONFLICT DO NOTHING makes
    //    within-the-same-minute retries idempotent.
    if (args.status === "ok" && args.metrics !== null) {
      await tx
        .insert(instagramPostSnapshots)
        .values({
          postId: args.postId,
          polledAt: sql`date_trunc('minute', now())` as unknown as Date,
          viewCount: args.metrics.views,
          likeCount: args.metrics.likes,
          commentCount: args.metrics.comments,
        })
        .onConflictDoNothing();
    }
  });
}
