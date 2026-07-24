// Instagram per-post stats refresh — SQL lane worker (#69 + #70 warm follow-on).
//
// Thin config over the shared lane (src/lib/sources/server/social-warm-lane.ts
// createSocialRefreshLane). Two slots over adapter_refresh_queue, mirroring
// YouTube's user_video/service_video:
//   - "user_post"    — MANUAL "Refresh now" (enqueueRefreshNow). Payload
//                      {event_id, post_id}, user_id SET. Resolved TENANT-SCOPED
//                      (the user owns the event); fetch charges the USER pool.
//   - "service_post" — CRON warm auto-refresh (warm-scheduler / #70). Payload
//                      {post_id}, user_id NULL. PUBLIC-DATA, NO event lookup;
//                      fetch charges the OPERATOR (cron) pool.
//
// The claimGate (prepaid-balance RUN vs daily-cap DEFER, #69 P1-B), the concurrent
// Promise.allSettled dispatch, the per-row resolve/fetch/never-throw flow, and the
// drained-tick observability all live in the shared factory. This file binds the IG
// seams (getSocialProvider / getSocialProviderSpendToday from the IG tree so the per-tree
// vi.mock works), the IG posts-cache permalink lookup, the tenant-scoped user_post
// event resolve, and the IG snapshot write. IG's single-post endpoint exposes no
// share field, so the writeSnapshot mapping nulls `shares` by omission (the TikTok
// clone threads it — the ONE real per-platform delta).

import { and, eq, isNull } from "drizzle-orm";
import { events } from "$lib/server/db/schema/events.js";
import { instagramPosts } from "$lib/server/db/schema/index.js";
import { db } from "$lib/server/db/client.js";
import {
  createSocialRefreshLane,
  REFRESH_SLOTS,
  type SocialRefreshQueueName,
} from "$lib/sources/server/social-warm-lane.js";
import type { AdapterLaneWorkerRow } from "$lib/server/services/adapter-lane-worker.js";
import { env } from "$lib/server/config/env.js";
import { getSocialProvider } from "../provider/registry.js";
import { getSocialProviderSpendToday } from "../quota.js";
import { writeSnapshot } from "../snapshots.js";

export const INSTAGRAM_REFRESH_SLOTS = REFRESH_SLOTS;
export type InstagramRefreshQueueName = SocialRefreshQueueName;

// MANUAL path: resolve the post media id from the event, TENANT-SCOPED. A row
// without a userId can't be safely scoped (refresh-now rows always carry one).
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
        eq(events.kind, "instagram_post"),
        isNull(events.deletedAt),
      ),
    )
    .limit(1);
  return event?.externalId ?? null;
}

// The single-post endpoint needs the shortcode permalink, which lives on the
// public-data instagram_posts row. No row / no permalink (e.g. a paste before the
// first account poll) → null → graceful skip; the next scheduled poll fills it (D4).
async function resolvePermalink(postId: string): Promise<string | null> {
  const [postRow] = await db
    .select({ permalink: instagramPosts.permalink })
    .from(instagramPosts)
    .where(eq(instagramPosts.postId, postId))
    .limit(1);
  return postRow?.permalink ?? null;
}

const instagramRefreshLane = createSocialRefreshLane({
  adapterKind: "instagram_account",
  platform: "instagram",
  provider: "scrapecreators",
  maxBatchSize: env.SOCIAL_REFRESH_LANE_CONCURRENCY,
  getSocialProvider,
  getSocialProviderSpendToday,
  resolvePermalink,
  resolveUserPostId,
  writeSnapshot: ({ postId, permalink, post, status }) =>
    writeSnapshot(
      post === null
        ? { postId, permalink, metrics: null, status }
        : {
            postId,
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
            },
            status,
          },
    ),
});

export async function instagramRefreshQueueTick(): ReturnType<typeof instagramRefreshLane.tick> {
  return instagramRefreshLane.tick();
}

export function __resetInstagramRefreshQueueWorkerForTest(): void {
  instagramRefreshLane.resetForTest();
}
