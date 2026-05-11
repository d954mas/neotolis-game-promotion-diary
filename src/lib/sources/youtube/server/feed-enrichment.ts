// YouTube feed enrichment — Phase 03.0.3 P2 (D-A1).
//
// Implements DataSourceAdapter.enrichFeedDtos for the youtube_channel
// adapter. Internally filters dtos to kind=youtube_video; ignores other
// kinds (caller does NOT pre-filter — Phase 03.0.3 D-A1 contract).
//
// Two batched queries:
//   1. youtube_video_snapshots — DISTINCT ON videoId ORDER BY polledAt DESC.
//      Gets latest snapshot per video for stats (view/like/comment).
//   2. youtube_videos — SELECT channelTitle by videoId IN (...). Gets
//      the channel chip name (populated by channel-context-backfill OR
//      backfill-channel's youtube_videos UPSERT).
//
// Both tables are public-data (no userId scope) — already in ESLint
// tenant-scope allowlist. The tenant guarantee comes from the upstream
// events SELECT (mapEventsToDtos returns userId-scoped rows); this
// helper only touches video-keyed metadata.
//
// Failure mode: errors are caught + logged at WARN; the cards render
// without the enrichment instead of breaking the feed.

import { inArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { youtubeVideoSnapshots, youtubeVideos } from "$lib/server/db/schema/index.js";
import { logger } from "$lib/server/logger.js";
import type { EventDto } from "$lib/server/dto.js";

export async function youtubeEnrichFeedDtos(
  _userId: string,
  dtos: EventDto[],
): Promise<void> {
  const youtubeExternalIds = dtos
    .filter((r) => r.kind === "youtube_video" && r.externalId !== null)
    .map((r) => r.externalId as string);
  if (youtubeExternalIds.length === 0) return;

  try {
    // 1. Latest-snapshot lookup. ORDER BY videoId, polledAt DESC; pick
    //    first row per videoId.
    const snapshots = await db
      .select({
        videoId: youtubeVideoSnapshots.videoId,
        polledAt: youtubeVideoSnapshots.polledAt,
        viewCount: youtubeVideoSnapshots.viewCount,
        likeCount: youtubeVideoSnapshots.likeCount,
        commentCount: youtubeVideoSnapshots.commentCount,
      })
      .from(youtubeVideoSnapshots)
      .where(inArray(youtubeVideoSnapshots.videoId, youtubeExternalIds))
      .orderBy(
        youtubeVideoSnapshots.videoId,
        sql`${youtubeVideoSnapshots.polledAt} DESC`,
      );
    const latest = new Map<
      string,
      { viewCount: number; likeCount: number; commentCount: number; polledAt: Date }
    >();
    for (const s of snapshots) {
      if (!latest.has(s.videoId)) {
        latest.set(s.videoId, {
          viewCount: s.viewCount ?? 0,
          likeCount: s.likeCount ?? 0,
          commentCount: s.commentCount ?? 0,
          polledAt: s.polledAt,
        });
      }
    }

    // 2. ChannelTitle lookup from youtube_videos cache.
    const videoChannels = await db
      .select({
        videoId: youtubeVideos.videoId,
        channelTitle: youtubeVideos.channelTitle,
      })
      .from(youtubeVideos)
      .where(inArray(youtubeVideos.videoId, youtubeExternalIds));
    const titleByVideo = new Map<string, string | null>();
    for (const v of videoChannels) titleByVideo.set(v.videoId, v.channelTitle);

    // 3. In-place mutation. Iterate dtos (not just the filtered subset)
    //    so the index matches the caller's expectation; skip non-YouTube
    //    rows defensively.
    for (const r of dtos) {
      if (r.kind !== "youtube_video" || r.externalId === null) continue;
      r.stats = latest.get(r.externalId) ?? null;
      r.channelTitle = titleByVideo.get(r.externalId) ?? null;
    }
  } catch (err) {
    // D-A1 — failure is non-fatal. Log and return; the feed still
    // renders, just without the enrichment.
    logger.warn(
      { err: String((err as Error)?.message ?? err), count: youtubeExternalIds.length },
      "youtube.enrichFeedDtos: query failed; feed renders without enrichment",
    );
  }
}
