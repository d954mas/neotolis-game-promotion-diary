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
//   - quotaUser=hashApiKeyId(userId) parameter on every call (Google's
//     per-end-user fairness gate — RESEARCH.md OQ#5 / Pattern 4 — splits
//     the operator's quota evenly across tenants instead of letting one
//     whale starve the others).
//   - All HTTP routed through env.YOUTUBE_API_BASE_URL (smoke override,
//     production default = https://www.googleapis.com/youtube/v3).
//
// Statelessness (AGENTS.md AP-3): the adapter NEVER caches user secrets and
// never holds plaintext keys across calls. The operator's plaintext key is
// read from env at call time via `pickKeyForJob`. Plan 03.0-03 will provide
// the canonical `pickKeyForJob` + `hashApiKeyId` from
// `services/youtube-quota-tracker.ts`; this file inlines minimal-contract
// equivalents until the parallel sibling plan lands. The two helpers are
// imported via dynamic import in a try/catch so the swap is a one-line
// follow-up commit (Rule 3 deviation — blocking issue resolved by inlining
// a minimal contract until the parallel plan lands).
//
// Error mapping (Phase 3.0 D-12 status codes):
//   - 200 + item present in response.items     → status:'ok' + metrics + metadata
//   - 200 + item missing from response.items   → status:'not_found' (private/deleted/embedded-disabled)
//   - 403 with errors[].reason='quotaExceeded' → status:'rate_limited' (worker defers; scheduler pauses)
//   - 403 any other reason                     → status:'auth_error' (event tier flips to Unavailable)
//   - 404                                      → status:'not_found'
//   - other 4xx/5xx                            → status:'auth_error' (placeholder; caller logs + retries)

import { createHash } from "node:crypto";
import { z } from "zod";
import { env } from "../config/env.js";
import { logger } from "../logger.js";
import type {
  DataSourceAdapter,
  PollableEvent,
  PollableSource,
  RawEvent,
  SnapshotStatus,
  StatsSnapshot,
} from "./data-source-adapter.js";

// ---- Inlined minimal pickKeyForJob + hashApiKeyId (cross-plan transition) ----
//
// Plan 03.0-03 (running in parallel with this plan in Wave 1) will provide
// canonical implementations in `services/youtube-quota-tracker.ts` that add
// per-key 80%/95% throttle gates + round-robin rotation + UPSERT counter
// against `youtube_service_quota_usage`. Until that plan lands and is merged,
// this file ships a minimal contract: round-robin across the env-configured
// keys (no quota gating), and SHA-256-based 16-hex-char hashing for the
// `quotaUser` parameter. When 03.0-03 ships, this block is replaced with
// `import { pickKeyForJob, hashApiKeyId } from "../services/youtube-quota-tracker.js"`.

interface PickedKey {
  apiKey: string;
  apiKeyId: string;
}

let roundRobinCursor = 0;

function pickKeyForJob(): PickedKey | null {
  const keys = env.SERVICE_YOUTUBE_API_KEYS;
  if (keys.length === 0) return null;
  const idx = roundRobinCursor++ % keys.length;
  const apiKey = keys[idx]!;
  // apiKeyId is the first 16 hex chars of SHA-256(apiKey) — stable across
  // restarts, never logs the plaintext, and matches the (planned) Plan 03.0-03
  // identifier shape for `youtube_service_quota_usage.api_key_id`.
  const apiKeyId = createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
  return { apiKey, apiKeyId };
}

/** Per-tenant quotaUser hash. 16 hex chars from SHA-256(userId). */
function hashApiKeyId(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 16);
}

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

async function fetchWithTimeout(url: URL, timeoutMs = 30_000): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

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

/** videos.list batched call. Up to 50 video ids per call (1 quota unit). */
async function pollStatsBatch(videoIds: string[], userId: string): Promise<StatsSnapshot[]> {
  if (videoIds.length === 0) return [];
  if (videoIds.length > 50) throw new Error("videos.list batch limit is 50");

  const picked = pickKeyForJob();
  const now = new Date();
  if (!picked) {
    // env.SERVICE_YOUTUBE_API_KEYS empty — degrade to auth_error so the caller
    // persists last_poll_status='auth_error' and the user sees the Unavailable
    // badge until the operator adds a key. This preserves self-host parity:
    // a self-hoster who never sets the env var gets a graceful no-op rather
    // than a thrown exception in the worker handler.
    return videoIds.map(() => ({ polledAt: now, status: "auth_error" as const }));
  }

  const url = new URL(`${env.YOUTUBE_API_BASE_URL}/videos`);
  url.searchParams.set("id", videoIds.join(","));
  url.searchParams.set("part", "snippet,statistics,contentDetails");
  url.searchParams.set("key", picked.apiKey);
  url.searchParams.set("quotaUser", hashApiKeyId(userId));

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

export const youtubeChannelAdapter: DataSourceAdapter = {
  kind: "youtube_channel" as const,

  /** Backfill + auto-import — playlistItems.list against uploads playlist.
   *  1 quota unit per call. Filters to publishedAt > since. */
  async pollContent(source: PollableSource, since: Date): Promise<RawEvent[]> {
    const uploadsPlaylistId = (source.metadata as { uploadsPlaylistId?: string })
      ?.uploadsPlaylistId;
    if (!uploadsPlaylistId) {
      // Plan 03.0-10 ingest-channel-context-trigger backfills this metadata
      // on first paste; if the user pasted before that plan shipped (or the
      // backfill failed), the source has no uploadsPlaylistId yet. Return
      // empty rather than throwing — the worker logs + skips and the next
      // backfill tick will resolve it.
      logger.warn(
        { sourceId: source.id, userId: source.userId },
        "pollContent: missing uploadsPlaylistId in source.metadata; channel-context backfill required first",
      );
      return [];
    }
    const picked = pickKeyForJob();
    if (!picked) return [];

    const url = new URL(`${env.YOUTUBE_API_BASE_URL}/playlistItems`);
    url.searchParams.set("playlistId", uploadsPlaylistId);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("maxResults", "50");
    url.searchParams.set("key", picked.apiKey);
    url.searchParams.set("quotaUser", hashApiKeyId(source.userId));

    const resp = await fetchWithTimeout(url);
    if (!resp.ok) {
      logger.warn({ status: resp.status, sourceId: source.id }, "playlistItems.list non-2xx");
      return [];
    }
    const json = PLAYLIST_ITEMS_LIST_RESPONSE.parse(await resp.json());
    const sinceMs = since.getTime();
    return json.items
      .map<RawEvent>((item) => ({
        externalId: item.snippet.resourceId.videoId,
        title: item.snippet.title,
        occurredAt: new Date(item.snippet.publishedAt),
        url: `https://www.youtube.com/watch?v=${item.snippet.resourceId.videoId}`,
        kind: "youtube_video",
        metadata: { channelId: item.snippet.channelId },
      }))
      .filter((e) => e.occurredAt.getTime() > sinceMs);
  },

  /** Stats polling — batched up to 50 ids per videos.list call (1 unit each).
   *  Caller passes events of `kind=youtube_video`; source MAY be null (manual
   *  paste D-11). Returns StatsSnapshot[] aligned to input order.
   *
   *  Conservative batching: groups by userId so quotaUser is correct per call.
   *  In service-level Phase 3.0, events from different users may share a
   *  single batch only if they happen to arrive in the same enqueue tick;
   *  typically a worker call is single-user. */
  async pollStats(
    eventsBatch: PollableEvent[],
    _source: { id: string; userId: string } | null,
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
        const snapshots = await pollStatsBatch(ids, userId);
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
};
