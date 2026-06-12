// TikTok per-post stats refresh — SQL lane worker.
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
// TikTok seams (getSocialProvider / getSocialSpendToday from the TikTok tree so the
// per-tree vi.mock works), the tiktok_posts permalink lookup, the tenant-scoped
// user_post event resolve, and the TikTok snapshot write.
//
// CRITICAL DELTA vs Instagram: the writeSnapshot mapping threads `shares`
// (post.metrics.shares → tiktok_post_snapshots.share_count, the PLAT-02 metric).
// TikTok's API exposes share_count inline; IG returns no share field so its mapping
// omits it. This is the ONE genuine per-platform behavioral difference the shared
// factory pushes down to the per-tree writeSnapshot config.

import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { events } from "$lib/server/db/schema/events.js";
import { tiktokPosts } from "$lib/server/db/schema/index.js";
import { db } from "$lib/server/db/client.js";
import {
  createSocialRefreshLane,
  REFRESH_SLOTS,
  type SocialRefreshQueueName,
} from "$lib/sources/server/social-warm-lane.js";
import type { AdapterLaneWorkerRow } from "$lib/server/services/adapter-lane-worker.js";
import { env } from "$lib/server/config/env.js";
import { getSocialProvider } from "../provider/registry.js";
import { getSocialSpendToday } from "../quota.js";
import { writeSnapshot } from "../snapshots.js";
import { tiktokParseUrl } from "../url.js";

export const TIKTOK_REFRESH_SLOTS = REFRESH_SLOTS;
export type TikTokRefreshQueueName = SocialRefreshQueueName;

// MANUAL path: resolve the aweme id from the event, TENANT-SCOPED. A row without a
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
        eq(events.kind, "tiktok_post"),
        isNull(events.deletedAt),
      ),
    )
    .limit(1);
  return event?.externalId ?? null;
}

// The single-video endpoint needs the permalink. It normally lives on the
// public-data tiktok_posts row (written by the account poll / a paste preview).
//
// CACHE-MISS FALLBACK (TikTok-only, Finding 2): a tiktok_post event can exist with
// a valid aweme id but NO tiktok_posts row — the create boundary's
// resolveCachedExternalId falls back to the URL-INTRINSIC aweme id (TikTok's id IS
// the /@handle/video/<id> URL slug, 10-SPIKE) when no preview ran. IG has no such
// state (its media id is NOT URL-derivable → no-preview events are saved id-less and
// aren't refreshable), so IG's resolvePermalink correctly stops at the cache miss.
// For TikTok, stopping here would charge the user a cooldown + audit row on Refresh
// yet fetch nothing. Recover the canonical permalink from the event's own URL
// (tiktokParseUrl yields the same /@handle/video/<id> permalink the endpoint needs).
// On a successful fetch writeSnapshot UPSERTs the tiktok_posts row, self-healing the
// cache so subsequent refreshes hit the fast path.
async function resolvePermalink(awemeId: string): Promise<string | null> {
  const [postRow] = await db
    .select({ permalink: tiktokPosts.permalink })
    .from(tiktokPosts)
    .where(eq(tiktokPosts.awemeId, awemeId))
    .limit(1);
  if (postRow?.permalink != null) return postRow.permalink;

  // No cache row — recover the permalink from the tiktok_post event keyed by this
  // aweme id (the URL slug IS the id, so external_id == aweme id). PUBLIC-DATA: the
  // permalink is intrinsic to the URL, identical across every tenant who saved it, so
  // no userId scope (any tenant's row yields the same canonical permalink).
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- the permalink is URL-intrinsic public data (TikTok's aweme id IS the /@handle/video/<id> slug); any tenant's tiktok_post event for this id parses to the SAME canonical permalink, so the cache-miss recovery is tenant-agnostic by construction.
  const [eventRow] = await db
    .select({ url: events.url })
    .from(events)
    .where(
      and(
        eq(events.externalId, awemeId),
        eq(events.kind, "tiktok_post"),
        isNotNull(events.url),
        isNull(events.deletedAt),
      ),
    )
    .limit(1);
  if (eventRow?.url == null) return null;
  const parsed = tiktokParseUrl(eventRow.url);
  return (parsed?.metadata as { permalink?: string } | undefined)?.permalink ?? null;
}

const tiktokRefreshLane = createSocialRefreshLane({
  adapterKind: "tiktok_account",
  platform: "tiktok",
  provider: "scrapecreators",
  maxBatchSize: env.SOCIAL_REFRESH_LANE_CONCURRENCY,
  getSocialProvider,
  getSocialSpendToday,
  resolvePermalink,
  resolveUserPostId,
  writeSnapshot: ({ postId: awemeId, permalink, post, status }) =>
    writeSnapshot(
      post === null
        ? { awemeId, permalink, metrics: null, status }
        : {
            awemeId,
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

export async function tiktokRefreshQueueTick(): ReturnType<typeof tiktokRefreshLane.tick> {
  return tiktokRefreshLane.tick();
}

export function __resetTikTokRefreshQueueWorkerForTest(): void {
  tiktokRefreshLane.resetForTest();
}
