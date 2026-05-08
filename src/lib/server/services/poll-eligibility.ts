// Phase 3.0 post-build refactor (2026-05-08) — extracted from
// src/scheduler/enqueue.ts so the SQL-window + tier-resolver gate logic
// can be unit-tested in isolation and re-used by future callers (e.g.
// an admin "what's eligible right now?" debug endpoint, or a manual
// trigger from /sources/[id] without needing to touch enqueue.ts).
//
// The function is intentionally callable WITHOUT a queue handle: it only
// reads (events, youtube_videos) and returns video_ids. enqueue.ts wraps
// it in throttle gating + queue dispatch; nothing else in this module
// knows about pg-boss.
//
// Cross-tenant by design — see the eslint-disable line below for the
// scheduler fan-out rationale. Self-host parity holds (operator runs the
// scheduler; aggregation across the operator's own tenants is the
// intended behaviour).
//
// Eligibility model (post-build review 2026-05-09): stats polling is
// PER-VIDEO. A video is eligible iff it is referenced by at least one
// alive event (kind=youtube_video, deleted_at IS NULL) within the tier
// window. The source_id of those events is IRRELEVANT — soft-deleted
// sources, auto_import=false sources, and manual-paste (source_id NULL)
// all flow into the same per-video polling pool.
//
// Why source state does not gate stats polling:
//   - Per-video refactor (D-NEW): one videos.list call serves up to 50
//     ids regardless of how many tenants reference each video. Cost
//     does not scale with the number of referencing events; it scales
//     with the number of distinct videos. Source-level gating offered
//     no quota saving — only an arbitrary "freeze stats history" UX
//     side effect.
//   - User intent of soft-delete: declutter /sources, not opt-out of
//     stats tracking. Frozen stats after a delete was a surprise.
//   - User intent of auto_import=false: "don't IMPORT new videos
//     automatically". Orthogonal to "keep updating stats on videos I
//     already have."
//
// Both gates (deleted_at AND auto_import) live on the AUTO-IMPORT path
// — the future worker that creates new events from a channel's
// playlistItems. That path will (correctly) honour `data_sources WHERE
// deleted_at IS NULL AND auto_import = true`. Stats polling does not.

import { sql, and, gt, isNotNull, isNull, lte, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { events } from "../db/schema/events.js";
import { youtubeVideos } from "../db/schema/index.js";
import { resolveTier } from "./tier-resolver.js";

/**
 * Resolve which video_ids are eligible to poll for a tier.
 *
 * Returns the de-duplicated list of external_ids whose:
 *   - youtube_videos.published_at falls in the (cutoffOldest, cutoffNewest] window
 *   - youtube_videos.last_poll_status is NOT in the unavailable override list
 *     (the JS-side resolveTier check applies it)
 *   - at least one alive (deleted_at IS NULL) event references the video
 *
 * The JS-side resolveTier() pass is the authoritative classifier; the SQL
 * filter is the coarse window. Pitfall 7 — never inline a tier boundary.
 *
 * Source state (data_sources.deleted_at, data_sources.auto_import) is
 * NOT consulted — see the file header for the per-video rationale. The
 * future auto-import path (creating new events from a channel) is a
 * separate query and will gate on those columns there.
 */
export async function selectEligibleVideoIds(
  cutoffNewest: Date | null,
  cutoffOldest: Date,
  expectedTier: "active" | "cold",
  now: Date,
): Promise<string[]> {
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- scheduler fan-out is service-wide by design (Plan 03.0-09 §"scheduler tick" — one cron tick batches eligible videos across ALL tenants into POLL_ACTIVE/COLD jobs). Per-video writeSnapshot downstream is public-data; tenant scope does not apply.
  const rows = await db
    .selectDistinct({
      videoId: youtubeVideos.videoId,
      publishedAt: youtubeVideos.publishedAt,
      lastPollStatus: youtubeVideos.lastPollStatus,
    })
    .from(events)
    .innerJoin(youtubeVideos, eq(events.externalId, youtubeVideos.videoId))
    .where(
      and(
        sql`${events.kind} = 'youtube_video'`,
        isNotNull(events.externalId),
        isNull(events.deletedAt),
        isNotNull(youtubeVideos.publishedAt),
        cutoffNewest ? lte(youtubeVideos.publishedAt, cutoffNewest) : sql`true`,
        gt(youtubeVideos.publishedAt, cutoffOldest),
      ),
    );

  // Authoritative tier classification on the JS side. SQL window is a
  // superset (it does not know about UNAVAILABLE_POLL_STATUSES override).
  return rows
    .filter((r) => resolveTier(r.publishedAt, r.lastPollStatus, now) === expectedTier)
    .map((r) => r.videoId);
}
