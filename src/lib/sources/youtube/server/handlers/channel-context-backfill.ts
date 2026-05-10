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
import { db } from "$lib/server/db/client.js";
import {
  youtubeChannels,
  youtubeVideoSnapshots,
  youtubeVideos,
} from "$lib/server/db/schema/index.js";
import { events } from "$lib/server/db/schema/events.js";
import { dataSources } from "$lib/server/db/schema/data-sources.js";
import { pickKeyForJob, youtubeQuotaUser } from "../quota.js";
import { chargedFetch } from "../http.js";
import { env } from "$lib/server/config/env.js";
import { parseYoutubeUrl } from "../url.js";
import { logger } from "$lib/server/logger.js";
import { AdapterError } from "$lib/sources/errors.js";
import { markSourceNeedsReconnect } from "$lib/server/services/data-sources.js";
import {
  markChannelLastPolledAt,
  markChannelBackfillFrontier,
} from "$lib/server/services/channel-state.js";
import { writeAudit } from "$lib/server/audit.js";

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

// fetchWithTimeout + chargedFetch moved to $lib/sources/youtube/server/http.ts
// (post-build review 2026-05-08) so $lib/sources/youtube/server/metadata.ts and
// $lib/sources/youtube/server/adapter.ts share the same charge-on-Response +
// throttle-audit-on-403-quotaExceeded contract.

// YouTube URL parsing moved to $lib/sources/youtube/server/url.ts (Phase 03.0.1
// Plan 04 — pre-Plan 04 path: services/youtube-url.ts) — see that module's
// header for the rationale.

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
  // Plan 08 (D-13) AdapterError envelope. The body throws AdapterError on
  // upstream non-2xx; route by category:
  //   - rate-limited → re-throw (pg-boss retries with retryAfterMs)
  //   - operator-issue / permanent → mark source needs_reconnect and swallow
  //     (the operator must intervene; pg-boss retries are pointless)
  //   - not-found → swallow (the channel/video is gone; the source itself
  //     may be fine — we don't flag it)
  //   - transient → re-throw (pg-boss retries with backoff)
  // Cron-context handler: only flips needs_reconnect when sourceId is in
  // the job payload (createSource flow). Ingest-flow jobs (channelId-only)
  // don't carry a sourceId, so non-transient errors there log+swallow.
  try {
    await handleChannelContextBackfillImpl(job);
  } catch (err) {
    if (err instanceof AdapterError) {
      const { userId: uId, sourceId: sId } = job.data;
      if (err.category === "rate-limited" || err.category === "transient") {
        logger.info(
          { jobId: job.id, category: err.category, retryAfterMs: err.retryAfterMs },
          "channel-context-backfill: AdapterError → pg-boss retry",
        );
        throw err;
      }
      if ((err.category === "operator-issue" || err.category === "permanent") && uId && sId) {
        await markSourceNeedsReconnect(uId, sId, err.category);
      }
      logger.warn(
        { jobId: job.id, category: err.category, sourceId: sId, userId: uId },
        "channel-context-backfill: AdapterError swallowed (worker won't retry)",
      );
      return;
    }
    throw err;
  }
}

async function handleChannelContextBackfillImpl(job: {
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
  // Phase 3.0 post-build (2026-05-07): track the alias input that triggered
  // this backfill. After resolving handle/legacy/video URL → UC id we write
  // the alias into youtube_channels.handle_aliases so the next ingest paste
  // of the same alias hits the cache directly. Captured BEFORE resolution
  // because `channelId` is reassigned to the UC id mid-flow.
  //   - From ingest path: job.data.channelId may be the raw URL string
  //     ("https://youtube.com/@handle") when ingest could not extract a UC
  //     id; that string is the alias to record on the resolved row.
  //   - From createSource path: job.data.handleUrl carries the user's
  //     pasted URL; same alias treatment.
  const aliasInputCandidate = handleUrl ?? job.data.channelId ?? null;

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
    const parsed = parseYoutubeUrl(handleUrl);
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
      videoUrl.searchParams.set("quotaUser", youtubeQuotaUser(userId));

      const videoResp = await chargedFetch(videoUrl, picked, 1, {
        jobId: job.id,
        videoId: parsed.value,
        origin: "cron",
        logTag: "channel-context-backfill: videos.list lookup",
      });
      if (!videoResp.ok) return; // Plan 08: chargedFetch throws on non-2xx; this is dead-code defense — caught by the outer try/catch.
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
      lookupUrl.searchParams.set("quotaUser", youtubeQuotaUser(userId));

      const lookupResp = await chargedFetch(lookupUrl, picked, 1, {
        jobId: job.id,
        handle: parsed.value,
        origin: "cron",
        logTag: "channel-context-backfill: forHandle lookup",
      });
      if (!lookupResp.ok) return; // dead-code defense — chargedFetch throws on non-2xx in Plan 08.
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
        .where(
          and(
            eq(dataSources.id, sourceId),
            eq(dataSources.userId, userId),
            isNull(dataSources.channelId),
          ),
        );
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
  channelsUrl.searchParams.set("quotaUser", youtubeQuotaUser(userId));

  const channelsResp = await chargedFetch(channelsUrl, picked, 1, {
    jobId: job.id,
    channelId,
    origin: "cron",
    logTag: "channel-context-backfill: channels.list",
  });
  if (!channelsResp.ok) return; // dead-code defense — chargedFetch throws on non-2xx in Plan 08.
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

  // 2a. Append the resolved-from URL to handle_aliases (Phase 3.0 post-build,
  //     2026-05-07). Fixes the handle-URL cache miss documented in the
  //     build-phase code review (bug-3): ingest's cache lookup now widens
  //     with `OR $key = ANY(handle_aliases)`, so any future paste of the
  //     same handle URL hits the row directly — no enqueue, no quota.
  //     Skip writes when:
  //       - aliasInputCandidate is null (no input URL captured);
  //       - the alias equals the resolved channelId (UC-only path: already
  //         covered by the PK lookup, no alias needed);
  //       - the alias is already in the array (`!= ALL` predicate keeps
  //         the column free of duplicates without a SELECT round-trip).
  if (aliasInputCandidate && aliasInputCandidate !== channelId) {
    await db
      .update(youtubeChannels)
      .set({
        handleAliases: sql`array_append(${youtubeChannels.handleAliases}, ${aliasInputCandidate})`,
        updatedAt: now,
      })
      .where(
        and(
          eq(youtubeChannels.channelId, channelId),
          sql`${aliasInputCandidate} != ALL(${youtubeChannels.handleAliases})`,
        ),
      );
  }

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
    playlistUrl.searchParams.set("quotaUser", youtubeQuotaUser(userId));
    if (pageToken) playlistUrl.searchParams.set("pageToken", pageToken);

    const playlistResp = await chargedFetch(playlistUrl, picked, 1, {
      jobId: job.id,
      channelId,
      page,
      origin: "cron",
      logTag: "channel-context-backfill: playlistItems.list",
    });
    if (!playlistResp.ok) break; // dead-code defense — chargedFetch throws on non-2xx in Plan 08.
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
    videosUrl.searchParams.set("quotaUser", youtubeQuotaUser(userId));

    const videosResp = await chargedFetch(videosUrl, picked, 1, {
      jobId: job.id,
      channelId,
      batch: i / 50,
      origin: "cron",
      logTag: "channel-context-backfill: videos.list",
    });
    if (!videosResp.ok) continue; // dead-code defense — chargedFetch throws on non-2xx in Plan 08.
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
    // Tenant-scoped lookup — Pattern 1. The job payload pairs sourceId
    // with userId; even though pg-boss won't deliver a malformed job,
    // the eq(userId) filter is the load-bearing guarantee that we never
    // read another tenant's source row.
    const sourceRow = await db
      .select({ isOwnedByMe: dataSources.isOwnedByMe })
      .from(dataSources)
      .where(and(eq(dataSources.id, sourceId), eq(dataSources.userId, userId)))
      .limit(1);
    authorIsMe = sourceRow[0]?.isOwnedByMe ?? false;

    // Auto-import idempotency: pre-insert SELECT scoped by `sourceId`.
    //
    // Phase 3.0 post-build review (2026-05-07): pre-fix, the SELECT skipped
    // any user/external_id match regardless of sourceId, which silently
    // dropped backfill writes when:
    //   - the user previously manually pasted the same video (sourceId=NULL
    //     — backfill saw it and skipped, source page showed "0 imported"),
    //   - a different source already auto-imported the same video (rare,
    //     requires two sources pointing at the same upstream channel).
    //
    // Schema unique `events_user_kind_source_ext_unq` already permits
    // multiple rows for the same external_id when sourceId differs — it
    // ONLY blocks duplicate inserts within a single source. Scoping the
    // pre-insert SELECT to match makes backfill honest:
    //   - A re-run of THIS source's backfill is idempotent (sourceId-scoped
    //     SELECT finds existing → skip).
    //   - Cross-source double-import is preserved (different sourceId →
    //     SELECT misses → INSERT proceeds → schema unique permits).
    //   - Manual paste events (sourceId=NULL) live in their own world and
    //     never collide with auto-import (sourceId-scoped SELECT excludes
    //     them by construction).
    //
    // Defense in depth: even if a race causes the SELECT to miss a
    // concurrent INSERT, the partial UNIQUE on (user_id, kind, source_id,
    // external_id) WHERE source_id IS NOT NULL catches it at DB-level.
    //
    // REGRESSION RISK: the `eq(events.sourceId, sourceId)` filter is
    // load-bearing. A future reader who removes it (thinking
    // "just one event per video") will silently re-introduce the bug
    // where a user's manual paste blocks the auto-import event for the
    // same video. Integration test pinning this is filed as
    // .planning/todos/pending/2026-05-07-channel-context-backfill-handler-integration-test.md
    // (the existing test infra does not cover the handler holistically).
    const existing = await db
      .select({ externalId: events.externalId })
      .from(events)
      .where(
        and(
          eq(events.userId, userId),
          eq(events.sourceId, sourceId),
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
      // onConflictDoNothing — race-safe against parallel
      // channel-context-backfill jobs (singletonKey window edge,
      // pgboss restart). Optimistic SELECT is the fast path; UNIQUE
      // is the DB-level defense.
      await db
        .insert(events)
        .values({
          userId,
          sourceId,
          kind: "youtube_video",
          authorIsMe,
          occurredAt: new Date(c.publishedAt),
          title: c.title,
          url: `https://www.youtube.com/watch?v=${c.videoId}`,
          externalId: c.videoId,
        })
        .onConflictDoNothing();
    }
  }

  // 7. Phase 3.0 post-build refactor (2026-05-06): polling state lives on
  //    youtube_videos now, not on events. The youtube_videos UPSERT in step
  //    5a already wrote {title, description, channel_*, published_at,
  //    fetched_at} for every collected video. We extend it here by stamping
  //    last_polled_at + last_poll_status='ok' on those rows so the tier
  //    resolver classifies them as Active/Cold/Frozen (not 'pending') as
  //    soon as the backfill completes. PUBLIC-DATA TABLE — no userId filter.
  if (videoIds.length > 0) {
    await db
      .update(youtubeVideos)
      .set({
        lastPolledAt: now,
        lastPollStatus: "ok",
        pollFailureCount: 0,
      })
      .where(
        sql`${youtubeVideos.videoId} IN (${sql.join(
          videoIds.map((vid) => sql`${vid}`),
          sql`, `,
        )})`,
      );
  }

  // Phase 03.0.1 — backfill state machine + audit metadata for cap counter.
  // State updates only happen когда sourceId is present (createSource flow,
  // not generic ingest path). Audit row written в both cases — ingest flow
  // (no sourceId) gets minimal metadata (no source_id field).
  if (sourceId && channelId !== null) {
    // Phase 03.0.1 Wave 4 — channel-scoped state writes. Per-source state
    // columns (last_polled_at, backfill_oldest_at) dropped in migration 0028;
    // channel state is the single source of truth across all subscribers.
    await markChannelLastPolledAt("youtube_channel", channelId);
    if (videoIds.length > 0) {
      const oldestRow = await db
        .select({ at: youtubeVideos.publishedAt })
        .from(youtubeVideos)
        .where(
          sql`${youtubeVideos.videoId} IN (${sql.join(
            videoIds.map((vid) => sql`${vid}`),
            sql`, `,
          )})`,
        )
        .orderBy(sql`${youtubeVideos.publishedAt} ASC NULLS LAST`)
        .limit(1);
      const oldest = oldestRow[0]?.at ?? null;
      if (oldest !== null) {
        await markChannelBackfillFrontier("youtube_channel", channelId, oldest);
      }
    }
  }

  // Audit row — counted ONLY when sourceId is present (per-source cap accounting).
  // Ingest-paste channel-context (no sourceId) is operator-side cache hydration,
  // not user-initiated quota burn — we skip the audit row to avoid polluting cap
  // queries with rows that have no source_id.
  if (sourceId) {
    // Estimate quota units burned: 1 (channels.list) + N pages of playlistItems
    // + M batches of videos.list. Conservative estimate from videoIds.length.
    const requestsUsed = 1 + Math.max(1, Math.ceil(videoIds.length / 50)) * 2;
    await writeAudit({
      userId,
      action: "source.refresh_content_requested",
      ipAddress: "0.0.0.0",
      metadata: {
        source_id: sourceId,
        kind: "youtube_channel",
        // Phase 03.0.1 (post-review) — `platform` for cap-query consistency.
        // 'initial' flow excluded from cap by design (onboarding UX), but we
        // set platform anyway so audit aggregation stays uniform across all
        // refresh-related verbs.
        platform: "youtube_channel",
        flow: "initial",
        queue: "youtube.channel_context_backfill",
        job_id: job.id ?? null,
        requests_used: requestsUsed,
        events_inserted: videoIds.length,
      },
    });
  }

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
