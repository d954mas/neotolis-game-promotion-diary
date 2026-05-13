// SQL-window + tier-resolver gate logic for stats-polling eligibility.
//
// The function is intentionally callable WITHOUT a queue handle: it only
// reads (events, youtube_videos) and returns video_ids. The scheduler
// wraps it in throttle gating + queue dispatch; nothing else in this
// module knows about pg-boss.
//
// Cross-tenant by design — see the eslint-disable line below for the
// scheduler fan-out rationale. Self-host parity holds (operator runs the
// scheduler; aggregation across the operator's own tenants is the
// intended behaviour).
//
// Eligibility model: stats polling is PER-VIDEO. A video is eligible iff
// it is referenced by at least one alive event (kind=youtube_video,
// deleted_at IS NULL) within the tier window. The source_id of those
// events is IRRELEVANT — soft-deleted sources, auto_import=false sources,
// and manual-paste (source_id NULL) all flow into the same per-video
// polling pool.
//
// Why source state does not gate stats polling:
//   - One videos.list call serves up to 50 ids regardless of how many
//     tenants reference each video. Cost does not scale with the number
//     of referencing events; it scales with the number of distinct
//     videos. Source-level gating offered no quota saving — only an
//     arbitrary "freeze stats history" UX side effect.
//   - User intent of soft-delete: declutter /sources, not opt-out of
//     stats tracking. Frozen stats after a delete was a surprise.
//   - User intent of auto_import=false: "don't IMPORT new videos
//     automatically". Orthogonal to "keep updating stats on videos I
//     already have."
//
// Both gates (deleted_at AND auto_import) live on the AUTO-IMPORT path
// — the worker that creates new events from a channel's playlistItems
// honours `data_sources WHERE deleted_at IS NULL AND auto_import = true`.
// Stats polling does not.

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
 *     OR (bootstrap rule) the video is older than the window AND
 *     last_polled_at IS NULL — the never-polled bootstrap path that gives
 *     each frozen-by-age video exactly one cron-driven shot at writeSnapshot.
 *   - youtube_videos.last_poll_status is NOT in the unavailable override list
 *     (the JS-side resolveTier check applies it)
 *   - at least one alive (deleted_at IS NULL) event references the video
 *
 * The JS-side resolveTier() pass is the authoritative classifier; the SQL
 * filter is the coarse window. Never inline a tier boundary literal here.
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
  // The SQL window widens for tier=cold to include never-polled frozen
  // videos (last_polled_at IS NULL AND published_at <= cutoffOldest).
  // The JS-side resolveTier() collapses them to 'cold' via the bootstrap
  // rule, so they get picked up by the cold-tier worker exactly once.
  // tier=active stays untouched — active is age-only and never crosses
  // the frozen boundary by definition.
  const bootstrapClause =
    expectedTier === "cold" ? sql`OR (${youtubeVideos.lastPolledAt} IS NULL)` : sql``;

  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- scheduler fan-out is service-wide by design; one cron tick batches eligible videos across ALL tenants into POLL_ACTIVE/COLD jobs. Per-video writeSnapshot downstream is public-data; tenant scope does not apply.
  const rows = await db
    .selectDistinct({
      videoId: youtubeVideos.videoId,
      publishedAt: youtubeVideos.publishedAt,
      lastPollStatus: youtubeVideos.lastPollStatus,
      lastPolledAt: youtubeVideos.lastPolledAt,
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
        sql`(${gt(youtubeVideos.publishedAt, cutoffOldest)} ${bootstrapClause})`,
      ),
    );

  // Authoritative tier classification on the JS side. SQL window is a
  // superset (it does not know about UNAVAILABLE_POLL_STATUSES override).
  return rows
    .filter(
      (r) => resolveTier(r.publishedAt, r.lastPollStatus, r.lastPolledAt, now) === expectedTier,
    )
    .map((r) => r.videoId);
}
