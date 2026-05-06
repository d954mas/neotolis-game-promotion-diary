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
import { youtubeChannels } from "../../lib/server/db/schema/youtube-channels.js";
import { youtubeVideoSnapshots } from "../../lib/server/db/schema/youtube-video-snapshots.js";
import { youtubeVideos } from "../../lib/server/db/schema/youtube-videos.js";
import { events } from "../../lib/server/db/schema/events.js";
import { dataSources } from "../../lib/server/db/schema/data-sources.js";
import {
  pickKeyForJob,
  quotaUserId,
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
      // Phase 3.0 post-build: snippet now travels alongside statistics so
      // the same 1-quota-unit batched call seeds youtube_video_metadata_cache
      // with title/description/channel info. Saves the /events/new "Get
      // from YouTube" button from a redundant call when the video has
      // already been backfilled.
      snippet: z
        .object({
          title: z.string(),
          description: z.string().optional(),
          channelId: z.string().optional(),
          channelTitle: z.string().optional(),
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

async function fetchWithTimeout(url: URL, timeoutMs = 30_000): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Parse a YouTube URL into one of three shapes the handler can resolve:
//   - {kind: "channelId"} — straight at a /channel/UC… identifier (zero
//     extra quota; we already have the channel id we need).
//   - {kind: "handle"}    — /@handle, /c/legacy, /user/legacy. Resolves via
//     channels.list?forHandle=… (1 unit).
//   - {kind: "videoId"}   — /watch?v=…, /shorts/…, /embed/…, youtu.be/…
//     The URL points at a video; we fetch videos.list?part=snippet to learn
//     the video's channelId, then continue from there (1 unit). User-friendly:
//     pasting any YouTube URL into /sources/new works.
//
// Returns null only for non-YouTube hosts or unparseable strings.
function parseHandleUrl(
  url: string,
): { kind: "channelId" | "handle" | "videoId"; value: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();

  // youtu.be/ID — short share URL, video.
  if (host === "youtu.be") {
    const id = parsed.pathname.replace(/^\//, "").split("/")[0];
    return id ? { kind: "videoId", value: id } : null;
  }

  if (!/(^|\.)youtube\.com$/i.test(host)) return null;

  // /watch?v=ID — full watch URL, video.
  if (parsed.pathname === "/watch") {
    const v = parsed.searchParams.get("v");
    return v ? { kind: "videoId", value: v } : null;
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;

  const first = segments[0];
  if (!first) return null;

  // /shorts/ID and /embed/ID — also videos.
  if ((first === "shorts" || first === "embed") && segments[1]) {
    return { kind: "videoId", value: segments[1] };
  }

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
    } else if (parsed.kind === "videoId") {
      // /watch, /shorts, /embed, youtu.be — user pasted a video URL into
      // the source registration form. Resolve via videos.list?part=snippet
      // (1 quota unit) → snippet.channelId. More user-friendly than
      // rejecting; users routinely paste any YouTube URL when adding a
      // channel.
      const videoUrl = new URL(`${env.YOUTUBE_API_BASE_URL}/videos`);
      videoUrl.searchParams.set("id", parsed.value);
      videoUrl.searchParams.set("part", "snippet");
      videoUrl.searchParams.set("key", picked.apiKey);
      videoUrl.searchParams.set("quotaUser", quotaUserId(userId));

      const videoResp = await fetchWithTimeout(videoUrl);
      await incrementUsage({ apiKeyId: picked.apiKeyId, units: 1 });
      if (!videoResp.ok) {
        logger.warn(
          { jobId: job.id, videoId: parsed.value, status: videoResp.status },
          "channel-context-backfill: videos.list lookup non-2xx; skipping",
        );
        return;
      }
      const videoJson = VIDEOS_LIST_RESPONSE.parse(await videoResp.json());
      const v = videoJson.items[0];
      if (!v || !v.snippet?.channelId) {
        logger.warn(
          { jobId: job.id, videoId: parsed.value },
          "channel-context-backfill: videos.list lookup returned no channelId; skipping",
        );
        return;
      }
      channelId = v.snippet.channelId;
    } else {
      // forHandle resolution — 1 quota unit.
      const lookupUrl = new URL(`${env.YOUTUBE_API_BASE_URL}/channels`);
      lookupUrl.searchParams.set("forHandle", parsed.value);
      lookupUrl.searchParams.set("part", "snippet,contentDetails");
      lookupUrl.searchParams.set("key", picked.apiKey);
      lookupUrl.searchParams.set("quotaUser", quotaUserId(userId));

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
  channelsUrl.searchParams.set("quotaUser", quotaUserId(userId));

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
    .insert(youtubeChannels)
    .values({
      channelId,
      uploadsPlaylistId,
      channelTitle,
      lastBackfillAt: now,
    })
    .onConflictDoUpdate({
      target: youtubeChannels.channelId,
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
  const collected: { videoId: string; publishedAt: string; title: string }[] = [];
  let pageToken: string | undefined;
  let stopReason: "no_more_pages" | "cutoff_crossed" | "hard_cap" = "no_more_pages";

  for (let page = 0; page < MAX_PAGES; page++) {
    const playlistUrl = new URL(`${env.YOUTUBE_API_BASE_URL}/playlistItems`);
    playlistUrl.searchParams.set("playlistId", uploadsPlaylistId);
    playlistUrl.searchParams.set("part", "snippet");
    playlistUrl.searchParams.set("maxResults", String(PAGE_SIZE));
    playlistUrl.searchParams.set("key", picked.apiKey);
    playlistUrl.searchParams.set("quotaUser", quotaUserId(userId));
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
        title: it.snippet.title,
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
    videosUrl.searchParams.set("part", "snippet,statistics");
    videosUrl.searchParams.set("key", picked.apiKey);
    videosUrl.searchParams.set("quotaUser", quotaUserId(userId));

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

  // 5a. UPSERT youtube_video_metadata_cache (Phase 3.0 post-build,
  //     UAT 2026-05-06). One row per video, no time-series — title /
  //     description / channel only. The snippet half of videos.list lands
  //     here so the /events/new "Get from YouTube" button can read it
  //     for free on a re-paste of the same video.
  for (const item of allItems) {
    const sn = item.snippet;
    if (!sn) continue;
    const publishedAt = sn.publishedAt ? new Date(sn.publishedAt) : null;
    await db
      .insert(youtubeVideos)
      .values({
        videoId: item.id,
        title: sn.title,
        description: sn.description ?? null,
        channelId: sn.channelId ?? null,
        channelTitle: sn.channelTitle ?? null,
        publishedAt,
        fetchedAt: now,
      })
      .onConflictDoUpdate({
        target: youtubeVideos.videoId,
        set: {
          title: sn.title,
          description: sn.description ?? null,
          channelId: sn.channelId ?? null,
          channelTitle: sn.channelTitle ?? null,
          publishedAt,
          fetchedAt: now,
          updatedAt: now,
        },
      });
  }

  // 5b. INSERT snapshot rows. ON CONFLICT DO NOTHING on (video_id, polled_at)
  //     UNIQUE — re-run within the same minute is a no-op at row level.
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

  // 6. Auto-import event creation. When this backfill was triggered by
  //    /sources/new (sourceId provided + handleUrl path), the user expects
  //    each discovered video to surface in /feed. Read author_is_me from
  //    the parent data_source — its is_owned_by_me flag determines whether
  //    these events count as the user's own posts (Mine) or as tracked
  //    coverage (Tracking). For the ingest paste path (sourceId NOT provided)
  //    the event is already created by the ingest service, so we skip this
  //    block and only step 7 below refreshes its lastPolledAt timestamp.
  let authorIsMe = false;
  if (sourceId) {
    const sourceRow = await db
      .select({ isOwnedByMe: dataSources.isOwnedByMe })
      .from(dataSources)
      .where(eq(dataSources.id, sourceId))
      .limit(1);
    authorIsMe = sourceRow[0]?.isOwnedByMe ?? false;

    // Auto-import idempotency: pre-insert SELECT instead of relying on the
    // (user_id, kind, external_id) unique that was dropped in migration 0013.
    // For each discovered video — if this user already has ANY event for that
    // external_id (auto-imported or manual paste), skip the insert. Step 7
    // below will bump lastPolledAt on the existing row(s). New videos land
    // as fresh events. The user can still manually create additional events
    // for the same video via the future "add another note" UI flow (the
    // schema now allows it; the worker is intentionally idempotent for
    // discovery, not user-driven duplication).
    const existing = await db
      .select({ externalId: events.externalId })
      .from(events)
      .where(
        and(
          eq(events.userId, userId),
          sql`${events.kind} = 'youtube_video'`,
          sql`${events.externalId} IN (${sql.join(
            collected.map((c) => sql`${c.videoId}`),
            sql`, `,
          )})`,
          isNotNull(events.externalId),
          isNull(events.deletedAt),
        ),
      );
    const existingIds = new Set(existing.map((r) => r.externalId).filter((x): x is string => !!x));

    for (const c of collected) {
      if (existingIds.has(c.videoId)) continue;
      await db.insert(events).values({
        userId,
        sourceId,
        kind: "youtube_video",
        authorIsMe,
        occurredAt: new Date(c.publishedAt),
        title: c.title,
        url: `https://www.youtube.com/watch?v=${c.videoId}`,
        externalId: c.videoId,
        lastPolledAt: now,
        lastPollStatus: "ok",
      });
    }
  }

  // 7. For the ingest-paste path (or any pre-existing event the user owns
  //    matching one of these video ids), bump last_polled_at to "now" so the
  //    polling badge shows fresh state. Idempotent on re-run; the source-
  //    backed events already had their timestamps set by the upsert above.
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
