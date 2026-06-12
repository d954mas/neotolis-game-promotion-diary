// YouTube feed enrichment.
//
// Implements SourceAdapter.enrichFeedDtos for the youtube_channel
// adapter. Internally filters dtos to kind=youtube_video; ignores other
// kinds (caller does NOT pre-filter).
//
// Two batched queries:
//   1. youtube_video_snapshots — DISTINCT ON videoId ORDER BY polledAt DESC.
//      Gets latest snapshot per video for stats (view/like/comment).
//   2. youtube_videos LEFT JOIN youtube_channels ON channel_id —
//      SELECT youtube_channels.channelTitle by videoId IN (...). Gets
//      the channel chip name from the SOURCE OF TRUTH row
//      (youtube_channels), so a YouTube-side channel rename reflects
//      in /feed as soon as the polling worker refreshes the channel
//      row (no per-video re-walk required). See
//      docs/denormalization-policy.md (V-1).
//
// Both tables are public-data (no userId scope) — already in ESLint
// tenant-scope allowlist. The tenant guarantee comes from the upstream
// events SELECT (mapEventsToDtos returns userId-scoped rows); this
// helper only touches video-keyed metadata.
//
// Failure mode: errors are caught + logged at WARN; the cards render
// without the enrichment instead of breaking the feed.

import { eq, inArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { youtubeVideos, youtubeChannels } from "$lib/server/db/schema/index.js";
import { logger } from "$lib/server/logger.js";
import type { EventDto } from "$lib/server/dto.js";

export async function youtubeEnrichFeedDtos(
  /**
   * userId is required by the SourceAdapter.enrichFeedDtos contract but
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
    //    video_id, the most recent. Loading every historical row and
    //    picking the first per video in JS would grow with polling
    //    history rather than page size. Raw SQL because Drizzle's
    //    pg-core builder doesn't have a first-class DISTINCT ON helper.
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

    // 2. ChannelTitle lookup via JOIN — read from youtube_channels
    //    (source of truth) keyed by youtube_videos.channel_id.
    //
    // LEFT JOIN because a paste-only video whose channel hasn't been
    // backfilled yet has channel_id non-null (resolved by Data API)
    // but no youtube_channels row until channel-context-backfill runs.
    // YoutubeFeedCard's data_sources.channelTitle read path (via the
    // source prop) covers registered channels; this enrichment covers
    // events whose channel the user hasn't registered yet, falling
    // back gracefully to null when the channel cache is still empty.
    const videoChannels = await db
      .select({
        videoId: youtubeVideos.videoId,
        channelTitle: youtubeChannels.channelTitle,
        // media_type drives the Short/Video pill + the media-type feed filter's
        // client mirror. NULL until the poll worker's redirect probe classifies
        // (Shorts detection); the card treats NULL as "video" (no Short pill).
        mediaType: youtubeVideos.mediaType,
      })
      .from(youtubeVideos)
      .leftJoin(youtubeChannels, eq(youtubeVideos.channelId, youtubeChannels.channelId))
      .where(inArray(youtubeVideos.videoId, youtubeExternalIds));
    const titleByVideo = new Map<string, string | null>();
    const mediaTypeByVideo = new Map<string, string | null>();
    for (const v of videoChannels) {
      titleByVideo.set(v.videoId, v.channelTitle);
      mediaTypeByVideo.set(v.videoId, v.mediaType);
    }

    // 3. In-place mutation. Iterate dtos (not just the filtered subset)
    //    so the index matches the caller's expectation; skip non-YouTube
    //    rows defensively.
    for (const r of dtos) {
      if (r.kind !== "youtube_video" || r.externalId === null) continue;
      r.stats = latest.get(r.externalId) ?? null;
      r.channelTitle = titleByVideo.get(r.externalId) ?? null;
      // Carry media_type the same way TikTok carries its enrichment.mediaType,
      // so the card overlay + filter-math client mirror read one shape.
      (r as EventDto & { youtubeEnrichment?: { mediaType: string | null } }).youtubeEnrichment = {
        mediaType: mediaTypeByVideo.get(r.externalId) ?? null,
      };
    }
  } catch (err) {
    // Failure is non-fatal. Log and return; the feed still renders, just
    // without the enrichment.
    logger.warn(
      { err: String((err as Error)?.message ?? err), count: youtubeExternalIds.length },
      "youtube.enrichFeedDtos: query failed; feed renders without enrichment",
    );
  }
}
