// youtube_channel adapter — Phase 3.0 Plan 06 LIVE impl.
//
// Replaces the Phase 2.1 STUB. Implements DataSourceAdapter via two YouTube
// Data API v3 endpoints:
//
//   - playlistItems.list?playlistId=<uploadsPlaylistId>&part=snippet
//     &maxResults=50  (1 quota unit per call) — used by pollContent for
//     backfill + auto-import. Filters response items to publishedAt > since.
//
//   - videos.list?id=<≤50 comma-joined ids>&part=snippet,statistics,
//     contentDetails  (1 quota unit per call regardless of batch size —
//     VERIFIED by the Plan 03.0-01 spike on 2026-05-06; 8 calls = 8 units)
//     — used by pollStats for per-event metrics + Shorts detection.
//
// HTTP discipline (per RESEARCH.md + AGENTS.md):
//   - Native fetch (RESEARCH.md notes the `googleapis` npm package is heavy
//     for two-endpoint use).
//   - AbortController.timeout(30_000) on every call (Pitfall 5 — never hold
//     a DB tx across HTTP).
//   - quotaUser=youtubeQuotaUser(userId) parameter on every call (Google's
//     per-end-user fairness gate — RESEARCH.md OQ#5 / Pattern 4 — splits
//     the operator's quota evenly across tenants instead of letting one
//     whale starve the others).
//   - All HTTP routed through env.YOUTUBE_API_BASE_URL (smoke override,
//     production default = https://www.googleapis.com/youtube/v3).
//
// Statelessness (AGENTS.md AP-3): the adapter NEVER caches user secrets and
// never holds plaintext keys across calls. The operator's plaintext key is
// read from env at call time via `pickKeyForJob`. The canonical
// `pickKeyForJob` + `hashApiKeyId` live in `./quota.js` (relocated from
// `services/youtube-quota-tracker.ts` in Phase 03.0.1 Plan 04 — pre-Plan 04
// path: `$lib/server/services/youtube-quota-tracker.js`).
//
// Error mapping (Phase 3.0 D-12 status codes):
//   - 200 + item present in response.items     → status:'ok' + metrics + metadata
//   - 200 + item missing from response.items   → status:'not_found' (private/deleted/embedded-disabled)
//   - 403 with errors[].reason='quotaExceeded' → status:'rate_limited' (worker defers; scheduler pauses)
//   - 403 any other reason                     → status:'auth_error' (event tier flips to Unavailable)
//   - 404                                      → status:'not_found'
//   - other 4xx/5xx                            → status:'auth_error' (placeholder; caller logs + retries)

import { pickKeyForJob, youtubeQuotaUser } from "./quota.js";
import { chargedFetch, fetchWithTimeout } from "./http.js";
import { youtubeObservability } from "./observability.js";
import { youtubeParseUrl } from "./url.js";
import { AdapterError } from "$lib/sources/errors.js";
import { z } from "zod";
import { env } from "$lib/server/config/env.js";
import { logger } from "$lib/server/logger.js";
import type {
  DataSourceAdapter,
  EventKind,
  ParsedUrl,
  PickedKey,
  PollableEvent,
  PollableSource,
  RawEvent,
  SnapshotStatus,
  StatsSnapshot,
} from "$lib/sources/adapter.js";

/**
 * youtubeChannelAdapterCore — Phase 03.0.1 architecture cleanup.
 *
 * Exports the YouTube adapter's *core* surface: methods that are pure
 * polling / URL-parsing / observability — everything that's safe for
 * any caller (handlers, tests, scheduler dispatch hint) to use directly.
 *
 * Infrastructure-touching methods (registerQueues / scheduleCronTicks /
 * backfillSource) and cross-source create-time hooks (canonicalizeOnCreate /
 * onSourceCreated / fetchEventPreviewMetadata / validateEventInput /
 * fetchPollStateMap / registerRoutes / observability.quotaCounters) are
 * COMPOSED in `./index.ts` to produce the full `youtubeAdapter`. Cross-source
 * code always imports `youtubeAdapter` from the barrel — never this Core
 * directly.
 *
 * The Core's TypeScript shape is `Pick<DataSourceAdapter, ...>` — TypeScript
 * red-flags any caller that tries to invoke a non-Core method (e.g.
 * `core.backfillSource()` — won't compile, used to throw at runtime).
 *
 * Why split: the previous shape exported a full `DataSourceAdapter` with
 * registerQueues / scheduleCronTicks / backfillSource as throwing stubs;
 * the barrel spread + override produced the live object. That made
 * `youtubeChannelAdapter` look complete to outsiders while half its surface
 * was a runtime trap. The split makes the Core honest at the type level
 * and forces composition to live where it always lived (the barrel).
 */
type YoutubeChannelAdapterCore = Pick<
  DataSourceAdapter,
  | "kind"
  | "pollContent"
  | "pollStats"
  | "pollStatsByVideoId"
  | "parseUrl"
  | "observability"
  | "canRefreshPoll"
>;

// Plan 03.0-03's canonical pickKeyForJob + hashApiKeyId are imported above
// (./quota.js — relocated in Phase 03.0.1 Plan 04 from
// services/youtube-quota-tracker.ts). The Wave-1-cross-plan inline copies
// were removed in the post-build review sweep — they had divergent state
// (separate roundRobinCursor module variable + different hash length) that
// caused the apiKeyId stored in youtube_service_quota_usage by the worker
// to NOT match the apiKeyId the adapter produced. With one key in the
// envelope this was masked; with two keys the counter rows would never
// settle on a stable pair.

// ---- Zod schemas — defense against API drift ----

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
          duration: z.string(), // ISO 8601 — "PT15S" / "PT4M13S" / "PT1H02M03S"
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

/** Parse ISO 8601 duration "PT4M13S" / "PT15S" / "PT1H2M3S" → seconds.
 *  Returns 0 on parse failure. */
function durationToSeconds(iso: string): number {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!match) return 0;
  const [, h, m, s] = match;
  return Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0);
}

// fetchWithTimeout + chargedFetch live in $lib/sources/youtube/server/http.ts
// (post-build review 2026-05-08). This adapter exposes TWO YouTube
// methods, each with a different accounting boundary:
//
//   pollStatsBatch — used by poll-active / poll-cold / poll-user /
//     rehab-unavailable, which charge quota via writeSnapshot's
//     per-video `unitsUsed` accounting and emit throttle audits via
//     the SnapshotStatus="rate_limited" path. This method MUST use the
//     lower-level fetchWithTimeout — routing it through chargedFetch
//     would double-charge (adapter +1 then writeSnapshot +1).
//
//   pollContent — auto-import path. No writeSnapshot equivalent at the
//     caller side, so this method DOES use chargedFetch and accounts
//     at the fetch boundary. (When auto-import lands as a worker
//     handler, that handler trusts pollContent to charge.) This was
//     surfaced by the fourth-pass review: pollContent's earlier
//     fetchWithTimeout-only pattern would have been a future trap —
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
 * `quotaUser` is the literal string sent on the URL — caller decides whether
 * it's a per-user fingerprint (poll-user — `youtubeQuotaUser(userId)`) or a
 * service-tier constant (poll-active / poll-cold — "neotolis-svc-active").
 * This module does not pick the policy; it just sends what it's given.
 *
 * `picked` is the pre-resolved key from the caller's `pickKeyForJob` — see
 * the PickedKey jsdoc on $lib/sources/adapter.ts. The adapter no longer
 * picks on its own (post-build review 2026-05-07): without threading,
 * the worker would advance roundRobinIdx once at handler start AND the
 * adapter would advance it again per chunk, leaving the
 * youtube_service_quota_usage row keyed under the worker's pick while
 * the actual HTTP burned the adapter's pick.
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
      // Not in response — private, deleted, embedded-disabled, or never existed.
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

  /** Backfill + auto-import — playlistItems.list against uploads playlist.
   *  1 quota unit per call. Filters to publishedAt > since. */
  async pollContent(
    source: PollableSource,
    since: Date,
  ): Promise<{ events: RawEvent[]; unitsUsed: number }> {
    const uploadsPlaylistId = (source.metadata as { uploadsPlaylistId?: string })
      ?.uploadsPlaylistId;
    if (!uploadsPlaylistId) {
      // Plan 03.0-10 ingest-channel-context-trigger backfills this metadata
      // on first paste; if the user pasted before that plan shipped (or the
      // backfill failed), the source has no uploadsPlaylistId yet. Return
      // empty rather than throwing — the worker logs + skips and the next
      // backfill tick will resolve it. unitsUsed=0: no HTTP made.
      logger.warn(
        { sourceId: source.id, userId: source.userId },
        "pollContent: missing uploadsPlaylistId in source.metadata; channel-context backfill required first",
      );
      return { events: [], unitsUsed: 0 };
    }
    const picked = pickKeyForJob();
    if (!picked) return { events: [], unitsUsed: 0 };

    const url = new URL(`${env.YOUTUBE_API_BASE_URL}/playlistItems`);
    url.searchParams.set("playlistId", uploadsPlaylistId);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("maxResults", "50");
    url.searchParams.set("key", picked.apiKey);
    url.searchParams.set("quotaUser", youtubeQuotaUser(source.userId));

    // Plan 08: chargedFetch throws AdapterError on non-2xx. pollContent
    // (auto-import path) does NOT have a SnapshotStatus contract — bail with
    // an empty array on any error category rather than ripple AdapterError
    // into auto-import's caller (which today doesn't exist; auto-import
    // lands as a future worker handler). Translate-and-bail keeps the
    // legacy pre-Plan-08 contract intact for whoever wires the auto-import
    // worker; that worker can revisit AdapterError-raise behavior when
    // ready. origin='cron' — pollContent is invoked by scheduler-driven
    // auto-import, never by user-driven Refresh-now.
    //
    // unitsUsed accounting: chargedFetch charges 1 unit on EVERY Response
    // (including non-2xx — Google's quota guide). The throw path means we
    // didn't reach a Response; chargedFetch's pre-fetch reservoir consume
    // also didn't actually charge the persistent counter (incrementUsage
    // runs AFTER fetch). So throw → unitsUsed=0 is honest.
    let resp: Response;
    let unitsUsed = 0;
    try {
      resp = await chargedFetch(url, picked, 1, {
        sourceId: source.id,
        origin: "cron",
        logTag: "youtube-adapter: playlistItems.list",
      });
      unitsUsed = 1;
    } catch (err) {
      if (err instanceof AdapterError) {
        logger.warn(
          { sourceId: source.id, userId: source.userId, category: err.category },
          "pollContent: AdapterError → empty result",
        );
        return { events: [], unitsUsed: 0 };
      }
      throw err;
    }
    if (!resp.ok) return { events: [], unitsUsed }; // dead-code defense — chargedFetch throws on non-2xx in Plan 08.
    const json = PLAYLIST_ITEMS_LIST_RESPONSE.parse(await resp.json());
    const sinceMs = since.getTime();
    const events = json.items
      .map<RawEvent>((item) => ({
        externalId: item.snippet.resourceId.videoId,
        title: item.snippet.title,
        occurredAt: new Date(item.snippet.publishedAt),
        url: `https://www.youtube.com/watch?v=${item.snippet.resourceId.videoId}`,
        kind: "youtube_video",
        metadata: { channelId: item.snippet.channelId },
      }))
      .filter((e) => e.occurredAt.getTime() > sinceMs);
    return { events, unitsUsed };
  },

  /** Stats polling — user-driven path (Refresh now button → poll-user worker).
   *  Caller passes events of `kind=youtube_video`; source MAY be null (manual
   *  paste D-11). Returns StatsSnapshot[] aligned to input order.
   *
   *  Per-user quotaUser fingerprint: the user initiated this action, so
   *  Google's burst-shaper should track it under that user's bucket. Distinct
   *  from pollStatsByVideoId which uses a service-tier constant fingerprint.
   *
   *  Groups by userId in case a future caller batches across users; for the
   *  current single-event poll-user path the loop fires once. */
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
   * Stats polling — service-driven path (poll-active / poll-cold workers).
   *
   * Per-video, not per-event. The scheduler hands a flat list of videoIds
   * (already deduplicated across tenants); the adapter chunks it into ≤50
   * batches and issues one HTTP per batch with the caller-supplied
   * quotaUser fingerprint. quotaUser here is the service-tier constant
   * ("neotolis-svc-active" or "neotolis-svc-cold") — Google's burst-shaper
   * tracks all service polls in one bucket per tier, distinct from
   * user-driven Refresh now polls (per-user fingerprint via pollStats).
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
    for (let i = 0; i < videoIds.length; i += 50) {
      const chunk = videoIds.slice(i, i + 50);
      const snapshots = await pollStatsBatch(chunk, quotaUser, picked);
      for (const snap of snapshots) result.push(snap);
    }
    return result;
  },

  /** parseUrl — D-15 first-match-wins URL detection. Delegates to
   *  ./url.ts youtubeParseUrl which is also used by the registry's
   *  parseAnyUrl iterator. */
  parseUrl(url: string): ParsedUrl | null {
    return youtubeParseUrl(url);
  },
  /** observability (Plan 08) — Core observability without per-adapter
   *  quotaCounters. The barrel adds quotaCounters via spread+override so
   *  cross-source services/quota.ts can iterate them without knowing
   *  about youtube_metadata_fetch_log. */
  observability: youtubeObservability,
  /** canRefreshPoll — cheap dispatch hint used by services/refresh-poll.ts
   *  (Plan 06). YouTube returns true for kind === "youtube_video"; Reddit
   *  (Phase 03.1) returns true for kind === "reddit_post". */
  canRefreshPoll: (eventKind: EventKind): boolean => eventKind === "youtube_video",
};
