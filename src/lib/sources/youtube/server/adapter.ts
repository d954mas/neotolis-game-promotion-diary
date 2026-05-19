// youtube_channel adapter.
//
// Local YouTube Data API v3 client helpers:
//
//   - playlistItems.list?playlistId=<uploadsPlaylistId>&part=snippet
//     &maxResults=50  (1 quota unit per call) - used by pollContent for
//     backfill + auto-import. Filters response items to publishedAt > since.
//
//   - videos.list?id=<<=50 comma-joined ids>&part=snippet,statistics,
//     contentDetails  (1 quota unit per call regardless of batch size;
//     8 calls = 8 units) - used by pollStats for per-event metrics +
//     Shorts detection.
//
// HTTP discipline:
//   - Native fetch (the `googleapis` npm package is heavy for two-endpoint
//     use).
//   - AbortController.timeout(30_000) on every call (never hold a DB tx
//     across HTTP).
//   - quotaUser=youtubeQuotaUser(userId) parameter on every call (Google's
//     per-end-user fairness gate splits the operator's quota evenly across
//     tenants instead of letting one whale starve the others).
//   - All HTTP routed through env.YOUTUBE_API_BASE_URL (smoke override,
//     production default = https://www.googleapis.com/youtube/v3).
//
// Statelessness: the adapter NEVER caches user secrets and never holds
// plaintext keys across jobs. Keys are selected by the quota reservation
// layer or explicitly passed in as a quota permit for batched calls.
//
// Error mapping (status codes):
//   - 200 + item present in response.items     -> status:'ok' + metrics + metadata
//   - 200 + item missing from response.items   -> status:'not_found' (private/deleted/embedded-disabled)
//   - 403 with errors[].reason='quotaExceeded' -> status:'rate_limited' (worker defers; scheduler pauses)
//   - 403 any other reason                     -> status:'auth_error' (event tier flips to Unavailable)
//   - 404                                      -> status:'not_found'
//   - other 4xx/5xx                            -> status:'auth_error' (placeholder; caller logs + retries)

import { hasYoutubeApiKeys, youtubeQuotaUser } from "./quota.js";
import { chargedFetch, fetchWithTimeout } from "./http.js";
import { youtubeEnrichFeedDtos } from "./feed-enrichment.js";
import { youtubeChannels, youtubeVideos as youtubeVideosTable } from "./schema/index.js";
import { db as serverDb } from "$lib/server/db/client.js";
import { eq as serverEq, inArray as serverInArray } from "drizzle-orm";
import { youtubeObservability } from "./observability.js";
import { youtubeParseUrl } from "./url.js";
import { z } from "zod";
import { env } from "$lib/server/config/env.js";
import { logger } from "$lib/server/logger.js";
import type {
  AdapterObservability,
  ParsedUrl,
  PickedKey,
  PollableEvent,
  PollableSource,
  RawEvent,
  SnapshotStatus,
  StatsSnapshot,
} from "$lib/sources/adapter.js";
import type { EventDto } from "$lib/server/dto.js";

/**
 * Google's videos.list cap - max 50 IDs per call. pollStatsByVideoId chunks
 * input to this size. Each chunk = 1 quota unit. Handlers use this constant
 * to align persistent quota charges with chunk boundaries (charge on first
 * video of every chunk-of-50, not just the very first video of the run).
 */
export const YOUTUBE_VIDEOS_BATCH_SIZE = 50;

/**
 * youtubeChannelAdapterCore - the YouTube adapter's *core* surface:
 * methods that are pure polling / URL-parsing / observability - everything
 * that's safe for any caller (handlers, tests, scheduler dispatch hint)
 * to use directly.
 *
 * Infrastructure-touching methods (registerQueues / scheduleCronTicks /
 * backfillSource) and cross-source create-time hooks (canonicalizeOnCreate /
 * onSourceCreated / fetchEventPreviewMetadata / validateEventInput /
 * fetchPollStateMap / registerRoutes / observability.quotaCounters) are
 * COMPOSED in `./index.ts` to produce the full `youtubeAdapter`. Cross-source
 * code always imports `youtubeAdapter` from the barrel - never this Core
 * directly.
 *
 * The Core's TypeScript shape is local to this module. Cross-source adapter
 * capabilities are composed in index.ts; future adapters don't inherit these
 * YouTube-specific polling methods from SourceAdapter.
 */
interface YoutubeChannelAdapterCore {
  readonly kind: "youtube_channel";
  pollContent(
    source: PollableSource,
    since: Date,
    ctx?: { origin?: "cron" | "user"; walkStop?: "depth" | "overlap" },
  ): Promise<{
    events: RawEvent[];
    unitsUsed: number;
    nextPageToken?: string;
    endOfPlaylist?: boolean;
  }>;
  pollStats(
    events: PollableEvent[],
    source: { id: string; userId: string } | null,
    picked: PickedKey,
  ): Promise<StatsSnapshot[]>;
  pollStatsByVideoId(
    videoIds: string[],
    quotaUser: string,
    picked: PickedKey,
  ): Promise<StatsSnapshot[]>;
  parseUrl(url: string): ParsedUrl | null;
  readonly observability: AdapterObservability;
  enrichFeedDtos(userId: string, dtos: EventDto[]): Promise<void>;
}

// Key identity is owned by quota.ts. Adapter code should only use the
// permit/key object it receives from the queue worker or chargedFetch.

// ---- Zod schemas - defense against API drift ----

const VIDEOS_LIST_RESPONSE = z.object({
  kind: z.literal("youtube#videoListResponse"),
  items: z.array(
    z.object({
      id: z.string(),
      snippet: z
        .object({
          publishedAt: z.string(),
          title: z.string(),
          channelId: z.string(),
        })
        .optional(),
      statistics: z
        .object({
          viewCount: z.string().optional(),
          likeCount: z.string().optional(),
          commentCount: z.string().optional(),
        })
        .optional(),
      contentDetails: z
        .object({
          duration: z.string(), // ISO 8601 - "PT15S" / "PT4M13S" / "PT1H02M03S"
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
  nextPageToken: z.string().optional(),
});

const ERROR_RESPONSE = z
  .object({
    error: z
      .object({
        errors: z.array(z.object({ reason: z.string().optional() })).optional(),
      })
      .optional(),
  })
  .partial();

// ---- Helpers ----

/** Parse ISO 8601 duration "PT4M13S" / "PT15S" / "PT1H2M3S" -> seconds.
 *  Returns 0 on parse failure. */
function durationToSeconds(iso: string): number {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!match) return 0;
  const [, h, m, s] = match;
  return Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0);
}

// fetchWithTimeout + chargedFetch live in $lib/sources/youtube/server/http.ts.
// This adapter exposes TWO YouTube methods, each with a different accounting
// boundary:
//
//   pollStatsBatch is used by the refresh queue worker,
//     worker, which charges quota via writeSnapshot's
//     per-video `unitsUsed` accounting and emit throttle audits via
//     the SnapshotStatus="rate_limited" path. This method MUST use the
//     lower-level fetchWithTimeout - routing it through chargedFetch
//     would double-charge (adapter +1 then writeSnapshot +1).
//
//   pollContent - auto-import path. No writeSnapshot equivalent at the
//     caller side, so this method DOES use chargedFetch and accounts
//     at the fetch boundary. (When auto-import lands as a worker
//     handler, that handler trusts pollContent to charge.) The earlier
//     fetchWithTimeout-only pattern would have been a future trap  -
//     auto-import quota burn would not land in
//     youtube_service_quota_usage at all.
//
// classifyError stays as the SnapshotStatus mapper for pollStatsBatch's
// caller-side audit. pollContent has no SnapshotStatus contract; it
// just bails on non-2xx with an empty array.

/** Map a non-2xx response to a SnapshotStatus. The body is read once; we tolerate
 *  malformed JSON by falling through to 'auth_error' (placeholder for 4xx/5xx
 *  the caller can log + retry). */
async function classifyError(resp: Response): Promise<SnapshotStatus> {
  if (resp.status === 404) return "not_found";
  if (resp.status === 403) {
    try {
      const parsed = ERROR_RESPONSE.safeParse(await resp.json());
      if (parsed.success) {
        const reason = parsed.data.error?.errors?.[0]?.reason;
        if (reason === "quotaExceeded") return "rate_limited";
      }
    } catch {
      // fall through to auth_error
    }
    return "auth_error";
  }
  return "auth_error";
}

/**
 * videos.list batched call. Up to 50 video ids per call (1 quota unit).
 *
 * `quotaUser` is the literal string sent on the URL. `picked` is the
 * pre-reserved key/permit from the caller. Threading it through keeps the
 * API key that hits Google aligned with the DB quota row that was reserved
 * before claim/dispatch.
 */
async function pollStatsBatch(
  videoIds: string[],
  quotaUser: string,
  picked: PickedKey,
): Promise<StatsSnapshot[]> {
  if (videoIds.length === 0) return [];
  if (videoIds.length > 50) throw new Error("videos.list batch limit is 50");

  const now = new Date();
  const url = new URL(`${env.YOUTUBE_API_BASE_URL}/videos`);
  url.searchParams.set("id", videoIds.join(","));
  url.searchParams.set("part", "snippet,statistics,contentDetails");
  url.searchParams.set("key", picked.apiKey);
  url.searchParams.set("quotaUser", quotaUser);

  const resp = await fetchWithTimeout(url);

  if (!resp.ok) {
    const status = await classifyError(resp);
    logger.warn(
      { status: resp.status, mappedStatus: status, batchSize: videoIds.length },
      "videos.list non-2xx",
    );
    return videoIds.map(() => ({ polledAt: now, status }));
  }

  const json = VIDEOS_LIST_RESPONSE.parse(await resp.json());
  return videoIds.map((videoId) => {
    const item = json.items.find((i) => i.id === videoId);
    if (!item) {
      // Not in response - private, deleted, embedded-disabled, or never existed.
      return { polledAt: now, status: "not_found" as const };
    }
    const dur = item.contentDetails?.duration
      ? durationToSeconds(item.contentDetails.duration)
      : undefined;
    const snapshot: StatsSnapshot = {
      polledAt: now,
      status: "ok",
      metrics: {
        view_count: Number(item.statistics?.viewCount ?? 0),
        like_count: Number(item.statistics?.likeCount ?? 0),
        comment_count: Number(item.statistics?.commentCount ?? 0),
      },
    };
    if (dur !== undefined) {
      snapshot.metadata = { duration_seconds: dur, is_short: dur <= 60 };
    }
    return snapshot;
  });
}

export const youtubeChannelAdapterCore: YoutubeChannelAdapterCore = {
  kind: "youtube_channel" as const,

  /** Backfill + auto-import - playlistItems.list against uploads playlist.
   *  1 quota unit per call. Filters to publishedAt > since. */
  async pollContent(
    source: PollableSource,
    since: Date,
    ctx?: { origin?: "cron" | "user"; walkStop?: "depth" | "overlap" },
  ): Promise<{
    events: RawEvent[];
    unitsUsed: number;
    nextPageToken?: string;
    endOfPlaylist?: boolean;
  }> {
    // uploadsPlaylistId lives in youtube_channels cache (PK = channelId),
    // NOT in data_sources.metadata. channel-context-backfill writes the
    // cache table, not source metadata. Reading only
    // source.metadata.uploadsPlaylistId would always come back empty and
    // the worker would mark backfill_complete=true immediately after
    // onboarding without ever making an HTTP call.
    //
    // Lookup chain: prefer explicit metadata.uploadsPlaylistId (existing
    // unit tests + any future direct caller), fall back to youtube_channels
    // cache via metadata.channelId (the production path; worker injects
    // source.channelId into metadata before calling).
    let uploadsPlaylistId: string | null =
      (source.metadata as { uploadsPlaylistId?: string })?.uploadsPlaylistId ?? null;
    if (!uploadsPlaylistId) {
      const sourceChannelId = (source.metadata as { channelId?: string })?.channelId;
      if (sourceChannelId) {
        const [cached] = await serverDb
          .select({ uploadsPlaylistId: youtubeChannels.uploadsPlaylistId })
          .from(youtubeChannels)
          .where(serverEq(youtubeChannels.channelId, sourceChannelId))
          .limit(1);
        uploadsPlaylistId = cached?.uploadsPlaylistId ?? null;
      }
    }
    if (!uploadsPlaylistId) {
      logger.warn(
        { sourceId: source.id, userId: source.userId },
        "pollContent: uploadsPlaylistId not resolvable - channel-context backfill required",
      );
      return { events: [], unitsUsed: 0 };
    }
    if (!hasYoutubeApiKeys()) return { events: [], unitsUsed: 0 };

    // Paginate playlistItems.list using nextPageToken until either:
    //   - no more pages (json.nextPageToken absent - end of playlist)
    //   - oldest item on page is at-or-before `since` (we walked past target)
    //   - hard cap MAX_PAGES (prevents runaway quota burn on /sources with
    //     pathological histories - 20 pages x 50 items = 1000 events
    //     per single refresh click)
    //
    // unitsUsed = pages fetched (1 quota unit per playlistItems.list call).
    // Origin from ctx - user-initiated clicks consume user pool, cron-driven
    // jobs consume cron pool.
    //
    // Persistent pagination cursor for "all history" backfill of channels
    // with >MAX_PAGESx50 (1000) videos. Without it, every refresh-content
    // click would start from page 1 - for a 5000-video channel the worker
    // would re-fetch the same 1000 newest items every click, idempotency
    // UNIQUE would skip them all, frontier would never advance past page 20.
    //
    // Resume protocol:
    //   - Worker passes source.metadata.lastBackfillPageToken into
    //     pollContent's source.metadata.
    //   - Adapter uses it as starting page if present, else page 1.
    //   - Adapter returns nextPageToken in result. Worker writes it
    //     back to source.metadata.lastBackfillPageToken (or clears on
    //     end-of-playlist).
    //   - Next click resumes from saved cursor.
    //
    // Edge case: items between "since" cutoff and current cursor get
    // skipped on subsequent calls. Acceptable for "all history" pull
    // (we walk linearly back); for narrower windows the original
    // pagination still terminates quickly enough that resume isn't
    // needed.
    const MAX_PAGES = 20;
    const sinceMs = since.getTime();
    const collected: RawEvent[] = [];
    const initialPageToken = (source.metadata as { lastBackfillPageToken?: string })
      ?.lastBackfillPageToken;
    let pageToken: string | undefined = initialPageToken;
    let unitsUsed = 0;
    let walkedPastSince = false;
    let endOfPlaylist = false;
    let nextPageToken: string | undefined;

    // Backdated-upload safety. The legacy "depth" walk drops every item
    // with publishedAt <= since unconditionally; that silently loses
    // videos whose publishedAt is older than newestKnown (e.g. uploaded
    // today but with a custom publishedAt months back - unlisted-then-
    // public, podcast schedule, channel takeover migration).
    //
    // The "overlap" mode does a per-page cache lookup against
    // youtube_videos. An item is treated as a stop signal only when it is
    // BOTH already in the cache (we've seen it before) AND publishedAt is
    // past since (we'd previously have dropped it). After OVERLAP_THRESHOLD
    // consecutive such items the walker stops. Backdated cache-miss items
    // continue to be collected. Single-item gaps (one re-uploaded video
    // in the middle of unknown territory) do NOT terminate the walk
    // because the counter resets on every unknown item.
    //
    // Mode is chosen by the orchestrator (backfill-channel.ts) per branch:
    //   - branch="deep"        -> walkStop="depth"   (since = historical floor)
    //   - branch="exhausted"   -> walkStop="overlap" (since = newestKnown)
    //   - branch="incremental" -> walkStop="overlap" (since = max(newestKnown, target))
    // Cron paths default to "depth" - they pass since=epoch and rely on
    // endOfPlaylist / MAX_PAGES as their natural floors; overlap would
    // be no-op for cron's epoch-since anyway.
    const walkStop = ctx?.walkStop ?? "depth";
    const OVERLAP_THRESHOLD = 3;
    let consecutiveKnownPastSince = 0;

    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(`${env.YOUTUBE_API_BASE_URL}/playlistItems`);
      url.searchParams.set("playlistId", uploadsPlaylistId);
      url.searchParams.set("part", "snippet");
      url.searchParams.set("maxResults", "50");
      url.searchParams.set("quotaUser", youtubeQuotaUser(source.userId));
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const resp = await chargedFetch(url, 1, {
        sourceId: source.id,
        origin: ctx?.origin ?? "cron",
        logTag: "youtube-adapter: playlistItems.list",
        page,
      });
      unitsUsed += 1;
      if (!resp.ok) break;
      const json = PLAYLIST_ITEMS_LIST_RESPONSE.parse(await resp.json());

      // Overlap-mode: one indexed SELECT per page against the public-data
      // youtube_videos cache (no userId scope - every tenant shares the
      // row). Empty page short-circuits the query to avoid Postgres `IN ()`.
      let knownByPage: Set<string> = new Set<string>();
      if (walkStop === "overlap" && json.items.length > 0) {
        const pageExternalIds = json.items.map((it) => it.snippet.resourceId.videoId);
        const rows = await serverDb
          .select({ videoId: youtubeVideosTable.videoId })
          .from(youtubeVideosTable)
          .where(serverInArray(youtubeVideosTable.videoId, pageExternalIds));
        knownByPage = new Set(rows.map((r) => r.videoId));
      }

      for (const item of json.items) {
        const externalId = item.snippet.resourceId.videoId;
        const occurredAt = new Date(item.snippet.publishedAt);
        const pastSince = occurredAt.getTime() <= sinceMs;

        if (walkStop === "depth") {
          if (pastSince) {
            walkedPastSince = true;
            continue;
          }
        } else {
          // walkStop === "overlap"
          const isKnown = knownByPage.has(externalId);
          if (isKnown && pastSince) {
            consecutiveKnownPastSince += 1;
            if (consecutiveKnownPastSince >= OVERLAP_THRESHOLD) {
              walkedPastSince = true;
              break;
            }
            continue;
          }
          // Unknown-OR-fresh item resets the counter. Known-and-fresh
          // (a video the cache already saw but published AFTER since)
          // is rare - we still skip it (dedup) without breaking. Backdated
          // cache-miss lands here and IS collected.
          consecutiveKnownPastSince = 0;
          if (isKnown) {
            // Defensive skip to avoid double-fan-out on re-upload edge case;
            // the events INSERT-ON-CONFLICT downstream is the load-bearing
            // dedup, but skipping here saves an idempotency-loss INSERT.
            continue;
          }
        }

        collected.push({
          externalId,
          title: item.snippet.title,
          occurredAt,
          url: `https://www.youtube.com/watch?v=${externalId}`,
          kind: "youtube_video",
          metadata: { channelId: item.snippet.channelId },
        });
      }

      nextPageToken = json.nextPageToken;
      if (!nextPageToken) {
        endOfPlaylist = true;
        break;
      }
      if (walkedPastSince) break;
      pageToken = nextPageToken;
    }

    return {
      events: collected,
      unitsUsed,
      // Resume marker for next call. Cleared (undefined) when we hit end-
      // of-playlist OR walked past the "since" cutoff (target reached).
      nextPageToken: endOfPlaylist || walkedPastSince ? undefined : nextPageToken,
      endOfPlaylist,
    };
  },

  /** Stats polling - user-driven path (Refresh now button -> refresh queue worker).
   *  Caller passes events of `kind=youtube_video`; source MAY be null (manual
   *  paste). Returns StatsSnapshot[] aligned to input order.
   *
   *  Per-user quotaUser fingerprint: the user initiated this action, so
   *  Google's burst-shaper should track it under that user's bucket. Distinct
   *  from pollStatsByVideoId service rows, which use the service_video
   *  quotaUser fingerprint.
   *
   *  Groups by userId in case a future caller batches across users; for the
   *  legacy single-event path the loop fired once. */
  async pollStats(
    eventsBatch: PollableEvent[],
    _source: { id: string; userId: string } | null,
    picked: PickedKey,
  ): Promise<StatsSnapshot[]> {
    if (eventsBatch.length === 0) return [];

    const byUser = new Map<string, PollableEvent[]>();
    for (const ev of eventsBatch) {
      const list = byUser.get(ev.userId) ?? [];
      list.push(ev);
      byUser.set(ev.userId, list);
    }

    const byEventId = new Map<string, StatsSnapshot>();
    for (const [userId, evs] of byUser) {
      // Chunk into 50-id batches.
      for (let i = 0; i < evs.length; i += 50) {
        const chunk = evs.slice(i, i + 50);
        const ids = chunk.map((e) => e.externalId);
        const snapshots = await pollStatsBatch(ids, youtubeQuotaUser(userId), picked);
        for (let j = 0; j < chunk.length; j++) {
          const ev = chunk[j]!;
          const snap = snapshots[j]!;
          byEventId.set(ev.id, { ...snap, eventId: ev.id });
        }
      }
    }

    // Re-align to original input order.
    return eventsBatch.map(
      (e) =>
        byEventId.get(e.id) ?? {
          polledAt: new Date(),
          status: "auth_error" as const,
        },
    );
  },

  /**
   * Stats polling - service-driven path (service_video queue worker).
   *
   * Per-video, not per-event. The scheduler hands a flat list of videoIds
   * (already deduplicated across tenants); the adapter chunks it into <=50
   * batches and issues one HTTP per batch with the caller-supplied
   * quotaUser fingerprint. For service_video this is the service queue
   * constant, distinct from user-driven Refresh now work.
   *
   * Returns StatsSnapshot[] aligned to input order.
   */
  async pollStatsByVideoId(
    videoIds: string[],
    quotaUser: string,
    picked: PickedKey,
  ): Promise<StatsSnapshot[]> {
    if (videoIds.length === 0) return [];
    const result: StatsSnapshot[] = [];
    for (let i = 0; i < videoIds.length; i += YOUTUBE_VIDEOS_BATCH_SIZE) {
      const chunk = videoIds.slice(i, i + YOUTUBE_VIDEOS_BATCH_SIZE);
      const snapshots = await pollStatsBatch(chunk, quotaUser, picked);
      for (const snap of snapshots) result.push(snap);
    }
    return result;
  },

  /** parseUrl - first-match-wins URL detection. Delegates to ./url.ts
   *  youtubeParseUrl which is also used by the registry's parseAnyUrl
   *  iterator. */
  parseUrl(url: string): ParsedUrl | null {
    return youtubeParseUrl(url);
  },
  /** Core observability without per-adapter quotaCounters. The barrel adds
   *  quotaCounters via spread+override so cross-source services/quota.ts
   *  can iterate them without knowing about youtube_metadata_fetch_log. */
  observability: youtubeObservability,
  /** enrichFeedDtos - internal filter to kind=youtube_video; mutates stats +
   *  channelTitle in place. The barrel spreads this into the exported
   *  youtubeAdapter alongside the rest of the Core surface. */
  enrichFeedDtos: youtubeEnrichFeedDtos,
};
