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
import {
  instagramAccounts,
  instagramPosts,
  instagramPostSnapshots,
} from "$lib/server/db/schema/index.js";

// `inconclusive` exists for the shared refresh lane's bounded-lookup platforms
// (Reddit); this tree never writes it but accepts the shared lane status union.
export type SnapshotStatus =
  | "ok"
  | "not_found"
  | "private"
  | "auth_error"
  | "rate_limited"
  | "inconclusive";

export interface WriteSnapshotArgs {
  /** instagram_posts.post_id — keys the UPSERT + the snapshot INSERT. */
  postId: string;
  /** Stable IG user id (the channel key). Nullable until resolveAccount runs. */
  accountId?: string | null;
  /** NormalizedPost.kind — "image" | "carousel" | "video" | "short". */
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
          // the caller passes null. An OK poll always carries a fresh
          // thumbnail_url (so COALESCE refreshes the expiring CDN URL, D-08); a
          // NON-OK poll (a failed/deleted refresh) carries none → COALESCE
          // PRESERVES the last good URL instead of blanking the cover (#69 P1-A —
          // a transient Refresh failure must not erase a working thumbnail).
          accountId: sql`COALESCE(${args.accountId ?? null}, ${instagramPosts.accountId})`,
          mediaType: sql`COALESCE(${args.mediaType ?? null}, ${instagramPosts.mediaType})`,
          caption: args.caption ?? null,
          permalink: sql`COALESCE(${args.permalink ?? null}, ${instagramPosts.permalink})`,
          thumbnailUrl: sql`COALESCE(${args.thumbnailUrl ?? null}, ${instagramPosts.thumbnailUrl})`,
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

export interface UpsertInstagramAccountArgs {
  /** instagram_accounts.account_id PK — the stable IG user id (= the channelKey
   *  / instagram_posts.account_id). Required; the row anchors on it. */
  accountId: string;
  /** Current @handle / username (without the leading '@'). A change appends the
   *  old value to handle_aliases. Nullable on a partial source. */
  username?: string | null;
  /** Upstream account name (full_name) — OUR truth, NOT data_sources.display_name. */
  fullName?: string | null;
  /** Avatar / profile-pic URL. Refreshed when present; COALESCE-preserved when null. */
  avatarUrl?: string | null;
  /** Follower count when the profile response exposed it; else null. */
  followerCount?: number | null;
}

/** UPSERT the account subject entity (instagram_accounts) from data ALREADY
 *  fetched — the source-of-truth for the account's OWN scraped metadata.
 *
 *  Two callers, ZERO additional provider credits:
 *   - resolveHandleToAccountId (the PAID create-time profile call): passes the
 *     richer fields (full_name / avatar / follower_count / username) it read off
 *     the profile response it already paid for.
 *   - the account walker (the FREE feed owner object): passes account_id +
 *     username (+ avatar when the feed owner carries one); the richer profile
 *     fields are COALESCE-preserved (a null arg keeps the prior good value), so
 *     the cheap feed refresh never blanks the metadata the profile call set.
 *
 *  - INSERT sets account_id (PK) + first_seen_at + the supplied metadata, and
 *    seeds handle_aliases with the username.
 *  - UPDATE refreshes the non-null supplied fields + last_refreshed_at, and
 *    APPENDS the username to handle_aliases when it changed (a rename —
 *    array_append only when the new username is non-null and not already present,
 *    so the list never accumulates duplicates).
 *  - COALESCE-preserve: a null field keeps the prior good value instead of
 *    blanking it (same rule as instagram_posts.thumbnail_url — a transient miss
 *    / a cheaper feed refresh must not erase richer metadata, #69 P1-A).
 *
 *  Idempotent + public-data (no userId scope; allowlisted). */
export async function upsertInstagramAccount(args: UpsertInstagramAccountArgs): Promise<void> {
  const now = new Date();
  const username = args.username ?? null;
  await db
    .insert(instagramAccounts)
    .values({
      accountId: args.accountId,
      username,
      fullName: args.fullName ?? null,
      avatarUrl: args.avatarUrl ?? null,
      followerCount: args.followerCount ?? null,
      handleAliases: username === null ? [] : [username],
      firstSeenAt: now,
      lastRefreshedAt: now,
    })
    .onConflictDoUpdate({
      target: instagramAccounts.accountId,
      set: {
        username: sql`COALESCE(${username}, ${instagramAccounts.username})`,
        fullName: sql`COALESCE(${args.fullName ?? null}, ${instagramAccounts.fullName})`,
        avatarUrl: sql`COALESCE(${args.avatarUrl ?? null}, ${instagramAccounts.avatarUrl})`,
        followerCount: sql`COALESCE(${args.followerCount ?? null}, ${instagramAccounts.followerCount})`,
        // Append the username on a rename: only when the new value is non-null AND
        // not already in the array (array_append would otherwise grow duplicates
        // on every poll). NULL username → no change.
        handleAliases: sql`CASE
          WHEN ${username}::text IS NOT NULL AND NOT (${username}::text = ANY(${instagramAccounts.handleAliases}))
          THEN array_append(${instagramAccounts.handleAliases}, ${username}::text)
          ELSE ${instagramAccounts.handleAliases}
        END`,
        lastRefreshedAt: now,
        updatedAt: now,
      },
    });
}
