// Reddit per-post stats refresh — SQL lane worker.
//
// Thin config over the shared lane (social-warm-lane.ts createSocialRefreshLane). Two
// slots over adapter_refresh_queue:
//   - "user_post"    — MANUAL "Refresh now" (enqueueRefreshNow). Payload
//                      {event_id, post_id}, user_id SET. Resolved TENANT-SCOPED; the
//                      fetch charges the USER pool.
//   - "service_post" — CRON warm auto-refresh slot. DORMANT for Reddit: the warm
//                      producer was disabled (review fix — ScrapeCreators has no
//                      lookup-by-id, so a warm catch of a post that fell off the walk
//                      almost never resolves from the subreddit's page 1 and just
//                      burns a credit). The slot stays wired defensively for rows a
//                      pre-disable deploy may have left behind.
//
// NO QPS PACER (unlike Twitter): ScrapeCreators has no per-account QPS ceiling — the
// shared prepaid-balance reserve + the 80/95 daily-cap throttle are the only rate
// controls, and both live in the reserve-before-HTTP seam. So maxBatchSize rides the
// shared concurrency knob and no acquirePacerSlot is threaded.
//
// The single-post fetch resolves the post from the subreddit feed (ScrapeCreators
// exposes no single-post-by-id endpoint); a cold post absent from page 1 yields a
// not_found snapshot — acceptable for the diary (the walk keeps recent posts fresh).

import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { events } from "$lib/server/db/schema/events.js";
import { redditPosts } from "$lib/server/db/schema/index.js";
import { db } from "$lib/server/db/client.js";
import { env } from "$lib/server/config/env.js";
import {
  createSocialRefreshLane,
  REFRESH_SLOTS,
  type SocialRefreshQueueName,
} from "$lib/sources/server/social-warm-lane.js";
import type { AdapterLaneWorkerRow } from "$lib/server/services/adapter-lane-worker.js";
import { getSocialProvider } from "../provider/registry.js";
import { getSocialProviderSpendToday } from "../quota.js";
import { writeSnapshot } from "../snapshots.js";
import { redditParsePostUrl } from "../url.js";

export const REDDIT_REFRESH_SLOTS = REFRESH_SLOTS;
export type RedditRefreshQueueName = SocialRefreshQueueName;

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
        ? { postId, permalink, metrics: null, status }
        : {
            postId,
            permalink,
            // The single-post NormalizedSinglePost carries the derived Reddit FORM —
            // thread it (review fix: hard-coded null left an image/gallery card
            // rendering as text until the next source walk cached the form). The
            // reddit-specific raw columns / selftext stay absent on this path and
            // COALESCE-preserve.
            mediaType: post.mediaType ?? null,
            title: post.caption,
            thumbnailUrl: post.thumbnailUrl,
            publishedAt: post.publishedAt,
            author: post.ownerUsername,
            authorFullname: post.ownerId,
            metrics: { likes: post.metrics.likes, comments: post.metrics.comments },
            raw: null,
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
