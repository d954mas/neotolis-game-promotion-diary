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
//      increments on non-ok, resets on 'ok'. Author fields are the one explicit
//      nulling exception when raw.authorDeleted confirms Reddit's `[deleted]`
//      tombstone while the post itself remains reachable.
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

// `inconclusive` = a PAID bounded lookup (Refresh-Now resolves the post from the
// subreddit's page 1 — ScrapeCreators has no lookup-by-id) that did not find the post.
// NOT deletion evidence: it stamps polling state so the attempt is visible and the
// button settles, but never inserts a metrics row and never starts the deletion clock.
export type SnapshotStatus =
  | "ok"
  | "not_found"
  | "private"
  | "auth_error"
  | "rate_limited"
  | "inconclusive";

export interface WriteSnapshotArgs {
  /** reddit_posts.post_id — the t3_<base36> fullname. Keys the UPSERT + the snapshot
   *  INSERT. */
  postId: string;
  /** Lowercase intrinsic subreddit slug (the safe denorm). Nullable until resolved. */
  subredditSlug?: string | null;
  /** reddit_posts.media_type — the richer Reddit FORM ("self"|"link"|"image"|
   *  "gallery"), derived by the Plan 03 normalizer. */
  mediaType?: string | null;
  /** Outbound destination domain (reddit_posts.link_domain) — LINK posts only.
   *  Intrinsic immutable post content (domain only, never the full URL).
   *  COALESCE-preserved on null, same rule as the other snippet fields. */
  linkDomain?: string | null;
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
   *  deletion cron). COALESCE-preserved on an ordinary null; explicitly cleared
   *  when raw.authorDeleted confirms the account tombstone. */
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
    authorDeleted?: boolean;
  } | null;
  /** Outcome label written to reddit_posts.last_poll_status. */
  status: SnapshotStatus;
}

export async function writeSnapshot(args: WriteSnapshotArgs): Promise<void> {
  // ★ Write-path deletion-detect belt: the removed_by_category field being present
  //   marks the POST as removed. An author tombstone is separate: Reddit can keep the
  //   post public after its author deletes their account, so that signal only clears
  //   author identity below and must not start the post-deletion clock.
  const detectDeletion = args.raw?.removedByCategory != null;
  const authorDeleted = args.raw?.authorDeleted === true;
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
        linkDomain: args.linkDomain ?? null,
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
          linkDomain: sql`COALESCE(${args.linkDomain ?? null}, ${redditPosts.linkDomain})`,
          title: sql`COALESCE(${args.title ?? null}, ${redditPosts.title})`,
          caption: sql`COALESCE(${args.caption ?? null}, ${redditPosts.caption})`,
          permalink: sql`COALESCE(${args.permalink ?? null}, ${redditPosts.permalink})`,
          thumbnailUrl: sql`COALESCE(${args.thumbnailUrl ?? null}, ${redditPosts.thumbnailUrl})`,
          publishedAt: sql`COALESCE(${args.publishedAt ?? null}, ${redditPosts.publishedAt})`,
          // ★ GDPR author FREEZE (review fix): once a post is flagged deleted
          //   (deletion_detected_at set), the author identity is FROZEN — never
          //   restored/overwritten by a later snapshot. Otherwise a CROSS-SUBJECT
          //   write rehydrates the purged identity: an author-deleted post that is
          //   still alive in some subreddit's feed carries a non-null author, and
          //   the plain COALESCE would resurrect the `author`/`author_fullname` the
          //   Plan-05 purge cron already nulled — while deletion_detected_at stays
          //   set. The subject-scoped clearReappearedDeletions (walk-core) is the
          //   ONLY un-flag path; only after IT clears the flag does the normal
          //   COALESCE-preserve resume (next tick). During the grace window (flag
          //   set, author still present) freezing is a no-op — the value is kept.
          author: authorDeleted
            ? null
            : sql`CASE WHEN ${redditPosts.deletionDetectedAt} IS NOT NULL THEN ${redditPosts.author} ELSE COALESCE(${args.author ?? null}, ${redditPosts.author}) END`,
          authorFullname: authorDeleted
            ? null
            : sql`CASE WHEN ${redditPosts.deletionDetectedAt} IS NOT NULL THEN ${redditPosts.authorFullname} ELSE COALESCE(${args.authorFullname ?? null}, ${redditPosts.authorFullname}) END`,
          // ★ The write path NEVER CLEARS deletion_detected_at (12-SPIKE + review fix).
          //   reddit_posts is ONE shared row per post, but "deleted" is subject-relative
          //   (an author-deleted post is still alive in its subreddit's feed). A blanket
          //   ok-write clear here let a subreddit walk wipe the author walk's 48h GDPR
          //   purge clock. Clearing now lives ONLY in the subject-scoped reconcile
          //   (walk-core clearReappearedDeletions), which un-flags a post ONLY when the
          //   SAME subject that set the flag re-sights it. The write path only SETS
          //   (first-detect) via the removed_by_category belt: COALESCE keeps the
          //   earliest timestamp (idempotent); every other write leaves it untouched.
          deletionDetectedAt: detectDeletion
            ? sql`COALESCE(${redditPosts.deletionDetectedAt}, ${now})`
            : sql`${redditPosts.deletionDetectedAt}`,
          lastPolledAt: now,
          lastPollStatus: args.status,
          pollFailureCount: args.status === "ok" ? 0 : sql`${redditPosts.pollFailureCount} + 1`,
          updatedAt: now,
        },
      });

    // ★ Author-tombstone derived-copy scrub (review P1): the paste path stores the
    //   preview's username on events.author_handle (events-mutation), and the purge
    //   cron never reaches a tombstoned-but-ALIVE post (its scrub is gated on
    //   deletion_detected_at, which this path deliberately never sets — the post is
    //   still public). Without this, the diary row keeps the deleted account's
    //   username forever. CROSS-TENANT by design (compliance write, mirrors the
    //   cron's events scrub), scoped to this exact post id + kind. No grace window:
    //   Reddit account deletion is irreversible — upstream already anonymized.
    if (authorDeleted) {
      await tx.execute(sql`
        UPDATE events
        SET author_handle = NULL,
            updated_at = NOW()
        WHERE kind::text = 'reddit_post'
          AND external_id = ${args.postId}
          AND author_handle IS NOT NULL
      `);
    }

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
