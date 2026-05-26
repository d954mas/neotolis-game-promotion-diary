// On-demand metadata fetcher for the /events/new paste form. The user
// pastes a YouTube URL, taps "Get from YouTube", we resolve the video_id,
// call videos.list?part=snippet (1 quota unit), return title +
// description + channel title for the form to pre-fill. Manual paste
// flow only - auto-import has its own metadata path in the worker
// (channel_context_backfill).
//
// Quota model: counts against the same operator-key envelope as polling
// (`youtube_service_quota_usage`). Per-user rate-limiting is the standing
// abuse-quota table (events_per_day) so a malicious paste-spam loop hits
// the 500/day cap before it can drain the operator's YouTube envelope.
//
// Idempotency: stateless. The caller (route handler) decides what to do
// with the response - fill the form, swallow on error, surface a toast.

import { z } from "zod";
import { eq } from "drizzle-orm";
import { hasYoutubeApiKeys, youtubeQuotaUser } from "./quota.js";
import { chargedFetch } from "./http.js";
import { db } from "$lib/server/db/client.js";
import {
  youtubeVideos,
  youtubeChannels,
  youtubeMetadataFetchLog,
} from "$lib/server/db/schema/index.js";
import { env } from "$lib/server/config/env.js";
import { AppError } from "$lib/server/services/errors.js";
import { AdapterError } from "$lib/sources/errors.js";
// withQuotaGuard is the cross-source events_per_day per-user abuse quota  -
// distinct from the YouTube operator-side per-key counter exported by ./quota.js
// in this folder. Disambiguated via the $lib path.
import { withQuotaGuard } from "$lib/server/services/quota.js";

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
    }),
  ),
});

export interface FetchedVideoMetadata {
  videoId: string;
  title: string;
  description: string | null;
  channelTitle: string | null;
  channelId: string | null;
  publishedAt: string | null;
}

// Parse a YouTube watch URL or share URL into a video_id. Accepts:
//   https://www.youtube.com/watch?v=ID
//   https://youtube.com/watch?v=ID
//   https://youtu.be/ID
//   https://www.youtube.com/shorts/ID
//   https://www.youtube.com/embed/ID
// Returns null for any other shape (the route returns 422; the form keeps
// the URL but doesn't auto-fill).
// YouTube URL parsing lives in ./url.ts. Re-export under the original
// name so /sources/new and data-sources.createSource keep working without
// churn at every callsite. New code should import from `./url.js`
// directly.
export { parseYoutubeUrl as parseYoutubeChannelUrl } from "./url.js";

export function parseYoutubeVideoId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();

  if (host === "youtu.be") {
    const id = parsed.pathname.replace(/^\//, "").split("/")[0];
    return id || null;
  }

  if (host === "youtube.com" || host === "www.youtube.com" || host === "m.youtube.com") {
    if (parsed.pathname === "/watch") {
      return parsed.searchParams.get("v");
    }
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length >= 2 && (segments[0] === "shorts" || segments[0] === "embed")) {
      return segments[1] ?? null;
    }
  }
  return null;
}

/**
 * Fetch metadata for a YouTube video by URL. Returns the parsed snippet
 * fields the /events/new form needs to pre-fill. Throws AppError on:
 *   - unparseable URL -> 422 (caller surfaces "not a YouTube URL")
 *   - empty SERVICE_YOUTUBE_API_KEYS -> 503 (caller surfaces "operator
 *     hasn't configured YouTube yet")
 *   - YouTube API non-2xx -> 502 (caller surfaces "YouTube unreachable")
 *   - YouTube returned no items (deleted / private / wrong id) -> 404
 *
 * userId is passed through to the quotaUser query parameter so YouTube's
 * per-quotaUser dashboard shows which account drove which call.
 */
export async function fetchVideoMetadataByUrl(
  url: string,
  userId: string,
  ipAddress: string,
): Promise<FetchedVideoMetadata & { cached: boolean }> {
  const videoId = parseYoutubeVideoId(url);
  if (!videoId) {
    throw new AppError("not a YouTube video URL", "validation_failed", 422, { url });
  }

  // Cache hit path - 0 quota burn AND no per-user rate-limit gate. The
  // youtube_videos cache is the single source of truth for "we already
  // know about this video". Backfill handler keeps it warm when channel-
  // context backfills run; this branch also catches the case where the
  // user pastes the same URL twice. Cache hits are free - they don't
  // ping Google, don't burn the operator's envelope, and don't count
  // against the user's youtube_metadata_fetches_per_day cap.
  //
  // channelTitle is sourced via LEFT JOIN youtube_channels (no-denorm
  // fix V-1, see docs/denormalization-policy.md). When the channel
  // cache is still empty (paste-only video that hasn't been backfilled
  // yet), channelTitle is null — the caller (route returning JSON to
  // the form) ships it through unchanged and the form just doesn't
  // pre-fill the channel name.
  const cached = await db
    .select({
      videoId: youtubeVideos.videoId,
      title: youtubeVideos.title,
      description: youtubeVideos.description,
      channelId: youtubeVideos.channelId,
      channelTitle: youtubeChannels.channelTitle,
      publishedAt: youtubeVideos.publishedAt,
    })
    .from(youtubeVideos)
    .leftJoin(youtubeChannels, eq(youtubeVideos.channelId, youtubeChannels.channelId))
    .where(eq(youtubeVideos.videoId, videoId))
    .limit(1);
  if (cached[0]) {
    const row = cached[0];
    return {
      videoId: row.videoId,
      title: row.title,
      description: row.description,
      channelTitle: row.channelTitle,
      channelId: row.channelId,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
      cached: true,
    };
  }

  // Cache miss -> real Google call. Two-phase pattern (never hold a tx
  // across an HTTP call):
  //
  //   Step A (inside withQuotaGuard tx): claim the slot - count + INSERT
  //     a row into youtube_metadata_fetch_log. The pg_advisory_xact_lock
  //     on userId serializes concurrent claims so the cap is race-safe.
  //     Eager-write semantics: the slot is consumed regardless of whether
  //     the upstream call later succeeds. This prevents an attacker from
  //     bypassing the cap via deliberately-failing requests (paste 1000
  //     bad URLs in a loop -> all 1000 get 422/404 from Google -> without
  //     eager-write, none of them count against the user's 50/day cap).
  //
  //   Step B (outside tx): HTTP call to YouTube. Slow operations live
  //     here so the tx-boundary stays under 50ms.
  //
  //   Step C (no tx - single statement): UPSERT youtube_videos cache.
  if (!hasYoutubeApiKeys()) {
    throw new AppError(
      "YouTube metadata fetch is unavailable - operator has not configured SERVICE_YOUTUBE_API_KEYS",
      "service_unavailable",
      503,
      { videoId },
    );
  }

  // Step A - claim slot under per-user lock.
  await withQuotaGuard(userId, "youtube_metadata_fetches_per_day", ipAddress, async (tx) => {
    await tx.insert(youtubeMetadataFetchLog).values({ userId });
  });

  // Step B - HTTP call OUTSIDE any tx.
  const apiUrl = new URL(`${env.YOUTUBE_API_BASE_URL}/videos`);
  apiUrl.searchParams.set("id", videoId);
  apiUrl.searchParams.set("part", "snippet");
  apiUrl.searchParams.set("quotaUser", youtubeQuotaUser(userId));

  // chargedFetch: DB quota reservation + AdapterError on non-2xx.
  // The 10s timeout is tighter than the worker default because this is a
  // user-facing form path, not a worker-internal call. origin='user' so
  // this fetch reserves against the user pool instead of cron.
  //
  //
  // AdapterError taxonomy translation: this user-facing path predates
  // AdapterError and the form expects AppError(502 / 404 / 503). Translate
  // the throw rather than ripple AdapterError into the route layer - the
  // form copy / status code is part of the user-facing contract that the
  // /api/youtube/fetch-metadata route handler maps to UX strings.
  let resp: Response;
  try {
    resp = await chargedFetch(
      apiUrl,
      1,
      { videoId, origin: "user", logTag: "youtube-metadata: videos.list" },
      10_000,
    );
  } catch (err) {
    if (err instanceof AdapterError) {
      // rate-limited / operator-issue / transient -> 502 upstream_error to
      // preserve the existing form UX. not-found -> 404 (video missing).
      if (err.category === "not-found") {
        throw new AppError("video not found on YouTube", "not_found", 404, { videoId });
      }
      throw new AppError("YouTube API error", "upstream_error", 502, {
        videoId,
        category: err.category,
      });
    }
    throw err;
  }

  const json = VIDEOS_LIST_RESPONSE.parse(await resp.json());
  const item = json.items[0];
  if (!item || !item.snippet) {
    throw new AppError("video not found on YouTube", "not_found", 404, { videoId });
  }

  // Step C - write-through to cache so the next paste of this URL (by
  // anyone) is a hit. UPSERT on video_id PK; no tenant scope on the
  // cache row (public-data table).
  //
  // channel_title is NOT written here (no-denorm fix V-1) — it lives
  // on youtube_channels and is read at JOIN time. channel-context-
  // backfill is the canonical writer for the channel row; this cache
  // hit returns null channelTitle until that backfill runs.
  const publishedAtDate = item.snippet.publishedAt ? new Date(item.snippet.publishedAt) : null;
  const now = new Date();
  await db
    .insert(youtubeVideos)
    .values({
      videoId: item.id,
      title: item.snippet.title,
      description: item.snippet.description ?? null,
      channelId: item.snippet.channelId ?? null,
      publishedAt: publishedAtDate,
      fetchedAt: now,
    })
    .onConflictDoUpdate({
      target: youtubeVideos.videoId,
      set: {
        title: item.snippet.title,
        description: item.snippet.description ?? null,
        channelId: item.snippet.channelId ?? null,
        publishedAt: publishedAtDate,
        fetchedAt: now,
        updatedAt: now,
      },
    });

  return {
    videoId: item.id,
    title: item.snippet.title,
    description: item.snippet.description ?? null,
    channelTitle: item.snippet.channelTitle ?? null,
    channelId: item.snippet.channelId ?? null,
    publishedAt: item.snippet.publishedAt ?? null,
    cached: false,
  };
}
