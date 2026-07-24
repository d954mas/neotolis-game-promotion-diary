// Twitter/X per-post stats refresh — SQL lane worker.
//
// Thin config over the shared lane (src/lib/sources/server/social-warm-lane.ts
// createSocialRefreshLane). Two slots over adapter_refresh_queue:
//   - "user_post"    — MANUAL "Refresh now" (enqueueRefreshNow). Payload
//                      {event_id, post_id}, user_id SET. Resolved TENANT-SCOPED
//                      (the user owns the event); fetch charges the USER pool.
//   - "service_post" — CRON warm auto-refresh. Payload {post_id}, user_id NULL.
//                      PUBLIC-DATA, NO event lookup; fetch charges the OPERATOR
//                      (cron) pool.
//
// The claimGate (prepaid-balance RUN vs daily-cap DEFER), the concurrent
// Promise.allSettled dispatch, the per-row resolve/fetch/never-throw flow, and the
// drained-tick observability all live in the shared factory. This file binds the
// Twitter seams (getSocialProvider / getSocialProviderSpendToday from the Twitter tree so
// the per-tree vi.mock works), the twitter_posts permalink lookup, the
// tenant-scoped user_post event resolve, and the Twitter snapshot write.
//
// D-05 DELTA: the single-tweet NormalizedSinglePost carries no raw
// retweet/quote/bookmark components, so this lane threads only the derived `shares`
// (the charted metric → twitter_post_snapshots.share_count) and leaves the raw split
// null — D-05 raw retention is a walker-only concern (only the walker has the full
// Tweet object).
//
// QPS PACING (the operator's per-account rate-limit requirement — inherited from
// Plan 02): twitterapi.io rate-limits PER ACCOUNT (0.2 QPS = 1 req/5s for a
// never-paid account). The pacing is enforced by the LANE TOPOLOGY, NOT a parallel
// pacer: the Twitter refresh scheduledWorker (index.ts) runs at intervalMs =
// TWITTERAPIIO_MIN_REQUEST_INTERVAL_MS (5000ms) AND this lane claims maxBatchSize=1
// row/tick, so consecutive twitterapi.io calls are serialized + spaced ≥5s apart
// (the Reddit-lane pacing pattern — intervalMs throttles the rate-limited scrape).
// The seam's 429 → rate-limited classification with the honored Retry-After is the
// belt-and-suspenders backstop if the floor is ever crossed.

import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { events } from "$lib/server/db/schema/events.js";
import { twitterPosts } from "$lib/server/db/schema/index.js";
import { db } from "$lib/server/db/client.js";
import {
  createSocialRefreshLane,
  REFRESH_SLOTS,
  type SocialRefreshQueueName,
} from "$lib/sources/server/social-warm-lane.js";
import type { AdapterLaneWorkerRow } from "$lib/server/services/adapter-lane-worker.js";
import { getSocialProvider } from "../provider/registry.js";
import { getSocialProviderSpendToday } from "../quota.js";
import { writeSnapshot } from "../snapshots.js";
import { twitterParseUrl } from "../url.js";
import { acquireTwitterPacerSlot } from "../pacer.js";

export const TWITTER_REFRESH_SLOTS = REFRESH_SLOTS;
export type TwitterRefreshQueueName = SocialRefreshQueueName;

// MANUAL path: resolve the tweet id from the event, TENANT-SCOPED. A row without a
// userId can't be safely scoped (refresh-now rows always carry one).
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
        eq(events.kind, "twitter_post"),
        isNull(events.deletedAt),
      ),
    )
    .limit(1);
  return event?.externalId ?? null;
}

// The single-tweet endpoint resolves the tweet by the URL-intrinsic status id, but
// fetchPostByUrl takes a URL — recover the canonical permalink from the public-data
// twitter_posts row (written by the account poll / a paste preview). On a cache miss
// recover it from the twitter_post event's own URL (the tweet id IS the
// /<handle>/status/<id> slug, so twitterParseUrl yields the same canonical
// permalink the endpoint needs). On a successful fetch writeSnapshot UPSERTs the
// twitter_posts row, self-healing the cache so subsequent refreshes hit the fast path.
async function resolvePermalink(
  tweetId: string,
  row: AdapterLaneWorkerRow,
): Promise<string | null> {
  const [postRow] = await db
    .select({ permalink: twitterPosts.permalink })
    .from(twitterPosts)
    .where(eq(twitterPosts.tweetId, tweetId))
    .limit(1);
  if (postRow?.permalink != null) return postRow.permalink;

  // No cache row — recover the permalink from the twitter_post event keyed by this
  // tweet id (the URL slug IS the id, so external_id == tweet id). PUBLIC-DATA: the
  // permalink is intrinsic to the URL, identical across every tenant who saved it, so
  // no userId scope (any tenant's row yields the same canonical permalink).
  if (row.userId === null) return null;
  const [eventRow] = await db
    .select({ url: events.url })
    .from(events)
    .where(
      and(
        eq(events.userId, row.userId),
        eq(events.externalId, tweetId),
        eq(events.kind, "twitter_post"),
        isNotNull(events.url),
        isNull(events.deletedAt),
      ),
    )
    .limit(1);
  if (eventRow?.url == null) return null;
  const parsed = twitterParseUrl(eventRow.url);
  return (parsed?.metadata as { permalink?: string } | undefined)?.permalink ?? null;
}

const twitterRefreshLane = createSocialRefreshLane({
  adapterKind: "twitter_account",
  platform: "twitter",
  provider: "twitterapi.io",
  // QPS PACING: serialize the lane to ONE provider call per tick (the scheduledWorker's
  // intervalMs paces consecutive ticks ≥5s apart — the 0.2-QPS floor). NOT
  // SOCIAL_REFRESH_LANE_CONCURRENCY (which would dispatch up to 10 concurrent calls
  // and instantly provoke the per-account 429).
  maxBatchSize: 1,
  getSocialProvider,
  getSocialProviderSpendToday,
  // Acquire the global twitter_pacer slot in the claimGate (Plan 11 P1), AFTER the
  // budget gate and on the claim tx so a rollback rolls the slot back too. A denied
  // slot DEFERS the row (stays pending → retried) instead of letting it reach the seam,
  // fail rate-limited, and complete `done` — which is how a manual Refresh-Now silently
  // no-opped under QPS contention. Twitter is the reference QPS-pacer adapter (acquireTwitterPacerSlot(ctx.tx)).
  // The permit then makes the seam skip its own acquire (no double-spend).
  acquirePacerSlot: (tx) => acquireTwitterPacerSlot(tx),
  resolvePermalink,
  resolveUserPostId,
  writeSnapshot: ({ postId: tweetId, permalink, post, status }) =>
    writeSnapshot(
      post === null
        ? { tweetId, permalink, metrics: null, status }
        : {
            tweetId,
            accountId: post.ownerId,
            mediaType: post.kind,
            caption: post.caption,
            permalink,
            thumbnailUrl: post.thumbnailUrl,
            publishedAt: post.publishedAt,
            metrics: {
              views: post.metrics.views,
              likes: post.metrics.likes,
              comments: post.metrics.comments,
              shares: post.metrics.shares,
            },
            status,
          },
    ),
});

export async function twitterRefreshQueueTick(): ReturnType<typeof twitterRefreshLane.tick> {
  return twitterRefreshLane.tick();
}

export function __resetTwitterRefreshQueueWorkerForTest(): void {
  twitterRefreshLane.resetForTest();
}
