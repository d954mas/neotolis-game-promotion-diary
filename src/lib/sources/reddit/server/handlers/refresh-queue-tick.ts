// Reddit per-post stats refresh — SQL lane worker.
//
// Thin config over the shared lane (social-warm-lane.ts createSocialRefreshLane). Two
// slots over adapter_refresh_queue:
//   - "user_post"    — MANUAL "Refresh now" (enqueueRefreshNow). Payload
//                      {event_id, post_id}, user_id SET. Resolved TENANT-SCOPED; the
//                      fetch charges the USER pool.
//   - "service_post" — CRON-funded MEDIA-FORM ENRICHMENT (12-06 UAT): the
//                      author-search feed carries no media evidence, so its
//                      image/gallery/link posts land with media_type NULL. The walk
//                      enqueues one row per unknown-form post
//                      (enqueueRedditFormEnrichment below); the fetch resolves the
//                      true form + thumbnail via the /post/comments detail endpoint
//                      and writeSnapshot upgrades the row in place. Payload
//                      {post_id}, user_id NULL. (The original warm STATS producer
//                      stays disabled — a settled decision.)
//
// NO QPS PACER (unlike Twitter): ScrapeCreators has no per-account QPS ceiling — the
// shared prepaid-balance reserve + the 80/95 daily-cap throttle are the only rate
// controls, and both live in the reserve-before-HTTP seam. So maxBatchSize rides the
// shared concurrency knob and no acquirePacerSlot is threaded.
//
// The single-post fetch rides the /post/comments DETAIL endpoint (12-06 UAT
// discovery — the 12-01 spike predates it): exact post by URL, 1 credit. A null
// result now means the post itself is gone/unresolvable — recorded as the explicit
// `inconclusive` poll status (paid attempt visible, button settles, previous
// snapshot intact); the account walk remains the authoritative deletion path.

import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { events } from "$lib/server/db/schema/events.js";
import { redditPosts } from "$lib/server/db/schema/index.js";
import { db } from "$lib/server/db/client.js";
import { env } from "$lib/server/config/env.js";
import {
  createServiceStatsEnqueuer,
  createSocialRefreshLane,
  REFRESH_SLOTS,
  type SocialRefreshQueueName,
} from "$lib/sources/server/social-warm-lane.js";
import type { AdapterLaneWorkerRow } from "$lib/server/services/adapter-lane-worker.js";
import { getSocialProvider } from "../provider/registry.js";
import { getSocialProviderSpendToday } from "../quota.js";
import { REDDIT_POST_DETAIL_DELETION_DETECTOR, writeSnapshot } from "../snapshots.js";
import { redditParsePostUrl } from "../url.js";

export const REDDIT_REFRESH_SLOTS = REFRESH_SLOTS;
export type RedditRefreshQueueName = SocialRefreshQueueName;

/** The shared service_post producer (advisory-lock per id + skip-if-pending-OR-
 *  PROCESSING dedup + one batched insert), same factory telegram/tiktok/instagram
 *  use. Reddit does NOT hand-roll this: a hand-rolled scan that only skipped
 *  `status='pending'` re-queued a post already being processed, buying the same
 *  detail fetch twice. */
const enqueueServiceRedditFormFetch = createServiceStatsEnqueuer({
  adapterKind: "reddit_account",
  queueName: "service_post",
  lockPrefix: "reddit_service_post:",
  rowType: "post_stats",
  payloadIdKey: "post_id",
});

/**
 * Media-form enrichment producer (12-06 UAT). Called by the walk after fan-out
 * with the pass's unknown-form post ids: queue ONE cron-funded service_post
 * detail fetch per post whose form is STILL unknown. The reddit-specific part is
 * only the PRE-FILTER — media_type IS NULL (a richer write may have resolved it
 * since the walk collected the id) AND a cached permalink exists (the lane
 * resolves the fetch URL from the cache, so a permalink-less row could never
 * run). Queue-side idempotency comes from the shared producer.
 */
export async function enqueueRedditFormEnrichment(postIds: string[]): Promise<number> {
  if (postIds.length === 0) return 0;
  const stillUnknown = await db
    .select({ postId: redditPosts.postId })
    .from(redditPosts)
    .where(
      and(
        inArray(redditPosts.postId, postIds),
        isNull(redditPosts.mediaType),
        isNotNull(redditPosts.permalink),
      ),
    );
  if (stillUnknown.length === 0) return 0;
  return enqueueServiceRedditFormFetch(stillUnknown.map((row) => row.postId));
}

// MANUAL path: resolve the post id from the event, TENANT-SCOPED.
async function resolveUserPostId(row: AdapterLaneWorkerRow): Promise<string | null> {
  if (row.userId === null) return null;
  const eventId = row.payload?.event_id;
  if (typeof eventId !== "string") return null;
  const [event] = await db
    .select({ externalId: events.externalId })
    .from(events)
    .where(
      and(
        eq(events.id, eventId),
        eq(events.userId, row.userId),
        eq(events.kind, "reddit_post"),
        isNull(events.deletedAt),
      ),
    )
    .limit(1);
  return event?.externalId ?? null;
}

// The single-post fetch takes a URL — recover the canonical permalink from the
// public-data reddit_posts cache. On a cache miss, recover it from the REQUESTING
// user's own reddit_post event (TENANT-SCOPED by row.userId — the P0 tenant-scope
// invariant admits no cross-tenant events read, even for URL-intrinsic data). A
// service row (userId null) has no tenant to scope by → skip on a cache miss; its
// post id came from the cache in the first place, so a miss means the row vanished.
async function resolvePermalink(postId: string, row: AdapterLaneWorkerRow): Promise<string | null> {
  const [postRow] = await db
    .select({ permalink: redditPosts.permalink })
    .from(redditPosts)
    .where(eq(redditPosts.postId, postId))
    .limit(1);
  if (postRow?.permalink != null) return postRow.permalink;

  if (row.userId === null) return null;
  const [eventRow] = await db
    .select({ url: events.url })
    .from(events)
    .where(
      and(
        eq(events.userId, row.userId),
        eq(events.externalId, postId),
        eq(events.kind, "reddit_post"),
        isNotNull(events.url),
        isNull(events.deletedAt),
      ),
    )
    .limit(1);
  if (eventRow?.url == null) return null;
  return redditParsePostUrl(eventRow.url) === null ? null : eventRow.url;
}

const redditRefreshLane = createSocialRefreshLane({
  adapterKind: "reddit_account",
  platform: "reddit",
  provider: "scrapecreators",
  maxBatchSize: env.SOCIAL_REFRESH_LANE_CONCURRENCY,
  getSocialProvider,
  getSocialProviderSpendToday,
  nullResultIsInconclusive: true,
  resolvePermalink,
  resolveUserPostId,
  writeSnapshot: ({ postId, permalink, post, status }) =>
    writeSnapshot(
      post === null
        ? {
            postId,
            permalink,
            metrics: null,
            status,
            ...(status === "not_found"
              ? {
                  deletionDetector: REDDIT_POST_DETAIL_DELETION_DETECTOR,
                  confirmedDeleted: true,
                }
              : {}),
          }
        : {
            postId,
            permalink,
            // The single-post NormalizedSinglePost carries the derived Reddit FORM —
            // thread it (review fix: hard-coded null left an image/gallery card
            // rendering as text until the next source walk cached the form). The
            // reddit-specific raw columns / selftext stay absent on this path and
            // COALESCE-preserve.
            mediaType: post.mediaType ?? null,
            linkDomain: post.linkDomain ?? null,
            title: post.caption,
            thumbnailUrl: post.thumbnailUrl,
            publishedAt: post.publishedAt,
            author: post.ownerUsername,
            authorFullname: post.ownerId,
            metrics: { likes: post.metrics.likes, comments: post.metrics.comments },
            raw:
              post.ownerDeleted === true || post.removedByCategory != null
                ? {
                    score: null,
                    upvoteRatio: null,
                    numComments: null,
                    numCrossposts: null,
                    removedByCategory: post.removedByCategory ?? null,
                    authorDeleted: post.ownerDeleted === true,
                  }
                : null,
            deletionDetector: REDDIT_POST_DETAIL_DELETION_DETECTOR,
            status,
          },
    ),
});

export async function redditRefreshQueueTick(): ReturnType<typeof redditRefreshLane.tick> {
  return redditRefreshLane.tick();
}

export function __resetRedditRefreshQueueWorkerForTest(): void {
  redditRefreshLane.resetForTest();
}
