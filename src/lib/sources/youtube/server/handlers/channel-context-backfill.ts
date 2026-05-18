// YouTube channel-context backfill handler.
//
// Triggered on first paste of a video from an unknown channel, this handler
// resolves the channel's uploads playlist id, populates the metadata cache,
// and seeds the youtube_video_snapshots table with the last 50 videos so
// the chart loader has historical context immediately.
//
// Quota cost: 1 (channels.list) + N (playlistItems pages, 1в‰¤Nв‰¤MAX_PAGES) +
// M (videos.list batches of в‰¤50 ids each, 1в‰¤Mв‰¤MAX_PAGES). Hard upper bound:
// 1 + 4 + 4 = 9 units per backfill. Actual cost depends on backfillWindow:
//   - "1d" / "7d" with low-volume channel: typically 3 units (1+1+1)
//   - "30d" / "90d" with active channel: typically 5вЂ“7 units
//   - "everything" or huge channel: capped at 9 units (200 video ceiling)
//
// The pagination loop walks playlistItems pages newestв†’oldest and stops on
// the first page whose oldest item crosses the cutoff (uploads playlists
// are sorted publishedAt DESC). For "everything" there is no cutoff but
// the MAX_PAGES bound still applies вЂ” the chart loader doesn't need a
// channel's full history, just its visible recency.
//
// Idempotency: youtube_channels UPSERT on channel_id PK; a re-run of this
// handler for the same channel is a no-op at the cache row level.
// youtube_video_snapshots UNIQUE(video_id, polled_at) makes the snapshot
// inserts idempotent within the same minute.
//
// Auth gate: empty SERVICE_YOUTUBE_API_KEYS. We log+skip rather than
// throw, preserving self-host parity: a
// self-hoster who never sets the env var sees a graceful no-op on first
// paste, not a worker crash).

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
import { hasYoutubeApiKeys, youtubeQuotaUser } from "../quota.js";
import { chargedFetch } from "../http.js";
import { env } from "$lib/server/config/env.js";
import { parseYoutubeUrl } from "../url.js";
import { logger } from "$lib/server/logger.js";
import { AdapterError } from "$lib/sources/errors.js";
import { markSourceNeedsReconnect } from "$lib/server/services/data-sources.js";
import {
  markChannelLastPolledAt,
  markChannelBackfillFrontier,
  markChannelBackfillComplete,
  setChannelBackfillPageToken,
} from "$lib/server/services/channel-state.js";
import { writeAudit } from "$lib/server/audit.js";

// Zod schemas for the three endpoints вЂ” defense against API drift.
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

// Map UI backfill-window preset в†’ cutoff (or null for "everything"). Uploads
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
// case where no cutoff is ever crossed). 20 pages Г— 50 videos = 1000 videos =
// 20 quota units for playlistItems.list. Combined with 20 batched videos.list
// calls (1 unit each) and the upfront channels.list (1 unit), total quota
// cost per backfill is bounded at 41 units (~0.4% of a 10000 daily envelope).
// For channels with >1000 videos that an operator wants to fully ingest,
// this becomes a follow-up: a per-source "continue backfill" job that picks
// up from the last walked pageToken вЂ” out of scope for the MVP.
const MAX_PAGES = 20;
const PAGE_SIZE = 50;

const VIDEOS_LIST_RESPONSE = z.object({
  kind: z.literal("youtube#videoListResponse"),
  items: z.array(
    z.object({
      id: z.string(),
      // Snippet travels alongside statistics so the same 1-quota-unit
      // batched call seeds youtube_videos with title/description/channel
      // info. Saves the /events/new "Get from YouTube" button from a
      // redundant call when the video has already been backfilled.
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

// fetchWithTimeout + chargedFetch live in $lib/sources/youtube/server/http.ts
// so $lib/sources/youtube/server/metadata.ts and
// $lib/sources/youtube/server/adapter.ts share the same charge-on-Response +
// throttle-audit-on-403-quotaExceeded contract.

// YouTube URL parsing lives in $lib/sources/youtube/server/url.ts вЂ” see
// that module's header for the rationale.

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

// Unified backfill job shape. Either { channelId } (ingest paste flow
// already knows the channelId from the parsed video URL) or
// { handleUrl, sourceId } (createSource flow only knows the URL the user
// typed). Handler resolves handleв†’channelId in the second case using a
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
  // AdapterError envelope. The body throws AdapterError on upstream
  // non-2xx; route by category:
  //   - rate-limited в†’ re-throw (pg-boss retries with retryAfterMs)
  //   - operator-issue / permanent в†’ mark source needs_reconnect and swallow
  //     (the operator must intervene; pg-boss retries are pointless)
  //   - not-found в†’ swallow (the channel/video is gone; the source itself
  //     may be fine вЂ” we don't flag it)
  //   - transient в†’ re-throw (pg-boss retries with backoff)
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
          "channel-context-backfill: AdapterError в†’ pg-boss retry",
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
  // Track the alias input that triggered this backfill. After resolving
  // handle/legacy/video URL в†’ UC id we write the alias into
  // youtube_channels.handle_aliases so the next ingest paste of the same
  // alias hits the cache directly. Captured BEFORE resolution because
  // `channelId` is reassigned to the UC id mid-flow.
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

  if (!hasYoutubeApiKeys()) {
    logger.warn(
      { jobId: job.id, channelId, handleUrl },
      "channel-context-backfill: SERVICE_YOUTUBE_API_KEYS empty; skipping",
    );
    return;
  }

  // 0. Resolve handleUrl в†’ channelId if needed (createSource flow). Handle
  //    URLs come in 4 shapes:
  //      - https://www.youtube.com/channel/UCxxx  в†’ direct channelId
  //      - https://www.youtube.com/@handle         в†’ forHandle lookup
  //      - https://www.youtube.com/c/legacy        в†’ forHandle lookup
  //      - https://www.youtube.com/user/legacy     в†’ forHandle lookup
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
      // /watch, /shorts, /embed, youtu.be вЂ” user pasted a video URL into
      // the source registration form. Resolve via videos.list?part=snippet
      // (1 quota unit) в†’ snippet.channelId. More user-friendly than
      // rejecting; users routinely paste any YouTube URL when adding a
      // channel.
      const videoUrl = new URL(`${env.YOUTUBE_API_BASE_URL}/videos`);
      videoUrl.searchParams.set("id", parsed.value);
      videoUrl.searchParams.set("part", "snippet");
      videoUrl.searchParams.set("quotaUser", youtubeQuotaUser(userId));

      const videoResp = await chargedFetch(videoUrl, 1, {
        jobId: job.id,
        videoId: parsed.value,
        origin: "cron",
        logTag: "channel-context-backfill: videos.list lookup",
      });
      if (!videoResp.ok) return; // chargedFetch throws on non-2xx; this is dead-code defense вЂ” caught by the outer try/catch.
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
      // forHandle resolution вЂ” 1 quota unit.
      const lookupUrl = new URL(`${env.YOUTUBE_API_BASE_URL}/channels`);
      lookupUrl.searchParams.set("forHandle", parsed.value);
      lookupUrl.searchParams.set("part", "snippet,contentDetails");
      lookupUrl.searchParams.set("quotaUser", youtubeQuotaUser(userId));

      const lookupResp = await chargedFetch(lookupUrl, 1, {
        jobId: job.id,
        handle: parsed.value,
        origin: "cron",
        logTag: "channel-context-backfill: forHandle lookup",
      });
      if (!lookupResp.ok) return; // dead-code defense вЂ” chargedFetch throws on non-2xx.
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
    // resolution. NULLв†’non-NULL only вЂ” never overwrite a stored value with a
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

  // 1. channels.list вЂ” 1 quota unit. Resolve uploadsPlaylistId + channelTitle.
  const channelsUrl = new URL(`${env.YOUTUBE_API_BASE_URL}/channels`);
  channelsUrl.searchParams.set("id", channelId);
  channelsUrl.searchParams.set("part", "snippet,contentDetails");
  channelsUrl.searchParams.set("quotaUser", youtubeQuotaUser(userId));

  const channelsResp = await chargedFetch(channelsUrl, 1, {
    jobId: job.id,
    channelId,
    origin: "cron",
    logTag: "channel-context-backfill: channels.list",
  });
  if (!channelsResp.ok) return; // dead-code defense вЂ” chargedFetch throws on non-2xx.
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

  // 2a. Append the resolved-from URL to handle_aliases. Fixes the
  //     handle-URL cache miss: ingest's cache lookup widens with
  //     `OR $key = ANY(handle_aliases)`, so any future paste of the same
  //     handle URL hits the row directly вЂ” no enqueue, no quota.
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

  // 3. playlistItems.list вЂ” paginated walk of the uploads playlist, filtered
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
  // Captured at the hard-cap exit so the post-loop state writes can
  // persist the resume cursor for the next walk. NULL on every
  // non-hard_cap exit.
  let hardCapResumeToken: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const playlistUrl = new URL(`${env.YOUTUBE_API_BASE_URL}/playlistItems`);
    playlistUrl.searchParams.set("playlistId", uploadsPlaylistId);
    playlistUrl.searchParams.set("part", "snippet");
    playlistUrl.searchParams.set("maxResults", String(PAGE_SIZE));
    playlistUrl.searchParams.set("quotaUser", youtubeQuotaUser(userId));
    if (pageToken) playlistUrl.searchParams.set("pageToken", pageToken);

    const playlistResp = await chargedFetch(playlistUrl, 1, {
      jobId: job.id,
      channelId,
      page,
      origin: "cron",
      logTag: "channel-context-backfill: playlistItems.list",
    });
    if (!playlistResp.ok) break; // dead-code defense вЂ” chargedFetch throws on non-2xx.
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
      // Preserve the cursor at MAX_PAGES so the next refresh-content
      // click resumes from page 21 instead of restarting the walk.
      hardCapResumeToken = playlistJson.nextPageToken ?? null;
      break;
    }
    pageToken = playlistJson.nextPageToken;
  }

  if (collected.length === 0) {
    // Do NOT early-return here. An earlier version returned and skipped
    // the terminal state writes at the bottom of the function, so a
    // brand-new or naturally-empty channel (no_more_pages on page 0 with
    // zero items) stayed backfill_complete=false forever and cron re-
    // walked it every day. The empty-aware guards below let the function
    // fall through to markChannelBackfillComplete + audit row with
    // events_inserted=0.
    logger.info(
      { jobId: job.id, channelId, window, stopReason },
      "channel-context-backfill: no videos in window",
    );
  }

  const videoIds = collected.map((c) => c.videoId);

  // 4. videos.list вЂ” batched in chunks of 50 (one quota unit per chunk).
  //    Sequential to keep quota accounting simple and pg-boss singleton-key
  //    contention bounded.
  const allItems: z.infer<typeof VIDEOS_LIST_RESPONSE>["items"] = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    const videosUrl = new URL(`${env.YOUTUBE_API_BASE_URL}/videos`);
    videosUrl.searchParams.set("id", chunk.join(","));
    videosUrl.searchParams.set("part", "snippet,statistics");
    videosUrl.searchParams.set("quotaUser", youtubeQuotaUser(userId));

    const videosResp = await chargedFetch(videosUrl, 1, {
      jobId: job.id,
      channelId,
      batch: i / 50,
      origin: "cron",
      logTag: "channel-context-backfill: videos.list",
    });
    if (!videosResp.ok) continue; // dead-code defense вЂ” chargedFetch throws on non-2xx.
    const videosJson = VIDEOS_LIST_RESPONSE.parse(await videosResp.json());
    allItems.push(...videosJson.items);
  }

  // 5a. UPSERT youtube_videos. One row per video, no time-series вЂ”
  //     title / description / channel only. The snippet half of
  //     videos.list lands here so the /events/new "Get from YouTube"
  //     button can read it for free on a re-paste of the same video.
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
  //     UNIQUE вЂ” re-run within the same minute is a no-op at row level.
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
  //    the parent data_source вЂ” its is_owned_by_me flag determines whether
  //    these events count as the user's own posts (Mine) or as tracked
  //    coverage (Tracking). For the ingest paste path (sourceId NOT provided)
  //    the event is already created by the ingest service, so we skip this
  //    block and only step 7 below refreshes its lastPolledAt timestamp.
  //
  // `collected.length > 0` guard: the pre-insert SELECT below uses
  // `${events.externalId} IN (...)` with `collected.map(c => sql`${c.videoId}`)`;
  // if collected is empty, Drizzle emits `IN ()`, which is a Postgres
  // syntax error.
  if (sourceId && collected.length > 0) {
    // Tenant-scoped lookup. The job payload pairs sourceId with userId;
    // even though pg-boss won't deliver a malformed job, the eq(userId)
    // filter is the load-bearing guarantee that we never read another
    // tenant's source row.
    const sourceRow = await db
      .select({ isOwnedByMe: dataSources.isOwnedByMe })
      .from(dataSources)
      .where(and(eq(dataSources.id, sourceId), eq(dataSources.userId, userId)))
      .limit(1);
    const authorIsMe = sourceRow[0]?.isOwnedByMe ?? false;

    // Auto-import idempotency: pre-insert SELECT scoped by `sourceId`.
    //
    // An earlier version of the SELECT skipped any user/external_id
    // match regardless of sourceId, which silently dropped backfill
    // writes when:
    //   - the user previously manually pasted the same video (sourceId=NULL
    //     вЂ” backfill saw it and skipped, source page showed "0 imported"),
    //   - a different source already auto-imported the same video (rare,
    //     requires two sources pointing at the same upstream channel).
    //
    // Schema unique `events_user_kind_source_ext_unq` already permits
    // multiple rows for the same external_id when sourceId differs вЂ” it
    // ONLY blocks duplicate inserts within a single source. Scoping the
    // pre-insert SELECT to match makes backfill honest:
    //   - A re-run of THIS source's backfill is idempotent (sourceId-scoped
    //     SELECT finds existing в†’ skip).
    //   - Cross-source double-import is preserved (different sourceId в†’
    //     SELECT misses в†’ INSERT proceeds в†’ schema unique permits).
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
    // same video.
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
      // onConflictDoNothing вЂ” race-safe against parallel
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

  // 7. Polling state lives on youtube_videos, not on events. The
  //    youtube_videos UPSERT in step
  //    5a already wrote {title, description, channel_*, published_at,
  //    fetched_at} for every collected video. We extend it here by stamping
  //    last_polled_at + last_poll_status='ok' on those rows so the tier
  //    resolver classifies them as Active/Cold/Frozen (not 'pending') as
  //    soon as the backfill completes. PUBLIC-DATA TABLE вЂ” no userId filter.
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

  // Backfill state machine + audit metadata for cap counter. State updates
  // only happen when sourceId is present (createSource flow, not generic
  // ingest path). Audit row written in both cases вЂ” ingest flow (no
  // sourceId) gets minimal metadata (no source_id field).
  if (sourceId && channelId !== null) {
    // Terminal channel-state writes per stopReason. An earlier version
    // set frontier + last_polled_at but left backfill_complete=false even
    // for channels that finished naturally (`no_more_pages`), causing the
    // cron auto-backfill picker to re-walk them at 3am Pacific the next
    // day вЂ” the typical onboarding double-walk.
    //
    // | stopReason       | complete | frontier            | token              |
    // |------------------|----------|---------------------|--------------------|
    // | no_more_pages    | true     | MIN(oldest seen)    | null               |
    // | hard_cap         | false    | oldest seen         | nextPageToken      |
    // | cutoff_crossed   | false    | cutoff              | null               |
    await markChannelLastPolledAt("youtube_channel", channelId);

    // Frontier write вЂ” depends on stopReason. `cutoff_crossed` uses the
    // window boundary directly because the frontier represents how far
    // back we walked, which IS the cutoff when we stopped because we
    // crossed it; oldest-seen would lie about the boundary.
    //
    // The cutoff_crossed frontier write is gated on
    // `videoIds.length > 0`. Empty-window onboarding
    // (channel exists but has no uploads in the requested window) used
    // to record backfill_oldest_at = cutoff with an empty youtube_videos
    // cache. The next refresh-content click then routed to
    // branch="incremental" (target >= deepestWalked) and the
    // overlap-mode walker, having no cache rows to compare against,
    // never triggered the overlap-stop threshold вЂ” it walked to
    // MAX_PAGES (20 quota units) and fan-out dropped every event for
    // being before the user's target. Skipping the frontier write
    // when nothing landed in cache means the next click routes to
    // branch="deep" (walkStop="depth") and terminates on the first
    // page past the cutoff вЂ” 1 quota unit instead of 20.
    if (stopReason === "cutoff_crossed" && cutoff !== null && videoIds.length > 0) {
      await markChannelBackfillFrontier("youtube_channel", channelId, cutoff);
    } else if (videoIds.length > 0) {
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

    // Complete + token writes вЂ” depends on stopReason.
    if (stopReason === "no_more_pages") {
      await markChannelBackfillComplete("youtube_channel", channelId);
      await setChannelBackfillPageToken("youtube_channel", channelId, null);
    } else if (stopReason === "hard_cap") {
      // Complete stays false; preserve resume cursor for next walk.
      await setChannelBackfillPageToken("youtube_channel", channelId, hardCapResumeToken);
    } else {
      // cutoff_crossed вЂ” complete stays false (more history is available
      // past the cutoff if the user later widens backfillTargetSince);
      // clear token because we did NOT exhaust pagination, we just
      // stopped at the window boundary.
      await setChannelBackfillPageToken("youtube_channel", channelId, null);
    }
  }

  // Audit row вЂ” counted ONLY when sourceId is present (per-source cap accounting).
  // Ingest-paste channel-context (no sourceId) is operator-side cache hydration,
  // not user-initiated quota burn вЂ” we skip the audit row to avoid polluting cap
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
        // `platform` for cap-query consistency. 'initial' flow excluded
        // from cap by design (onboarding UX), but we set platform anyway
        // so audit aggregation stays uniform across all refresh-related
        // verbs.
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
