// Phase 3.0 post-build (UAT 2026-05-06) — on-demand metadata fetcher for
// the /events/new paste form. The user pastes a YouTube URL, taps "Get from
// YouTube", we resolve the video_id, call videos.list?part=snippet (1 quota
// unit), return title + description + channel title for the form to
// pre-fill. Manual paste flow only — auto-import has its own metadata path
// in the worker (channel_context_backfill).
//
// Quota model: counts against the same operator-key envelope as polling
// (`youtube_service_quota_usage`). Per-user rate-limiting is the standing
// abuse-quota table (events_per_day) so a malicious paste-spam loop hits
// the 500/day cap before it can drain the operator's YouTube envelope.
//
// Idempotency: stateless. The caller (route handler) decides what to do
// with the response — fill the form, swallow on error, surface a toast.

import { z } from "zod";
import { eq } from "drizzle-orm";
import {
  pickKeyForJob,
  hashApiKeyId,
  incrementUsage,
} from "./youtube-quota-tracker.js";
import { db } from "../db/client.js";
import { youtubeVideos } from "../db/schema/youtube-videos.js";
import { env } from "../config/env.js";
import { AppError } from "./errors.js";
import { logger } from "../logger.js";

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

async function fetchWithTimeout(url: URL, timeoutMs = 10_000): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch metadata for a YouTube video by URL. Returns the parsed snippet
 * fields the /events/new form needs to pre-fill. Throws AppError on:
 *   - unparseable URL → 422 (caller surfaces "not a YouTube URL")
 *   - empty SERVICE_YOUTUBE_API_KEYS → 503 (caller surfaces "operator
 *     hasn't configured YouTube yet")
 *   - YouTube API non-2xx → 502 (caller surfaces "YouTube unreachable")
 *   - YouTube returned no items (deleted / private / wrong id) → 404
 *
 * userId is passed through to the quotaUser query parameter (Plan 03.0
 * RESEARCH §"Open Question 5") so YouTube's per-quotaUser dashboard shows
 * which account drove which call.
 */
export async function fetchVideoMetadataByUrl(
  url: string,
  userId: string,
): Promise<FetchedVideoMetadata & { cached: boolean }> {
  const videoId = parseYoutubeVideoId(url);
  if (!videoId) {
    throw new AppError("not a YouTube video URL", "validation_failed", 422, { url });
  }

  // Cache hit path — 0 quota burn. Phase 3.0 post-build cache table is the
  // single source of truth for "we already know about this video". Backfill
  // handler keeps it warm when channel-context backfills run; this branch
  // also catches the case where the user pastes the same URL twice.
  const cached = await db
    .select()
    .from(youtubeVideos)
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

  const picked = pickKeyForJob();
  if (!picked) {
    throw new AppError(
      "YouTube metadata fetch is unavailable — operator has not configured SERVICE_YOUTUBE_API_KEYS",
      "service_unavailable",
      503,
      { videoId },
    );
  }

  const apiUrl = new URL(`${env.YOUTUBE_API_BASE_URL}/videos`);
  apiUrl.searchParams.set("id", videoId);
  apiUrl.searchParams.set("part", "snippet");
  apiUrl.searchParams.set("key", picked.apiKey);
  apiUrl.searchParams.set("quotaUser", hashApiKeyId(userId));

  const resp = await fetchWithTimeout(apiUrl);
  await incrementUsage({ apiKeyId: picked.apiKeyId, units: 1 });
  if (!resp.ok) {
    logger.warn(
      { videoId, status: resp.status },
      "youtube-metadata: videos.list non-2xx",
    );
    throw new AppError("YouTube API error", "upstream_error", 502, {
      videoId,
      status: resp.status,
    });
  }

  const json = VIDEOS_LIST_RESPONSE.parse(await resp.json());
  const item = json.items[0];
  if (!item || !item.snippet) {
    throw new AppError("video not found on YouTube", "not_found", 404, { videoId });
  }

  // Write-through to cache so the next paste of this URL (by anyone) is a
  // hit. UPSERT on video_id PK; no tenant scope on the cache row.
  const publishedAtDate = item.snippet.publishedAt ? new Date(item.snippet.publishedAt) : null;
  const now = new Date();
  await db
    .insert(youtubeVideos)
    .values({
      videoId: item.id,
      title: item.snippet.title,
      description: item.snippet.description ?? null,
      channelId: item.snippet.channelId ?? null,
      channelTitle: item.snippet.channelTitle ?? null,
      publishedAt: publishedAtDate,
      fetchedAt: now,
    })
    .onConflictDoUpdate({
      target: youtubeVideos.videoId,
      set: {
        title: item.snippet.title,
        description: item.snippet.description ?? null,
        channelId: item.snippet.channelId ?? null,
        channelTitle: item.snippet.channelTitle ?? null,
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
