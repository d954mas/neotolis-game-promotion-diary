// Idempotent per-post snapshot writer (clone of instagram/server/snapshots.ts
// with the PLAT-02 share_count delta).
//
// Two-phase, atomic across a single short db.transaction:
//   1. UPSERT tiktok_posts on aweme_id PK — refresh the snippet fields
//      (media_type, caption, permalink, thumbnail_url, published_at, account_id)
//      + polling state (last_polled_at, last_poll_status, poll_failure_count).
//      thumbnail_url is REFRESHED on every write because the TikTok CDN URL
//      expires + is signed (D-08). poll_failure_count increments on non-ok,
//      resets on 'ok'.
//   2. INSERT tiktok_post_snapshots (aweme_id, polled_at = date_trunc('minute',
//      now()), view/like/comment/SHARE) ON CONFLICT (aweme_id, polled_at) DO
//      NOTHING — within-the-minute retries collapse to one row.
//
// CRITICAL DELTA vs Instagram: `share_count` IS threaded end-to-end (the args
// type AND the INSERT). IG returns no share field in either endpoint, so its
// writer omits shares; TikTok's API exposes share_count inline (10-SPIKE.md
// finding (c)), which is exactly the PLAT-02 metric this adapter must capture.
//
// PUBLIC-DATA tables → no userId scope (allowlisted in Plan 01). Multiple tenants
// who reference the same post share one tiktok_posts row + one snapshot per
// minute.
//
// Caller owns the HTTP call (which happens OUTSIDE this tx — never hold a row
// lock while waiting on a multi-hundred-KB provider payload). This service
// expects the metrics + status as already-resolved inputs.

import { sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { tiktokAccounts, tiktokPosts, tiktokPostSnapshots } from "$lib/server/db/schema/index.js";

export type SnapshotStatus = "ok" | "not_found" | "private" | "auth_error" | "rate_limited";

export interface WriteSnapshotArgs {
  /** tiktok_posts.aweme_id — keys the UPSERT + the snapshot INSERT. */
  awemeId: string;
  /** Stable TikTok user id (the channel key). Nullable until resolveAccount runs. */
  accountId?: string | null;
  /** NormalizedPost.kind — "video" | "carousel" (D-03 TikTok media vocabulary). */
  mediaType?: string | null;
  caption?: string | null;
  permalink?: string | null;
  /** Fresh TikTok CDN URL — refreshed on every write (D-08; the URL is signed +
   *  expires). */
  thumbnailUrl?: string | null;
  /** Drives tier classification (BACK-04). */
  publishedAt?: Date | null;
  /**
   * Resolved metrics. NULL when status !== 'ok' (no snapshot row inserted; only
   * the tiktok_posts row updates its polling state). `views` is null for
   * photo-mode (carousel) posts (metrics-by-presence). `shares` is the PLAT-02
   * delta — the real share count TikTok carries inline (presence-mapped;
   * non-null on a video, stays null when absent).
   */
  metrics: {
    views: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
  } | null;
  /** Outcome label written to tiktok_posts.last_poll_status. */
  status: SnapshotStatus;
}

export async function writeSnapshot(args: WriteSnapshotArgs): Promise<void> {
  await db.transaction(async (tx) => {
    // 1. UPSERT tiktok_posts — public-data, single source of truth for the post
    //    snippet + polling state across all tenants who reference it.
    //    thumbnail_url is refreshed every write (D-08 signed/expiring CDN URL).
    //    poll_failure_count increments on non-ok, resets on ok.
    const now = new Date();
    await tx
      .insert(tiktokPosts)
      .values({
        awemeId: args.awemeId,
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
        target: tiktokPosts.awemeId,
        set: {
          // Refresh snippet fields. COALESCE keeps a prior non-null value when
          // the caller passes null. An OK poll always carries a fresh
          // thumbnail_url (so COALESCE refreshes the expiring CDN URL, D-08); a
          // NON-OK poll (a failed/deleted refresh) carries none → COALESCE
          // PRESERVES the last good URL instead of blanking the cover (a
          // transient Refresh failure must not erase a working thumbnail).
          accountId: sql`COALESCE(${args.accountId ?? null}, ${tiktokPosts.accountId})`,
          mediaType: sql`COALESCE(${args.mediaType ?? null}, ${tiktokPosts.mediaType})`,
          caption: args.caption ?? null,
          permalink: sql`COALESCE(${args.permalink ?? null}, ${tiktokPosts.permalink})`,
          thumbnailUrl: sql`COALESCE(${args.thumbnailUrl ?? null}, ${tiktokPosts.thumbnailUrl})`,
          publishedAt: sql`COALESCE(${args.publishedAt ?? null}, ${tiktokPosts.publishedAt})`,
          lastPolledAt: now,
          lastPollStatus: args.status,
          pollFailureCount: args.status === "ok" ? 0 : sql`${tiktokPosts.pollFailureCount} + 1`,
          updatedAt: now,
        },
      });

    // 2. Snapshot row — only on success. ON CONFLICT DO NOTHING makes
    //    within-the-same-minute retries idempotent. share_count is the PLAT-02
    //    column (stored when metrics.shares is non-null; null stays null —
    //    presence, not 0).
    if (args.status === "ok" && args.metrics !== null) {
      await tx
        .insert(tiktokPostSnapshots)
        .values({
          awemeId: args.awemeId,
          polledAt: sql`date_trunc('minute', now())` as unknown as Date,
          viewCount: args.metrics.views,
          likeCount: args.metrics.likes,
          commentCount: args.metrics.comments,
          shareCount: args.metrics.shares,
        })
        .onConflictDoNothing();
    }
  });
}

export interface UpsertTikTokAccountArgs {
  /** tiktok_accounts.account_id PK — the stable TikTok user id (= the channelKey
   *  / tiktok_posts.account_id). Required; the row anchors on it. */
  accountId: string;
  /** Current @handle / username (without the leading '@'). A change appends the
   *  old value to handle_aliases. Nullable on a partial source. */
  username?: string | null;
  /** Upstream account name (nickname) — OUR truth, NOT data_sources.display_name. */
  nickname?: string | null;
  /** Avatar / profile-pic URL. Refreshed when present; COALESCE-preserved when null. */
  avatarUrl?: string | null;
  /** Follower count when the profile response exposed it; else null. */
  followerCount?: number | null;
  /** TikTok's opaque secondary id (secUid) when present; else null. */
  secUid?: string | null;
}

/** UPSERT the account subject entity (tiktok_accounts) from data ALREADY
 *  fetched — the source-of-truth for the account's OWN scraped metadata.
 *
 *  Two callers, ZERO additional provider credits (mirrors upsertInstagramAccount):
 *   - resolveHandleToAccountId (the PAID create-time profile call): passes the
 *     richer fields (nickname / avatar / follower_count / username / sec_uid) it
 *     read off the profile response it already paid for.
 *   - the account walker (the FREE feed owner object): passes account_id +
 *     username (+ avatar when the owner carries one); the richer profile fields
 *     are COALESCE-preserved (a null arg keeps the prior good value), so the cheap
 *     feed refresh never blanks the metadata the profile call set.
 *
 *  - INSERT sets account_id (PK) + first_seen_at + the supplied metadata, and
 *    seeds handle_aliases with the username.
 *  - UPDATE refreshes the non-null supplied fields + last_refreshed_at, and
 *    APPENDS the username to handle_aliases when it changed (a rename —
 *    array_append only when the new username is non-null and not already present,
 *    so the list never accumulates duplicates).
 *  - COALESCE-preserve: a null field keeps the prior good value instead of
 *    blanking it (same rule as tiktok_posts.thumbnail_url — a transient miss /
 *    a cheaper feed refresh must not erase richer metadata).
 *
 *  Idempotent + public-data (no userId scope; allowlisted). */
export async function upsertTikTokAccount(args: UpsertTikTokAccountArgs): Promise<void> {
  const now = new Date();
  const username = args.username ?? null;
  await db
    .insert(tiktokAccounts)
    .values({
      accountId: args.accountId,
      username,
      nickname: args.nickname ?? null,
      avatarUrl: args.avatarUrl ?? null,
      followerCount: args.followerCount ?? null,
      secUid: args.secUid ?? null,
      handleAliases: username === null ? [] : [username],
      firstSeenAt: now,
      lastRefreshedAt: now,
    })
    .onConflictDoUpdate({
      target: tiktokAccounts.accountId,
      set: {
        username: sql`COALESCE(${username}, ${tiktokAccounts.username})`,
        nickname: sql`COALESCE(${args.nickname ?? null}, ${tiktokAccounts.nickname})`,
        avatarUrl: sql`COALESCE(${args.avatarUrl ?? null}, ${tiktokAccounts.avatarUrl})`,
        followerCount: sql`COALESCE(${args.followerCount ?? null}, ${tiktokAccounts.followerCount})`,
        secUid: sql`COALESCE(${args.secUid ?? null}, ${tiktokAccounts.secUid})`,
        // Append the username on a rename: only when the new value is non-null AND
        // not already in the array (array_append would otherwise grow duplicates
        // on every poll). NULL username → no change.
        handleAliases: sql`CASE
          WHEN ${username}::text IS NOT NULL AND NOT (${username}::text = ANY(${tiktokAccounts.handleAliases}))
          THEN array_append(${tiktokAccounts.handleAliases}, ${username}::text)
          ELSE ${tiktokAccounts.handleAliases}
        END`,
        lastRefreshedAt: now,
        updatedAt: now,
      },
    });
}
