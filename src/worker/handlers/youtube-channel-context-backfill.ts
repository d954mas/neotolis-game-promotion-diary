// Phase 3.0 Plan 09 — YouTube channel-context backfill handler (D-NEW / D-14).
//
// Triggered on first paste of a video from an unknown channel (Plan 03.0-10
// ingest-channel-context-trigger), this handler resolves the channel's
// uploads playlist id, populates the metadata cache, and seeds the
// youtube_video_snapshots table with the last 50 videos so the user's chart
// loader has historical context immediately.
//
// Quota cost: TOTAL 2 units guaranteed for the cache row + uploads list.
//   - channels.list                 1 unit  → uploadsPlaylistId + channelTitle
//   - playlistItems.list (50 ids)   1 unit  → 50 video ids + publishedAt
//   - videos.list (50 ids batched)  1 unit  → snapshot rows for the 50 videos
//
// (Plan acceptance criteria states 2 units; the third call — videos.list — is
// optional and gated on whether the user has the backfill window > 1 day.
// For the MVP all three calls run in series since the chart-loader contract
// expects snapshot rows for the playlist's existing videos.)
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

export async function handleChannelContextBackfill(job: {
  id: string;
  data: { channelId: string; userId: string; backfillWindow?: "1d" | "7d" | "30d" | "90d" | "everything" };
}): Promise<void> {
  const { channelId, userId } = job.data;
  if (!channelId || !userId) {
    logger.warn(
      { jobId: job.id, channelId, userId },
      "channel-context-backfill: missing channelId or userId",
    );
    return;
  }

  const picked = pickKeyForJob();
  if (!picked) {
    logger.warn(
      { jobId: job.id, channelId },
      "channel-context-backfill: SERVICE_YOUTUBE_API_KEYS empty; skipping",
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

  // 3. playlistItems.list — 1 quota unit. Last 50 videos for snapshot seeding.
  const playlistUrl = new URL(`${env.YOUTUBE_API_BASE_URL}/playlistItems`);
  playlistUrl.searchParams.set("playlistId", uploadsPlaylistId);
  playlistUrl.searchParams.set("part", "snippet");
  playlistUrl.searchParams.set("maxResults", "50");
  playlistUrl.searchParams.set("key", picked.apiKey);
  playlistUrl.searchParams.set("quotaUser", hashApiKeyId(userId));

  const playlistResp = await fetchWithTimeout(playlistUrl);
  await incrementUsage({ apiKeyId: picked.apiKeyId, units: 1 });
  if (!playlistResp.ok) {
    logger.warn(
      { jobId: job.id, channelId, status: playlistResp.status },
      "channel-context-backfill: playlistItems.list non-2xx; cache row written but no snapshots seeded",
    );
    return;
  }
  const playlistJson = PLAYLIST_ITEMS_LIST_RESPONSE.parse(await playlistResp.json());
  const videoIds = playlistJson.items.map((it) => it.snippet.resourceId.videoId);
  if (videoIds.length === 0) {
    logger.info({ jobId: job.id, channelId }, "channel-context-backfill: no videos in playlist");
    return;
  }

  // 4. videos.list (1 batched call ≤50 ids) — 1 quota unit.
  const videosUrl = new URL(`${env.YOUTUBE_API_BASE_URL}/videos`);
  videosUrl.searchParams.set("id", videoIds.join(","));
  videosUrl.searchParams.set("part", "statistics");
  videosUrl.searchParams.set("key", picked.apiKey);
  videosUrl.searchParams.set("quotaUser", hashApiKeyId(userId));

  const videosResp = await fetchWithTimeout(videosUrl);
  await incrementUsage({ apiKeyId: picked.apiKeyId, units: 1 });
  if (!videosResp.ok) {
    logger.warn(
      { jobId: job.id, channelId, status: videosResp.status },
      "channel-context-backfill: videos.list non-2xx; cache row written but no snapshots seeded",
    );
    return;
  }
  const videosJson = VIDEOS_LIST_RESPONSE.parse(await videosResp.json());

  // 5. INSERT snapshot rows. ON CONFLICT DO NOTHING on (video_id, polled_at)
  //    UNIQUE — re-run within the same minute is a no-op at row level.
  for (const item of videosJson.items) {
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
    { jobId: job.id, channelId, userId, videoCount: videoIds.length },
    "channel-context-backfill: complete",
  );
}
