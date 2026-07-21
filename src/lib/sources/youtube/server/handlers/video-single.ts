// YouTube video_single handler — fetch ONE video and populate the
// public-data caches (youtube_videos + optional
// youtube_video_snapshots) BEFORE the paste-flow events row INSERT.
//
// youtube_channels is intentionally NOT touched here — see the
// inline comment in the UPSERT body for the uploads_playlist_id
// reasoning. channel-context-backfill remains the canonical
// populator for that table.
//
// Populating the caches synchronously on paste (not lazily) is what
// lets /feed enrichment JOINs find the youtube_videos row on the
// first render AND the service-post cron walk the pasted video on
// its next tick (auto-refresh from day one).
//
// YouTube was NOT doing this. enrichFromUrl returned the oEmbed
// result without touching youtube_videos, so:
//
//   1. Paste-only events (kind=youtube_video, no registered source)
//      rendered in /feed with channel_title=null. feed-enrichment
//      JOINed youtube_videos → no row → no channel chip.
//
//   2. `selectEligibleVideoIds` filters on
//      `youtube_videos.published_at IS NOT NULL`. With no row, the
//      paste-only video never appeared in the active/cold poll
//      eligibility window and stats never refreshed automatically.
//      The user had to click Refresh-now manually, forever.
//
// This handler closes both gaps. Two callers:
//
//   1. enrichFromUrl paste flow (synchronous; ctx.paste === true).
//      Runs BEFORE the events INSERT so the immediate /feed render
//      hits the cache row.
//
//   2. Future worker-tick reuse (e.g. a cross-source reset / refresh
//      worker that wants to seed a video from scratch). The function
//      shape is a self-contained seed-one-video path, so adopting it
//      later is a thin wrapper.
//
// Endpoint choice — videos.list?part=snippet,statistics is the same
// endpoint pollStatsByVideoId uses for stats refresh. Reusing it
// here means one mock surface in tests + one extractor to maintain.
// When `SERVICE_YOUTUBE_API_KEYS` is empty (self-host operator
// without a YouTube Data API key), we still UPSERT youtube_videos
// from the oEmbed result (channelId=null, no snapshot) so the feed
// channel chip works. Polling eligibility still requires
// `published_at IS NOT NULL`, so without Data API the paste-only
// event remains poll-only via manual Refresh-now — but at least
// the channel name shows up.
//
// Dedup window — 60 seconds, same as Reddit. Preview at t=0 then
// Submit at t=5s on the same /events/new flow hits the cache once,
// the second call is a no-op (no Data API quota burn, no audit
// row). A second user pasting the same URL within 60s also hits
// the dedup (the cache rows are cross-tenant by design).
//
// Cap-counter / audit timing — only after a successful Data API
// call. Same asymmetry as Reddit's post_single: a failed fetch
// (network error, 403, quota exhaustion) leaves no audit row, so
// the per-user requestsPerDay cap is not charged for upstream
// problems the user couldn't avoid.

import { sql, eq, and, gte, desc } from "drizzle-orm";
import { z } from "zod";
import { db } from "$lib/server/db/client.js";
import { youtubeVideos, youtubeVideoSnapshots, youtubeChannels } from "../schema/index.js";
import { fetchYoutubeOembed } from "$lib/server/integrations/youtube-oembed.js";
import { hasYoutubeApiKeys, youtubeQuotaUser } from "../quota.js";
import { chargedFetch } from "../http.js";
import { env } from "$lib/server/config/env.js";
import { writeAudit } from "$lib/server/audit.js";
import { logger } from "$lib/server/logger.js";

/** Dedup window — handleVideoSingle skips the Data API fetch + cache
 *  re-UPSERT + audit row when youtube_videos row was fetched within
 *  this window. Matches handlePostSingle's POST_SINGLE_DEDUP_WINDOW_MS.
 *  Tuned to 60s for preview→submit on /events/new (typical click-
 *  through is <30s) and to keep within Google's per-key/per-day budget. */
const VIDEO_SINGLE_DEDUP_WINDOW_MS = 60_000;

// videos.list?part=snippet,statistics drift guard. Smaller than the
// adapter's combined schema (we don't need contentDetails here — the
// paste flow doesn't compute is_short). Mirrors metadata.ts but
// returns the full statistics block so we can write a snapshot row.
const VIDEOS_LIST_RESPONSE = z.object({
  kind: z.literal("youtube#videoListResponse"),
  items: z.array(
    z.object({
      id: z.string(),
      snippet: z
        .object({
          title: z.string(),
          description: z.string().optional(),
          channelTitle: z.string().optional(),
          channelId: z.string().optional(),
          publishedAt: z.string().optional(),
        })
        .optional(),
      statistics: z
        .object({
          viewCount: z.string().optional(),
          likeCount: z.string().optional(),
          commentCount: z.string().optional(),
        })
        .optional(),
    }),
  ),
});

export interface HandleVideoSingleResult {
  videoId: string;
  /** Title from oEmbed (always present on success) — Data API may
   *  override with a fresher value if it was called. */
  title: string;
  /** From oEmbed `author_name`. Returned to callers for in-memory use
   *  (e.g. immediate /events/new preview rendering). NOT persisted to
   *  youtube_videos — that column was dropped in no-denorm fix V-1
   *  (docs/denormalization-policy.md); youtube_channels carries the
   *  channel display name now. Always non-null on success because
   *  oEmbed succeeded before we get here. */
  channelTitle: string;
  /** Resolved when Data API responded; null when API key absent or
   *  request failed. With null, the row is UPSERTed without
   *  channel_id and polling eligibility cannot pick this video up
   *  until a future Data API call (manual refresh or worker poll). */
  channelId: string | null;
  /** Published-at from Data API. null when API key absent or failed.
   *  Polling eligibility requires this column non-null. */
  publishedAt: Date | null;
  thumbnailUrl: string;
  authorUrl: string;
  /** Stats when Data API responded; null otherwise. */
  stats: {
    viewCount: number;
    likeCount: number;
    commentCount: number;
  } | null;
  /** True when this call performed a real Data API HTTP fetch. False
   *  on dedup cache hit OR on no-API-key oEmbed-only path. */
  fetched: boolean;
}

export interface HandleVideoSingleArgs {
  videoId: string;
  userId: string;
  /** Distinguishes paste-flow (synchronous, dedup-eligible) from a
   *  future worker-tick caller. Today both call paths behave the same;
   *  the flag is here for symmetry with handlePostSingle and to leave
   *  room for cron-only behavior changes (e.g. always-fetch). */
  paste?: boolean;
  ipAddress?: string;
  /** Shorts classification known FROM THE URL ITSELF: a pasted
   *  youtube.com/shorts/<id> URL IS the answer — media_type='short' with no
   *  probe (the redirect probe would just confirm what the /shorts/ path already
   *  states). Only ever "short" (a /watch URL carries no Short/video signal —
   *  that's decided later by the poll worker's probe). Persisted on the
   *  youtube_videos UPSERT. */
  mediaTypeHint?: "short";
}

/**
 * Two-layer fetch:
 *
 *   1. oEmbed (keyless, public) for title + author_name + author_url +
 *      thumbnail_url. Required — the caller has already failed paste
 *      flow if oEmbed couldn't reach YouTube (the enrichFromUrl
 *      `unreachable` graceful-fallback branch was hit BEFORE we get
 *      here, in which case this handler is NOT invoked).
 *
 *   2. videos.list (Data API key required) for channel_id +
 *      published_at + statistics. Optional — when SERVICE_YOUTUBE_API_KEYS
 *      is empty or the call fails, we still UPSERT youtube_videos
 *      with the oEmbed fields so the channel chip + thumbnail render.
 *
 * Both call paths converge on the same UPSERT/audit code so the
 * post-write state is uniform.
 *
 * UPSERT semantics — same as fetchVideoMetadataByUrl in
 * src/lib/sources/youtube/server/metadata.ts: ON CONFLICT (video_id)
 * DO UPDATE refreshes the volatile fields. We do NOT clobber an
 * already-resolved channel_id with null (a paste-only event whose
 * row was UPSERTed earlier with Data API hit, then re-pasted by a
 * different user without API key, must not lose channel_id).
 */
export async function handleVideoSingle(
  args: HandleVideoSingleArgs,
): Promise<HandleVideoSingleResult | null> {
  // Dedup pre-check — if youtube_videos was UPSERTed within the
  // window, reuse the cached snapshot+row. Mirrors handlePostSingle's
  // readCachedPost branch.
  if (args.paste === true) {
    const cached = await readCachedVideo(args.videoId);
    if (cached !== null) {
      // /shorts/ paste intrinsic still applies on a dedup hit: the row may have
      // been first cached via a /watch paste (media_type NULL) seconds ago, and
      // this /shorts/ paste is the decisive signal. COALESCE-set it without a
      // probe (forward-only: never clobbers an existing 'short'/'video').
      if (args.mediaTypeHint !== undefined) {
        await db
          .update(youtubeVideos)
          .set({ mediaType: sql`COALESCE(${youtubeVideos.mediaType}, ${args.mediaTypeHint})` })
          .where(eq(youtubeVideos.videoId, args.videoId));
      }
      logger.debug(
        { videoId: args.videoId, userId: args.userId, paste: true },
        "youtube video_single: dedup — reused cached row < 60s old",
      );
      return cached;
    }
  }

  // Step 1 — oEmbed. Public, keyless, no quota. Same call the
  // adapter's fetchEventPreviewMetadata makes; we re-issue here so
  // worker-tick callers can use this handler without the
  // enrichFromUrl preview shape.
  const canonicalUrl = `https://www.youtube.com/watch?v=${args.videoId}`;
  const oembed = await fetchYoutubeOembed(canonicalUrl).catch(() => null);
  if (oembed === null || oembed.kind !== "ok") {
    // Caller is expected to have already mapped oEmbed
    // unreachable/private/unavailable to its own response. If we got
    // here and oEmbed isn't ok, return null so the caller can
    // proceed to the fallback path (or its own error).
    logger.debug(
      { videoId: args.videoId, kind: oembed?.kind ?? "null" },
      "youtube video_single: oembed not ok, skipping cache UPSERT",
    );
    return null;
  }

  const oembedTitle = oembed.data.title;
  const oembedChannelTitle = oembed.data.authorName;
  const oembedAuthorUrl = oembed.data.authorUrl;
  // mqdefault.jpg is the deterministic CDN thumbnail used by FeedCard.
  // oEmbed returns the platform-versioned hqdefault; we override to
  // mqdefault for cache consistency with the rest of the codebase.
  const thumbnailUrl = `https://img.youtube.com/vi/${args.videoId}/mqdefault.jpg`;

  // Step 2 — Data API call. Optional. Without API keys we still
  // UPSERT from oEmbed; with them, we additionally resolve channelId
  // / publishedAt / stats and write a snapshot row.
  let dataApiResult: {
    channelId: string | null;
    publishedAt: Date | null;
    stats: { viewCount: number; likeCount: number; commentCount: number };
  } | null = null;

  if (hasYoutubeApiKeys()) {
    dataApiResult = await fetchVideoFromDataApi(args.videoId, args.userId).catch((err) => {
      logger.warn(
        { videoId: args.videoId, err: String((err as Error)?.message ?? err) },
        "youtube video_single: videos.list failed, falling back to oEmbed-only UPSERT",
      );
      return null;
    });
  }

  // Cross-tenant cache writes. youtube_videos / youtube_channels /
  // youtube_video_snapshots are all PUBLIC-DATA (no user_id column);
  // the ESLint tenant-scope allowlist already covers them.
  await db.transaction(async (tx) => {
    // 1. UPSERT youtube_videos. No channel_title column — that lives
    //    on youtube_channels and is read at JOIN time
    //    (docs/denormalization-policy.md V-1). Use COALESCE on
    //    channel_id / published_at so a later oEmbed-only path can't
    //    null out values written by an earlier Data API hit.
    const now = new Date();
    await tx
      .insert(youtubeVideos)
      .values({
        videoId: args.videoId,
        title: oembedTitle,
        description: null,
        channelId: dataApiResult?.channelId ?? null,
        publishedAt: dataApiResult?.publishedAt ?? null,
        // /shorts/ paste intrinsic: the URL the user pasted IS the answer.
        // Otherwise NULL — the poll worker's redirect probe decides later.
        mediaType: args.mediaTypeHint ?? null,
        fetchedAt: now,
      })
      .onConflictDoUpdate({
        target: youtubeVideos.videoId,
        set: {
          // Title refreshes — oEmbed is authoritative for the
          // visible title (Data API also returns title; both should
          // agree, oEmbed wins here for consistency with the no-key
          // path).
          title: sql`EXCLUDED.title`,
          // COALESCE so a no-API-key re-paste doesn't clobber a
          // previously-resolved channel_id.
          channelId: sql`COALESCE(EXCLUDED.channel_id, ${youtubeVideos.channelId})`,
          publishedAt: sql`COALESCE(EXCLUDED.published_at, ${youtubeVideos.publishedAt})`,
          // media_type: COALESCE so a /shorts/ paste sets it on first sight but a
          // later /watch re-paste (EXCLUDED.media_type = NULL) never clobbers an
          // existing verdict. A probe-set 'short'/'video' is likewise preserved.
          mediaType: sql`COALESCE(EXCLUDED.media_type, ${youtubeVideos.mediaType})`,
          fetchedAt: sql`EXCLUDED.fetched_at`,
          updatedAt: now,
        },
      });

    // (We intentionally do NOT UPSERT youtube_channels here.
    //  That table requires `uploads_playlist_id NOT NULL` because
    //  channel-context-backfill needs the playlist id to walk
    //  uploads. videos.list?part=snippet does NOT return
    //  contentDetails.relatedPlaylists.uploads — only
    //  channels.list does. Writing a placeholder here would put a
    //  malformed row in the cache that the backfill worker would
    //  later have to detect-and-replace.
    //
    //  Channel cache is populated by:
    //    - channel-context-backfill (called from onSourceCreated)
    //    - the worker's playlistItems walk discovering new uploads
    //  Both have the channels.list response and write the row
    //  correctly. Paste-only events don't need the channel row
    //  immediately — feed-enrichment LEFT JOINs youtube_channels
    //  and falls back to null when the channel hasn't been
    //  backfilled yet (no-denorm fix V-1, see
    //  docs/denormalization-policy.md). When the user later
    //  registers this channel as a source, the row gets UPSERTed
    //  properly and the channel chip surfaces on the next render.)

    // 2. Optional snapshot row when Data API gave us stats.
    //    Mirrors handlePostSingle's reddit_post_snapshots write +
    //    fetchSyncStats's writeSnapshot — minute-truncated polled_at
    //    + ON CONFLICT DO NOTHING for retry idempotency.
    if (dataApiResult !== null) {
      await tx
        .insert(youtubeVideoSnapshots)
        .values({
          videoId: args.videoId,
          polledAt: sql`date_trunc('minute', now())` as unknown as Date,
          viewCount: dataApiResult.stats.viewCount,
          likeCount: dataApiResult.stats.likeCount,
          commentCount: dataApiResult.stats.commentCount,
        })
        .onConflictDoNothing();

      // last_polled_at / last_poll_status reflect the most recent
      // Data API hit so the rehab + poll-eligibility selectors see
      // this video as freshly-polled. poll_failure_count resets to
      // 0 on success — same semantics as snapshots.ts writeSnapshot.
      await tx
        .update(youtubeVideos)
        .set({
          lastPolledAt: now,
          lastPollStatus: "ok",
          pollFailureCount: 0,
        })
        .where(eq(youtubeVideos.videoId, args.videoId));
    }
  });

  // Audit row AFTER tx commit + ONLY on Data API success. Mirrors
  // fetchSyncStats's writeAudit timing — the per-user
  // requestsPerDay cap counter reads from this audit log
  // (services/quota.ts SUMs by flow=stats_refresh).
  if (dataApiResult !== null) {
    await writeAudit({
      userId: args.userId,
      action: "event.poll_refreshed",
      ipAddress: args.ipAddress ?? "0.0.0.0",
      metadata: {
        external_id: args.videoId,
        kind: "youtube_video",
        platform: "youtube_channel",
        flow: "stats_refresh",
        requests_used: 1,
        events_inserted: 0,
      },
    });
  }

  logger.debug(
    {
      videoId: args.videoId,
      userId: args.userId,
      paste: args.paste ?? false,
      channelId: dataApiResult?.channelId ?? null,
      fetched: dataApiResult !== null,
    },
    "youtube video_single: UPSERT complete",
  );

  return {
    videoId: args.videoId,
    title: oembedTitle,
    channelTitle: oembedChannelTitle,
    channelId: dataApiResult?.channelId ?? null,
    publishedAt: dataApiResult?.publishedAt ?? null,
    thumbnailUrl,
    authorUrl: oembedAuthorUrl,
    stats: dataApiResult?.stats ?? null,
    fetched: dataApiResult !== null,
  };
}

/**
 * Dedup helper. Returns the cached result if youtube_videos was
 * fetched within VIDEO_SINGLE_DEDUP_WINDOW_MS. Falls through (returns
 * null) when row is missing OR older — the caller proceeds to a real
 * oEmbed + Data API fetch and re-UPSERTs.
 *
 * `fetchedAt` is the dedup signal (not `last_polled_at`, which
 * tracks Data API polls — a no-API-key UPSERT advances fetchedAt but
 * NOT last_polled_at).
 */
async function readCachedVideo(videoId: string): Promise<HandleVideoSingleResult | null> {
  const since = new Date(Date.now() - VIDEO_SINGLE_DEDUP_WINDOW_MS);
  // channelTitle JOINs youtube_channels (source of truth post-V-1
  // no-denorm fix). LEFT JOIN because a paste-only video pre-backfill
  // has a resolved channel_id but no youtube_channels row until
  // channel-context-backfill runs — caller's "" fallback covers it.
  const rows = await db
    .select({
      videoId: youtubeVideos.videoId,
      title: youtubeVideos.title,
      channelId: youtubeVideos.channelId,
      channelTitle: youtubeChannels.channelTitle,
      publishedAt: youtubeVideos.publishedAt,
      fetchedAt: youtubeVideos.fetchedAt,
    })
    .from(youtubeVideos)
    .leftJoin(youtubeChannels, eq(youtubeVideos.channelId, youtubeChannels.channelId))
    .where(and(eq(youtubeVideos.videoId, videoId), gte(youtubeVideos.fetchedAt, since)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  // Latest snapshot row within the dedup window. If the cached row
  // came from a Data API hit, the matching snapshot exists.
  const snapRows = await db
    .select({
      viewCount: youtubeVideoSnapshots.viewCount,
      likeCount: youtubeVideoSnapshots.likeCount,
      commentCount: youtubeVideoSnapshots.commentCount,
    })
    .from(youtubeVideoSnapshots)
    .where(
      and(eq(youtubeVideoSnapshots.videoId, videoId), gte(youtubeVideoSnapshots.polledAt, since)),
    )
    .orderBy(desc(youtubeVideoSnapshots.polledAt))
    .limit(1);
  const snap = snapRows[0];

  return {
    videoId: row.videoId,
    title: row.title,
    channelTitle: row.channelTitle ?? "",
    channelId: row.channelId,
    publishedAt: row.publishedAt,
    thumbnailUrl: `https://img.youtube.com/vi/${row.videoId}/mqdefault.jpg`,
    authorUrl: row.channelId
      ? `https://www.youtube.com/channel/${row.channelId}`
      : `https://www.youtube.com/watch?v=${row.videoId}`,
    stats:
      snap && snap.viewCount !== null
        ? {
            viewCount: Number(snap.viewCount),
            likeCount: Number(snap.likeCount ?? 0),
            commentCount: Number(snap.commentCount ?? 0),
          }
        : null,
    fetched: false,
  };
}

/**
 * Issue videos.list?part=snippet,statistics for a single id. Charges
 * 1 unit against the user pool. Returns null on rate-limit / auth
 * error / not-found — the caller falls back to oEmbed-only UPSERT
 * (cache row still gets written, just without channel_id /
 * published_at / stats).
 */
async function fetchVideoFromDataApi(
  videoId: string,
  userId: string,
): Promise<{
  channelId: string | null;
  publishedAt: Date | null;
  stats: { viewCount: number; likeCount: number; commentCount: number };
} | null> {
  const apiUrl = new URL(`${env.YOUTUBE_API_BASE_URL}/videos`);
  apiUrl.searchParams.set("id", videoId);
  apiUrl.searchParams.set("part", "snippet,statistics");
  apiUrl.searchParams.set("quotaUser", youtubeQuotaUser(userId));

  // chargedFetch handles BOTH the quota reservation AND the upstream
  // HTTP. It throws AdapterError on operator-issue / rate-limited /
  // not-found; the outer .catch() in the caller maps those to null
  // so we fall through to oEmbed-only UPSERT.
  const resp = await chargedFetch(
    apiUrl,
    1,
    { videoId, origin: "user", logTag: "youtube video_single: videos.list" },
    10_000,
  );

  if (!resp.ok) {
    // Non-2xx without an AdapterError throw is rare (chargedFetch
    // throws on every error category) but defend anyway.
    return null;
  }

  const json = VIDEOS_LIST_RESPONSE.parse(await resp.json());
  const item = json.items[0];
  if (!item || !item.snippet) {
    // Video not found / private / deleted on Google's side. The
    // cache row still gets written with channel_id=null below.
    return null;
  }

  const publishedAt = item.snippet.publishedAt ? new Date(item.snippet.publishedAt) : null;
  return {
    channelId: item.snippet.channelId ?? null,
    publishedAt,
    stats: {
      viewCount: Number(item.statistics?.viewCount ?? 0),
      likeCount: Number(item.statistics?.likeCount ?? 0),
      commentCount: Number(item.statistics?.commentCount ?? 0),
    },
  };
}
