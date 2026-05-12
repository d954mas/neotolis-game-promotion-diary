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
import { youtubeVideos } from "$lib/server/db/schema/index.js";
import { logger } from "$lib/server/logger.js";
import type { EventDto } from "$lib/server/dto.js";

export async function youtubeEnrichFeedDtos(
  /**
   * userId is required by the DataSourceAdapter.enrichFeedDtos contract but
   * is intentionally unused here: youtube_video_snapshots and youtube_videos
   * are PUBLIC-DATA tables (no userId column — already in the ESLint
   * tenant-scope allowlist). The tenant guarantee comes from the upstream
   * events SELECT in mapEventsToDtos. Other adapters whose enrichment
   * touches tenant-owned tables (e.g. a future Reddit adapter reading
   * per-user OAuth-scoped metadata) MUST scope by userId in their queries.
   */
  _userId: string,
  dtos: EventDto[],
): Promise<void> {
  const youtubeExternalIds = dtos
    .filter((r) => r.kind === "youtube_video" && r.externalId !== null)
    .map((r) => r.externalId as string);
  if (youtubeExternalIds.length === 0) return;

  try {
    // 1. Latest-snapshot lookup. youtube_video_snapshots is an immutable
    //    time series — a busy video may carry hundreds of historical
    //    rows. DISTINCT ON (video_id) ORDER BY video_id, polled_at DESC
    //    keeps the database scan tight: exactly one row per requested
    //    video_id, the most recent. Pre-fix (Phase 03.0.3 round-5
    //    Codex P2) the query loaded every historical row and JS picked
    //    the first per video — cost grew with polling history rather
    //    than page size. Raw SQL because Drizzle's pg-core builder
    //    doesn't have a first-class DISTINCT ON helper.
    const idsSql = sql.join(
      youtubeExternalIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const latestRows = await db.execute<{
      video_id: string;
      polled_at: Date;
      view_count: number | null;
      like_count: number | null;
      comment_count: number | null;
    }>(sql`
      SELECT DISTINCT ON (video_id)
        video_id, polled_at, view_count, like_count, comment_count
      FROM youtube_video_snapshots
      WHERE video_id IN (${idsSql})
      ORDER BY video_id, polled_at DESC
    `);
    const latest = new Map<
      string,
      { viewCount: number; likeCount: number; commentCount: number; polledAt: Date }
    >();
    for (const s of latestRows.rows) {
      // db.execute returns raw pg driver shapes — int columns come
      // back as strings on some pg versions; explicit Number() coercion
      // matches the snapshot column types declared in the schema.
      latest.set(s.video_id, {
        viewCount: s.view_count === null ? 0 : Number(s.view_count),
        likeCount: s.like_count === null ? 0 : Number(s.like_count),
        commentCount: s.comment_count === null ? 0 : Number(s.comment_count),
        polledAt:
          s.polled_at instanceof Date ? s.polled_at : new Date(s.polled_at as unknown as string),
      });
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
