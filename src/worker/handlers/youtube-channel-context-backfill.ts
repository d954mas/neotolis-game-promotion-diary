// Phase 3.0 Plan 09 — YouTube channel-context backfill handler (D-NEW / D-14).
//
// Triggered on first paste of a video from an unknown channel (Plan 03.0-10
// ingest-channel-context-trigger), this handler resolves the channel's
// uploads playlist id, populates the metadata cache, and seeds the
// youtube_video_snapshots table with the last 50 videos so the user's chart
// loader has historical context immediately.
//
// Quota cost: 1 (channels.list) + N (playlistItems pages, 1≤N≤MAX_PAGES) +
// M (videos.list batches of ≤50 ids each, 1≤M≤MAX_PAGES). Hard upper bound:
// 1 + 4 + 4 = 9 units per backfill. Actual cost depends on backfillWindow:
//   - "1d" / "7d" with low-volume channel: typically 3 units (1+1+1)
//   - "30d" / "90d" with active channel: typically 5–7 units
//   - "everything" or huge channel: capped at 9 units (200 video ceiling)
//
// The pagination loop walks playlistItems pages newest→oldest and stops on
// the first page whose oldest item crosses the cutoff (uploads playlists
// are sorted publishedAt DESC). For "everything" there is no cutoff but the
// MAX_PAGES bound still applies — VIZ-01's chart-loader doesn't need a
// channel's full history, just its visible recency.
//
// Idempotency: youtube_channel_metadata_cache UPSERT on channel_id PK
// (Plan 01); a re-run of this handler for the same channel is a no-op at the
// cache row level. youtube_video_snapshots UNIQUE(video_id, polled_at)
// makes the snapshot inserts idempotent within the same minute.
//
// Auth gate: pickKeyForJob() returning null = SERVICE_YOUTUBE_API_KEYS empty.
// We log+skip rather than throw — this preserves self-host parity (a self-
// hoster who never sets the env var sees a graceful no-op on first paste,
// not a worker crash).

import { sql, and, eq, isNull, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../lib/server/db/client.js";
import { youtubeChannelMetadataCache } from "../../lib/server/db/schema/youtube-channel-metadata-cache.js";
import { youtubeVideoSnapshots } from "../../lib/server/db/schema/youtube-video-snapshots.js";
import { events } from "../../lib/server/db/schema/events.js";
import { dataSources } from "../../lib/server/db/schema/data-sources.js";
import {
  pickKeyForJob,
  hashApiKeyId,
  incrementUsage,
} from "../../lib/server/services/youtube-quota-tracker.js";
import { env } from "../../lib/server/config/env.js";
import { logger } from "../../lib/server/logger.js";

// Zod schemas for the three endpoints — defense against API drift.
const CHANNELS_LIST_RESPONSE = z.object({
  kind: z.literal("youtube#channelListResponse"),
  items: z.array(
    z.object({
      id: z.string(),
      snippet: z.object({ title: z.string() }).optional(),
      contentDetails: z
        .object({
          relatedPlaylists: z.object({ uploads: z.string() }),
        })
        .optional(),
    }),
  ),
});

const PLAYLIST_ITEMS_LIST_RESPONSE = z.object({
  kind: z.literal("youtube#playlistItemListResponse"),
  nextPageToken: z.string().optional(),
  items: z.array(
    z.object({
      snippet: z.object({
        publishedAt: z.string(),
        title: z.string(),
        channelId: z.string(),
        resourceId: z.object({
          kind: z.literal("youtube#video"),
          videoId: z.string(),
        }),
      }),
    }),
  ),
});

// Map UI backfill-window preset → cutoff (or null for "everything"). Uploads
// playlists are sorted publishedAt DESC, so we walk pages from newest down
// and stop the first time we cross the cutoff.
const WINDOW_DAYS: Record<"1d" | "7d" | "30d" | "90d" | "1y", number> = {
  "1d": 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "1y": 365,
};

// Hard upper bound on pages walked (covers the "active channel + everything"
// case where no cutoff is ever crossed). 20 pages × 50 videos = 1000 videos =
// 20 quota units for playlistItems.list. Combined with 20 batched videos.list
// calls (1 unit each) and the upfront channels.list (1 unit), total quota
// cost per backfill is bounded at 41 units (~0.4% of a 10000 daily envelope).
// For channels with >1000 videos that an operator wants to fully ingest,
// this becomes a follow-up: a per-source "continue backfill" job that picks
// up from the last walked pageToken — out of scope for the MVP.
const MAX_PAGES = 20;
const PAGE_SIZE = 50;

const VIDEOS_LIST_RESPONSE = z.object({
  kind: z.literal("youtube#videoListResponse"),
  items: z.array(
    z.object({
      id: z.string(),
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

async function fetchWithTimeout(url: URL, timeoutMs = 30_000): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Parse a YouTube channel URL into either a direct channelId (UC*) or a handle
// (@something). Returns { kind: "channelId", value } when the URL points
// straight at a /channel/UC… identifier, or { kind: "handle", value: "@xxx" }
// for /@handle and /c/legacy and /user/legacy URLs (the latter two also
// resolve via the channels.list?forHandle= path on YouTube's side).
//
// Returns null for unparseable URLs — handler logs+skips, source row stays
// channelId=NULL until the user re-toggles auto-import.
function parseHandleUrl(url: string): { kind: "channelId" | "handle"; value: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)youtube\.com$/i.test(parsed.hostname)) return null;

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;

  const first = segments[0];
  if (!first) return null;

  // /channel/UCxxxxx — direct channelId.
  if (first === "channel" && segments[1]) {
    return { kind: "channelId", value: segments[1] };
  }
  // /@handle — modern handle URL.
  if (first.startsWith("@")) {
    return { kind: "handle", value: first };
  }
  // /c/customname or /user/legacyname — resolvable via forHandle (YouTube
  // accepts a bare name — no @ — alongside @-prefixed handles).
  if ((first === "c" || first === "user") && segments[1]) {
    return { kind: "handle", value: segments[1] };
  }
  return null;
}

const CHANNELS_LIST_FOR_HANDLE_RESPONSE = z.object({
  kind: z.literal("youtube#channelListResponse"),
  items: z.array(
    z.object({
      id: z.string(),
      snippet: z.object({ title: z.string() }).optional(),
      contentDetails: z
        .object({
          relatedPlaylists: z.object({ uploads: z.string() }),
        })
        .optional(),
    }),
  ),
});

// Phase 3.0 unified backfill job shape. Either { channelId } (ingest paste
// flow — Plan 10 already knows the channelId from the parsed video URL) or
// { handleUrl, sourceId } (createSource flow — Plan 12 only knows the URL the
// user typed). Handler resolves handle→channelId in the second case using a
// channels.list?forHandle= call (1 quota unit) and persists the resolved
// channelId back to data_sources so subsequent polls skip the resolution.
export async function handleChannelContextBackfill(job: {
  id: string;
  data: {
    userId: string;
    channelId?: string;
    handleUrl?: string;
    sourceId?: string;
    backfillWindow?: "1d" | "7d" | "30d" | "90d" | "1y" | "everything";
  };
}): Promise<void> {
  const { userId, handleUrl, sourceId } = job.data;
  let channelId = job.data.channelId;

  if (!userId || (!channelId && !handleUrl)) {
    logger.warn(
      { jobId: job.id, channelId, userId, handleUrl },
      "channel-context-backfill: missing userId AND (channelId OR handleUrl)",
    );
    return;
  }

  const picked = pickKeyForJob();
  if (!picked) {
    logger.warn(
      { jobId: job.id, channelId, handleUrl },
      "channel-context-backfill: SERVICE_YOUTUBE_API_KEYS empty; skipping",
    );
    return;
  }

  // 0. Resolve handleUrl → channelId if needed (createSource flow). Handle
  //    URLs come in 4 shapes:
  //      - https://www.youtube.com/channel/UCxxx  → direct channelId
  //      - https://www.youtube.com/@handle         → forHandle lookup
  //      - https://www.youtube.com/c/legacy        → forHandle lookup
  //      - https://www.youtube.com/user/legacy     → forHandle lookup
  if (!channelId && handleUrl) {
    const parsed = parseHandleUrl(handleUrl);
    if (!parsed) {
      logger.warn(
        { jobId: job.id, handleUrl },
        "channel-context-backfill: handleUrl does not parse to a youtube channel; skipping",
      );
      return;
    }
    if (parsed.kind === "channelId") {
      channelId = parsed.value;
    } else {
      // forHandle resolution — 1 quota unit.
      const lookupUrl = new URL(`${env.YOUTUBE_API_BASE_URL}/channels`);
      lookupUrl.searchParams.set("forHandle", parsed.value);
      lookupUrl.searchParams.set("part", "snippet,contentDetails");
      lookupUrl.searchParams.set("key", picked.apiKey);
      lookupUrl.searchParams.set("quotaUser", hashApiKeyId(userId));

      const lookupResp = await fetchWithTimeout(lookupUrl);
      await incrementUsage({ apiKeyId: picked.apiKeyId, units: 1 });
      if (!lookupResp.ok) {
        logger.warn(
          { jobId: job.id, handle: parsed.value, status: lookupResp.status },
          "channel-context-backfill: forHandle lookup non-2xx; skipping",
        );
        return;
      }
      const lookupJson = CHANNELS_LIST_FOR_HANDLE_RESPONSE.parse(await lookupResp.json());
      const item = lookupJson.items[0];
      if (!item) {
        logger.warn(
          { jobId: job.id, handle: parsed.value },
          "channel-context-backfill: forHandle lookup returned no channel; skipping",
        );
        return;
      }
      channelId = item.id;
    }
    // Persist resolved channelId back to data_sources so re-toggles skip
    // resolution. NULL→non-NULL only — never overwrite a stored value with a
    // different one (would mask a renamed channel; out of scope for MVP).
    if (sourceId && channelId) {
      await db
        .update(dataSources)
        .set({ channelId })
        .where(and(eq(dataSources.id, sourceId), isNull(dataSources.channelId)));
    }
  }

  if (!channelId) {
    logger.warn(
      { jobId: job.id, handleUrl },
      "channel-context-backfill: failed to resolve channelId; skipping",
    );
    return;
  }

  // 1. channels.list — 1 quota unit. Resolve uploadsPlaylistId + channelTitle.
  const channelsUrl = new URL(`${env.YOUTUBE_API_BASE_URL}/channels`);
  channelsUrl.searchParams.set("id", channelId);
  channelsUrl.searchParams.set("part", "snippet,contentDetails");
  channelsUrl.searchParams.set("key", picked.apiKey);
  channelsUrl.searchParams.set("quotaUser", hashApiKeyId(userId));

  const channelsResp = await fetchWithTimeout(channelsUrl);
  await incrementUsage({ apiKeyId: picked.apiKeyId, units: 1 });
  if (!channelsResp.ok) {
    logger.warn(
      { jobId: job.id, channelId, status: channelsResp.status },
      "channel-context-backfill: channels.list non-2xx; skipping",
    );
    return;
  }
  const channelsJson = CHANNELS_LIST_RESPONSE.parse(await channelsResp.json());
  const channelItem = channelsJson.items[0];
  const uploadsPlaylistId = channelItem?.contentDetails?.relatedPlaylists?.uploads;
  if (!channelItem || !uploadsPlaylistId) {
    logger.warn(
      { jobId: job.id, channelId, hasItem: !!channelItem },
      "channel-context-backfill: channels.list returned no uploadsPlaylistId; skipping",
    );
    return;
  }
  const channelTitle = channelItem.snippet?.title ?? null;

  // 2. UPSERT youtube_channel_metadata_cache.
  const now = new Date();
  await db
    .insert(youtubeChannelMetadataCache)
    .values({
      channelId,
      uploadsPlaylistId,
      channelTitle,
      lastBackfillAt: now,
    })
    .onConflictDoUpdate({
      target: youtubeChannelMetadataCache.channelId,
      set: {
        uploadsPlaylistId,
        channelTitle,
        lastBackfillAt: now,
        updatedAt: now,
      },
    });

  // 3. playlistItems.list — paginated walk of the uploads playlist, filtered
  //    by `backfillWindow` cutoff. 1 quota unit per page. Stops on first page
  //    crossing cutoff (uploads playlists are sorted publishedAt DESC) or at
  //    MAX_PAGES (4 = 200 video hard cap). For "everything", no cutoff but
  //    same MAX_PAGES bound.
  const window = job.data.backfillWindow ?? "30d";
  const cutoff: Date | null =
    window === "everything" ? null : new Date(now.getTime() - WINDOW_DAYS[window] * 86_400_000);
  const collected: { videoId: string; publishedAt: string }[] = [];
  let pageToken: string | undefined;
  let stopReason: "no_more_pages" | "cutoff_crossed" | "hard_cap" = "no_more_pages";

  for (let page = 0; page < MAX_PAGES; page++) {
    const playlistUrl = new URL(`${env.YOUTUBE_API_BASE_URL}/playlistItems`);
    playlistUrl.searchParams.set("playlistId", uploadsPlaylistId);
    playlistUrl.searchParams.set("part", "snippet");
    playlistUrl.searchParams.set("maxResults", String(PAGE_SIZE));
    playlistUrl.searchParams.set("key", picked.apiKey);
    playlistUrl.searchParams.set("quotaUser", hashApiKeyId(userId));
    if (pageToken) playlistUrl.searchParams.set("pageToken", pageToken);

    const playlistResp = await fetchWithTimeout(playlistUrl);
    await incrementUsage({ apiKeyId: picked.apiKeyId, units: 1 });
    if (!playlistResp.ok) {
      logger.warn(
        { jobId: job.id, channelId, status: playlistResp.status, page },
        "channel-context-backfill: playlistItems.list non-2xx; partial seed",
      );
      break;
    }
    const playlistJson = PLAYLIST_ITEMS_LIST_RESPONSE.parse(await playlistResp.json());

    let crossedCutoffOnThisPage = false;
    for (const it of playlistJson.items) {
      const publishedAt = new Date(it.snippet.publishedAt);
      if (cutoff !== null && publishedAt < cutoff) {
        crossedCutoffOnThisPage = true;
        break;
      }
      collected.push({
        videoId: it.snippet.resourceId.videoId,
        publishedAt: it.snippet.publishedAt,
      });
    }

    if (crossedCutoffOnThisPage) {
      stopReason = "cutoff_crossed";
      break;
    }
    if (!playlistJson.nextPageToken) {
      stopReason = "no_more_pages";
      break;
    }
    if (page === MAX_PAGES - 1) {
      stopReason = "hard_cap";
      break;
    }
    pageToken = playlistJson.nextPageToken;
  }

  if (collected.length === 0) {
    logger.info(
      { jobId: job.id, channelId, window, stopReason },
      "channel-context-backfill: no videos in window",
    );
    return;
  }

  const videoIds = collected.map((c) => c.videoId);

  // 4. videos.list — batched in chunks of 50 (one quota unit per chunk).
  //    Sequential to keep quota accounting simple and pg-boss singleton-key
  //    contention bounded.
  const allItems: z.infer<typeof VIDEOS_LIST_RESPONSE>["items"] = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    const videosUrl = new URL(`${env.YOUTUBE_API_BASE_URL}/videos`);
    videosUrl.searchParams.set("id", chunk.join(","));
    videosUrl.searchParams.set("part", "statistics");
    videosUrl.searchParams.set("key", picked.apiKey);
    videosUrl.searchParams.set("quotaUser", hashApiKeyId(userId));

    const videosResp = await fetchWithTimeout(videosUrl);
    await incrementUsage({ apiKeyId: picked.apiKeyId, units: 1 });
    if (!videosResp.ok) {
      logger.warn(
        { jobId: job.id, channelId, status: videosResp.status, batch: i / 50 },
        "channel-context-backfill: videos.list non-2xx; partial seed",
      );
      continue;
    }
    const videosJson = VIDEOS_LIST_RESPONSE.parse(await videosResp.json());
    allItems.push(...videosJson.items);
  }

  // 5. INSERT snapshot rows. ON CONFLICT DO NOTHING on (video_id, polled_at)
  //    UNIQUE — re-run within the same minute is a no-op at row level.
  for (const item of allItems) {
    const stats = item.statistics;
    if (!stats) continue;
    await db
      .insert(youtubeVideoSnapshots)
      .values({
        videoId: item.id,
        polledAt: sql`date_trunc('minute', now())` as unknown as Date,
        viewCount: Number(stats.viewCount ?? 0),
        likeCount: Number(stats.likeCount ?? 0),
        commentCount: Number(stats.commentCount ?? 0),
      })
      .onConflictDoNothing();
  }

  // 6. Mark events.last_polled_at on ANY events the user owns matching these
  //    video ids — so the polling badge shows fresh state right after paste.
  //    Tenant-scoped via userId; idempotent on re-run.
  await db
    .update(events)
    .set({ lastPolledAt: now, lastPollStatus: "ok" })
    .where(
      and(
        eq(events.userId, userId),
        sql`${events.kind} = 'youtube_video'`,
        sql`${events.externalId} IN (${sql.join(
          videoIds.map((vid) => sql`${vid}`),
          sql`, `,
        )})`,
        isNotNull(events.externalId),
        isNull(events.deletedAt),
      ),
    );

  logger.info(
    {
      jobId: job.id,
      channelId,
      userId,
      window,
      stopReason,
      videoCount: videoIds.length,
    },
    "channel-context-backfill: complete",
  );
}
