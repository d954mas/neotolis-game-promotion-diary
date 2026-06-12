// Idempotent per-tweet snapshot writer (clone of tiktok/server/snapshots.ts with
// the D-05 raw-component delta).
//
// Two-phase, atomic across a single short db.transaction:
//   1. UPSERT twitter_posts on tweet_id PK — refresh the snippet fields
//      (media_type, caption, permalink, thumbnail_url, published_at, account_id)
//      + polling state (last_polled_at, last_poll_status, poll_failure_count).
//      thumbnail_url is COALESCE-preserved on a null (a failed refresh must not
//      blank a working pbs.twimg.com cover). poll_failure_count increments on
//      non-ok, resets on 'ok'.
//   2. INSERT twitter_post_snapshots (tweet_id, polled_at = date_trunc('minute',
//      now()), view/like/comment/SHARE + the raw retweet/quote/bookmark) ON
//      CONFLICT (tweet_id, polled_at) DO NOTHING — within-the-minute retries
//      collapse to one row.
//
// CRITICAL DELTA vs TikTok (D-05): the normalized `shareCount` is the DERIVED
// retweet+quote sum (computed by the Plan 02 normalizer), AND the snapshot stores
// the RAW retweet_count / quote_count / bookmark_count components alongside it. The
// args type carries `metrics.shares` (the derived sum) PLUS `rawComponents`
// (the three raw fields the walker reads off the same tweet via
// tweetRawComponents). Storing the raw components keeps the shares split (retweets
// vs quotes) reconstructable later and never loses bookmarks (a Twitter-specific
// signal with no slot in the shared view/like/comment/share shape).
//
// PUBLIC-DATA tables → no userId scope (allowlisted in Plan 01). Multiple tenants
// who reference the same tweet share one twitter_posts row + one snapshot per
// minute.
//
// Caller owns the HTTP call (which happens OUTSIDE this tx — never hold a row lock
// while waiting on a provider payload). This service expects the metrics + status
// as already-resolved inputs.

import { sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { twitterAccounts, twitterPosts, twitterPostSnapshots } from "$lib/server/db/schema/index.js";

export type SnapshotStatus = "ok" | "not_found" | "private" | "auth_error" | "rate_limited";

export interface WriteSnapshotArgs {
  /** twitter_posts.tweet_id — keys the UPSERT + the snapshot INSERT. */
  tweetId: string;
  /** Stable Twitter/X numeric account id (the channel key). Nullable until
   *  resolveAccount runs. */
  accountId?: string | null;
  /** NormalizedPost.kind mapped to the twitter_posts.media_type form
   *  ("video" for a native-video tweet, "image"/"text" otherwise — D-06). */
  mediaType?: string | null;
  caption?: string | null;
  permalink?: string | null;
  /** pbs.twimg.com cover (photo or video poster). COALESCE-preserved on null. */
  thumbnailUrl?: string | null;
  /** Drives tier classification (BACK-04). */
  publishedAt?: Date | null;
  /**
   * Resolved metrics. NULL when status !== 'ok' (no snapshot row inserted; only the
   * twitter_posts row updates its polling state). Each metric is presence-mapped:
   * an absent upstream field is null, never 0. `shares` is the DERIVED
   * retweet+quote sum (D-05 — the central Twitter delta vs TikTok's single
   * share_count field).
   */
  metrics: {
    views: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
  } | null;
  /**
   * D-05 RAW COMPONENTS — the retweet/quote/bookmark counts retained beyond the
   * derived shares sum so the split stays reconstructable and bookmarks are never
   * lost. All presence-mapped (null when the upstream field was absent). Only used
   * when status === 'ok' (alongside metrics). Optional — a non-ok poll omits it.
   */
  rawComponents?: {
    retweetCount: number | null;
    quoteCount: number | null;
    bookmarkCount: number | null;
  } | null;
  /** Outcome label written to twitter_posts.last_poll_status. */
  status: SnapshotStatus;
}

export async function writeSnapshot(args: WriteSnapshotArgs): Promise<void> {
  await db.transaction(async (tx) => {
    // 1. UPSERT twitter_posts — public-data, single source of truth for the tweet
    //    snippet + polling state across all tenants who reference it.
    //    thumbnail_url is COALESCE-preserved on null (a failed/deleted refresh must
    //    not erase a working cover). poll_failure_count increments on non-ok,
    //    resets on ok.
    const now = new Date();
    await tx
      .insert(twitterPosts)
      .values({
        tweetId: args.tweetId,
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
        target: twitterPosts.tweetId,
        set: {
          // Refresh snippet fields. COALESCE keeps a prior non-null value when the
          // caller passes null — an OK poll always carries the fresh fields; a
          // NON-OK poll (a failed refresh) carries none → COALESCE PRESERVES the
          // last good values instead of blanking them.
          accountId: sql`COALESCE(${args.accountId ?? null}, ${twitterPosts.accountId})`,
          mediaType: sql`COALESCE(${args.mediaType ?? null}, ${twitterPosts.mediaType})`,
          caption: args.caption ?? null,
          permalink: sql`COALESCE(${args.permalink ?? null}, ${twitterPosts.permalink})`,
          thumbnailUrl: sql`COALESCE(${args.thumbnailUrl ?? null}, ${twitterPosts.thumbnailUrl})`,
          publishedAt: sql`COALESCE(${args.publishedAt ?? null}, ${twitterPosts.publishedAt})`,
          lastPolledAt: now,
          lastPollStatus: args.status,
          pollFailureCount: args.status === "ok" ? 0 : sql`${twitterPosts.pollFailureCount} + 1`,
          updatedAt: now,
        },
      });

    // 2. Snapshot row — only on success. ON CONFLICT DO NOTHING makes
    //    within-the-same-minute retries idempotent. share_count is the DERIVED
    //    retweet+quote sum; retweet/quote/bookmark are the D-05 raw components
    //    (stored when present; null stays null — presence, not 0).
    if (args.status === "ok" && args.metrics !== null) {
      await tx
        .insert(twitterPostSnapshots)
        .values({
          tweetId: args.tweetId,
          polledAt: sql`date_trunc('minute', now())` as unknown as Date,
          viewCount: args.metrics.views,
          likeCount: args.metrics.likes,
          commentCount: args.metrics.comments,
          shareCount: args.metrics.shares,
          retweetCount: args.rawComponents?.retweetCount ?? null,
          quoteCount: args.rawComponents?.quoteCount ?? null,
          bookmarkCount: args.rawComponents?.bookmarkCount ?? null,
        })
        .onConflictDoNothing();
    }
  });
}

export interface UpsertTwitterAccountArgs {
  /** twitter_accounts.account_id PK — the stable Twitter/X numeric user id (= the
   *  channelKey / twitter_posts.account_id). Required; the row anchors on it. */
  accountId: string;
  /** Current @handle / username (without the leading '@'). A change appends the old
   *  value to handle_aliases. Nullable on a partial source. */
  username?: string | null;
  /** Upstream display name — OUR truth, NOT data_sources.display_name. */
  name?: string | null;
  /** Avatar / profile-pic URL. Refreshed when present; COALESCE-preserved when null. */
  avatarUrl?: string | null;
  /** Follower count when the profile response exposed it; else null. */
  followerCount?: number | null;
}

/** UPSERT the account subject entity (twitter_accounts) from data ALREADY fetched —
 *  the source-of-truth for the account's OWN scraped metadata.
 *
 *  Two callers, ZERO additional provider credits (mirrors upsertTikTokAccount):
 *   - resolveHandleToAccountId (the PAID create-time profile call): passes the
 *     richer fields (name / avatar / follower_count / username) it read off the
 *     profile response it already paid for.
 *   - the account walker (the FREE feed owner object): passes account_id + username
 *     (+ avatar when the owner carries one); the richer profile fields are
 *     COALESCE-preserved (a null arg keeps the prior good value), so the cheap feed
 *     refresh never blanks the metadata the profile call set.
 *
 *  - INSERT sets account_id (PK) + first_seen_at + the supplied metadata, and seeds
 *    handle_aliases with the username.
 *  - UPDATE refreshes the non-null supplied fields + last_refreshed_at, and APPENDS
 *    the username to handle_aliases when it changed (a rename — array_append only
 *    when the new username is non-null and not already present, so the list never
 *    accumulates duplicates).
 *  - COALESCE-preserve: a null field keeps the prior good value instead of blanking
 *    it (same rule as twitter_posts.thumbnail_url — a transient miss / a cheaper
 *    feed refresh must not erase richer metadata).
 *
 *  Twitter/X has NO secUid-equivalent secondary id (unlike tiktok_accounts) — the
 *  numeric account id is the only key, so there is no sec_uid arg.
 *
 *  Idempotent + public-data (no userId scope; allowlisted). */
export async function upsertTwitterAccount(args: UpsertTwitterAccountArgs): Promise<void> {
  const now = new Date();
  const username = args.username ?? null;
  await db
    .insert(twitterAccounts)
    .values({
      accountId: args.accountId,
      username,
      name: args.name ?? null,
      avatarUrl: args.avatarUrl ?? null,
      followerCount: args.followerCount ?? null,
      handleAliases: username === null ? [] : [username],
      firstSeenAt: now,
      lastRefreshedAt: now,
    })
    .onConflictDoUpdate({
      target: twitterAccounts.accountId,
      set: {
        username: sql`COALESCE(${username}, ${twitterAccounts.username})`,
        name: sql`COALESCE(${args.name ?? null}, ${twitterAccounts.name})`,
        avatarUrl: sql`COALESCE(${args.avatarUrl ?? null}, ${twitterAccounts.avatarUrl})`,
        followerCount: sql`COALESCE(${args.followerCount ?? null}, ${twitterAccounts.followerCount})`,
        // Append the username on a rename: only when the new value is non-null AND
        // not already in the array (array_append would otherwise grow duplicates on
        // every poll). NULL username → no change.
        handleAliases: sql`CASE
          WHEN ${username}::text IS NOT NULL AND NOT (${username}::text = ANY(${twitterAccounts.handleAliases}))
          THEN array_append(${twitterAccounts.handleAliases}, ${username}::text)
          ELSE ${twitterAccounts.handleAliases}
        END`,
        lastRefreshedAt: now,
        updatedAt: now,
      },
    });
}
