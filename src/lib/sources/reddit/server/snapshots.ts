// Idempotent per-post snapshot writer for Reddit (clone of twitter/server/
// snapshots.ts with the D-09 raw-column delta + the ★write-path deletion-detect +
// the TWO Reddit subject-entity upserts).
//
// Two-phase, atomic across a single short db.transaction:
//   1. UPSERT reddit_posts on post_id PK — refresh the snippet fields
//      (subreddit_slug, media_type, title, caption, permalink, thumbnail_url,
//      published_at, author, author_fullname) + polling state (last_polled_at,
//      last_poll_status, poll_failure_count). Every snippet field is
//      COALESCE-preserved on a null (a failed refresh must not blank a working
//      value — same rule twitter_posts.thumbnail_url follows). poll_failure_count
//      increments on non-ok, resets on 'ok'.
//   2. INSERT reddit_post_snapshots (post_id, polled_at = date_trunc('minute',
//      now()), like_count=score, comment_count=num_comments + the RAW D-09 columns
//      score/upvote_ratio/num_comments/num_crossposts/removed_by_category) ON
//      CONFLICT (post_id, polled_at) DO NOTHING — within-the-minute retries collapse
//      to one row.
//
// ★ WRITE-PATH DELETION-DETECT (D-06 belt): when a snapshot's `removed_by_category`
// is non-null, set reddit_posts.deletion_detected_at = NOW() ONLY if it is currently
// NULL (idempotent, first-detect only — a re-appearing post does not reset the grace
// clock the Plan 05 purge cron acts on). NOTE (12-SPIKE): ScrapeCreators NEVER
// returns removed_by_category, so this belt is DORMANT in production — the REAL
// primary deletion mechanism is Variant A (disappearance-from-walk) landing in Plan
// 05's walker + purge cron. This write-path belt stays as a unit-level guarantee
// (the integration test feeds a synthetic snapshot with the field set).
//
// D-09 metric mapping: like_count = score, comment_count = num_comments; views +
// shares are ABSENT (Reddit exposes no per-post views; num_crossposts absent from
// the response) so there are NO view/share columns. The raw D-09 columns are stored
// verbatim so the history stays reconstructable without a re-fetch.
//
// PUBLIC-DATA tables → no userId scope (allowlisted in Plan 02). Multiple tenants
// who reference the same post share one reddit_posts row + one snapshot per minute.
//
// Caller owns the HTTP call (which happens OUTSIDE this tx — never hold a row lock
// while waiting on a provider payload). This service expects the metrics + status
// as already-resolved inputs.

import { sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import {
  redditAccounts,
  redditPosts,
  redditPostSnapshots,
  redditSubreddits,
} from "$lib/server/db/schema/index.js";

export type SnapshotStatus = "ok" | "not_found" | "private" | "auth_error" | "rate_limited";

export interface WriteSnapshotArgs {
  /** reddit_posts.post_id — the t3_<base36> fullname. Keys the UPSERT + the snapshot
   *  INSERT. */
  postId: string;
  /** Lowercase intrinsic subreddit slug (the safe denorm). Nullable until resolved. */
  subredditSlug?: string | null;
  /** reddit_posts.media_type — the richer Reddit FORM ("self"|"link"|"image"|
   *  "gallery"), derived by the Plan 03 normalizer. */
  mediaType?: string | null;
  /** The post title (reddit_posts.title). */
  title?: string | null;
  /** The self-post body excerpt (reddit_posts.caption — null for link/image posts). */
  caption?: string | null;
  permalink?: string | null;
  /** The Reddit CDN cover URL (i.redd.it). COALESCE-preserved on null. Frequently
   *  null — ScrapeCreators omits `thumbnail`, so the normalizer derives it by
   *  presence (image posts → url, else null). */
  thumbnailUrl?: string | null;
  /** Drives tier classification (BACK-04). */
  publishedAt?: Date | null;
  /** The Reddit username (reddit_posts.author — PURGED to null by the Plan 05
   *  deletion cron). COALESCE-preserved on null. */
  author?: string | null;
  /** The stable `t2_` id (reddit_posts.author_fullname — also purged). */
  authorFullname?: string | null;
  /**
   * Resolved cross-source metrics. NULL when status !== 'ok' (no snapshot row
   * inserted; only the reddit_posts row updates its polling state). Each metric is
   * presence-mapped: an absent upstream field is null, never 0. views + shares are
   * ABSENT for Reddit (D-09) so only likes + comments ride here.
   */
  metrics: {
    likes: number | null;
    comments: number | null;
  } | null;
  /**
   * D-09 RAW COLUMNS — the platform-owned fields retained verbatim beyond the
   * normalized like/comment so the history stays reconstructable. All
   * presence-mapped (null when the upstream field was absent). `removedByCategory`
   * drives the ★write-path deletion-detect belt. Only used when status === 'ok'
   * (alongside metrics). Optional — a non-ok poll omits it.
   */
  raw?: {
    score: number | null;
    upvoteRatio: number | null;
    numComments: number | null;
    numCrossposts: number | null;
    removedByCategory: string | null;
  } | null;
  /** Outcome label written to reddit_posts.last_poll_status. */
  status: SnapshotStatus;
}

export async function writeSnapshot(args: WriteSnapshotArgs): Promise<void> {
  // ★ Write-path deletion-detect belt: the removed_by_category field being present
  //   marks the post as removed. Dormant with ScrapeCreators (never returns it) —
  //   the live mechanism is Variant A (Plan 05). first-detect only (COALESCE below).
  const detectDeletion = args.raw?.removedByCategory != null;
  const now = new Date();
  await db.transaction(async (tx) => {
    // 1. UPSERT reddit_posts — public-data, single source of truth for the post
    //    snippet + polling state across all tenants who reference it. Every snippet
    //    field is COALESCE-preserved on null (a failed/removed refresh must not erase
    //    working public data). poll_failure_count increments on non-ok, resets on ok.
    await tx
      .insert(redditPosts)
      .values({
        postId: args.postId,
        subredditSlug: args.subredditSlug ?? null,
        mediaType: args.mediaType ?? null,
        title: args.title ?? null,
        caption: args.caption ?? null,
        permalink: args.permalink ?? null,
        thumbnailUrl: args.thumbnailUrl ?? null,
        publishedAt: args.publishedAt ?? null,
        author: args.author ?? null,
        authorFullname: args.authorFullname ?? null,
        // First-detect on INSERT: set now iff the belt fired this write.
        deletionDetectedAt: detectDeletion ? now : null,
        fetchedAt: now,
        lastPolledAt: now,
        lastPollStatus: args.status,
        pollFailureCount: args.status === "ok" ? 0 : 1,
      })
      .onConflictDoUpdate({
        target: redditPosts.postId,
        set: {
          subredditSlug: sql`COALESCE(${args.subredditSlug ?? null}, ${redditPosts.subredditSlug})`,
          mediaType: sql`COALESCE(${args.mediaType ?? null}, ${redditPosts.mediaType})`,
          title: sql`COALESCE(${args.title ?? null}, ${redditPosts.title})`,
          caption: sql`COALESCE(${args.caption ?? null}, ${redditPosts.caption})`,
          permalink: sql`COALESCE(${args.permalink ?? null}, ${redditPosts.permalink})`,
          thumbnailUrl: sql`COALESCE(${args.thumbnailUrl ?? null}, ${redditPosts.thumbnailUrl})`,
          publishedAt: sql`COALESCE(${args.publishedAt ?? null}, ${redditPosts.publishedAt})`,
          author: sql`COALESCE(${args.author ?? null}, ${redditPosts.author})`,
          authorFullname: sql`COALESCE(${args.authorFullname ?? null}, ${redditPosts.authorFullname})`,
          // ★ Variant-A CLEAR-ON-REAPPEAR (12-SPIKE): a post that is currently ALIVE
          //   in the feed (removed_by_category null ⇒ !detectDeletion) has its
          //   deletion_detected_at CLEARED back to NULL. This makes the disappearance
          //   detector self-correcting — a post falsely flagged by a transient walk gap
          //   that reappears in a later walk is un-flagged BEFORE the 48h grace elapses,
          //   so ONLY posts that stay gone ≥48h are purged. When the removed belt DOES
          //   fire, COALESCE keeps a prior detection timestamp (idempotent first-detect —
          //   the grace clock never resets).
          deletionDetectedAt: detectDeletion
            ? sql`COALESCE(${redditPosts.deletionDetectedAt}, ${now})`
            : sql`NULL`,
          lastPolledAt: now,
          lastPollStatus: args.status,
          pollFailureCount: args.status === "ok" ? 0 : sql`${redditPosts.pollFailureCount} + 1`,
          updatedAt: now,
        },
      });

    // 2. Snapshot row — only on success. ON CONFLICT DO NOTHING makes
    //    within-the-same-minute retries idempotent. like_count=score,
    //    comment_count=num_comments (D-09); the raw D-09 columns are stored verbatim
    //    (null stays null — presence, not 0).
    if (args.status === "ok" && args.metrics !== null) {
      await tx
        .insert(redditPostSnapshots)
        .values({
          postId: args.postId,
          polledAt: sql`date_trunc('minute', now())` as unknown as Date,
          likeCount: args.metrics.likes,
          commentCount: args.metrics.comments,
          score: args.raw?.score ?? null,
          upvoteRatio: args.raw?.upvoteRatio ?? null,
          numComments: args.raw?.numComments ?? null,
          numCrossposts: args.raw?.numCrossposts ?? null,
          removedByCategory: args.raw?.removedByCategory ?? null,
        })
        .onConflictDoNothing();
    }
  });
}

export interface UpsertRedditAccountArgs {
  /** reddit_accounts.username PK — the LOWERCASE immutable Reddit username (part of
   *  the canonical profile URL, the safe denormalization + the author-walk join
   *  key). The caller passes any casing; we lowercase-canonicalize here. */
  username: string;
  /** Upstream Reddit display name / "About" title — OUR truth, NOT a denorm of
   *  data_sources.display_name. COALESCE-preserved when null. */
  title?: string | null;
  /** Avatar / profile-icon URL. Refreshed when present; COALESCE-preserved when null. */
  iconUrl?: string | null;
  /** Total karma when the response exposed it; else null. */
  karma?: number | null;
  /** Follower count when exposed; else null. */
  followerCount?: number | null;
}

/** UPSERT the account subject entity (reddit_accounts) from data ALREADY fetched —
 *  the source-of-truth for the account's OWN scraped metadata. Keyed on the
 *  lowercase username (immutable, rename-proof — Reddit forbids username rename and
 *  it is part of the canonical URL, so unlike twitter_accounts there is NO
 *  handle_aliases history to maintain).
 *
 *  COALESCE-preserve: a null field keeps the prior good value instead of blanking it
 *  (same rule as reddit_posts.thumbnail_url — a transient miss / a cheaper feed
 *  refresh must not erase richer metadata a fuller parse set).
 *
 *  Idempotent + public-data (no userId scope; allowlisted). */
export async function upsertRedditAccount(args: UpsertRedditAccountArgs): Promise<void> {
  const now = new Date();
  const username = args.username.toLowerCase();
  await db
    .insert(redditAccounts)
    .values({
      username,
      title: args.title ?? null,
      iconUrl: args.iconUrl ?? null,
      karma: args.karma ?? null,
      followerCount: args.followerCount ?? null,
      firstSeenAt: now,
      lastRefreshedAt: now,
    })
    .onConflictDoUpdate({
      target: redditAccounts.username,
      set: {
        title: sql`COALESCE(${args.title ?? null}, ${redditAccounts.title})`,
        iconUrl: sql`COALESCE(${args.iconUrl ?? null}, ${redditAccounts.iconUrl})`,
        karma: sql`COALESCE(${args.karma ?? null}, ${redditAccounts.karma})`,
        followerCount: sql`COALESCE(${args.followerCount ?? null}, ${redditAccounts.followerCount})`,
        lastRefreshedAt: now,
        updatedAt: now,
      },
    });
}

export interface UpsertRedditSubredditArgs {
  /** reddit_subreddits.slug PK — the LOWERCASE subreddit slug (Reddit forbids
   *  subreddit rename, the slug is part of the canonical URL → the safe
   *  denormalization + the walk join key). Any casing accepted; lowercased here. */
  slug: string;
  /** Upstream subreddit "About" title — OUR truth, NOT a denorm of
   *  data_sources.display_name. COALESCE-preserved when null. */
  title?: string | null;
  /** Subscriber count when exposed (spike: null-valued on the sampled pages); else
   *  null. */
  subscriberCount?: number | null;
  /** Subreddit icon URL. Refreshed when present; COALESCE-preserved when null. */
  iconUrl?: string | null;
}

/** UPSERT the subreddit subject entity (reddit_subreddits) from data ALREADY
 *  fetched. Keyed on the lowercase slug (rename-proof). COALESCE-preserve on a
 *  partial parse (same rule as upsertRedditAccount).
 *
 *  Idempotent + public-data (no userId scope; allowlisted). */
export async function upsertRedditSubreddit(args: UpsertRedditSubredditArgs): Promise<void> {
  const now = new Date();
  const slug = args.slug.toLowerCase();
  await db
    .insert(redditSubreddits)
    .values({
      slug,
      title: args.title ?? null,
      subscriberCount: args.subscriberCount ?? null,
      iconUrl: args.iconUrl ?? null,
      firstSeenAt: now,
      lastRefreshedAt: now,
    })
    .onConflictDoUpdate({
      target: redditSubreddits.slug,
      set: {
        title: sql`COALESCE(${args.title ?? null}, ${redditSubreddits.title})`,
        subscriberCount: sql`COALESCE(${args.subscriberCount ?? null}, ${redditSubreddits.subscriberCount})`,
        iconUrl: sql`COALESCE(${args.iconUrl ?? null}, ${redditSubreddits.iconUrl})`,
        lastRefreshedAt: now,
        updatedAt: now,
      },
    });
}
