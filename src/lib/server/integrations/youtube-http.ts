// Phase 3.0 post-build review (2026-05-08) — shared YouTube HTTP wrapper.
//
// Owns "how this app calls YouTube." Pre-extraction, three places had
// near-duplicate implementations of the same fetch + charge + throttle-
// audit pattern with subtle drift between them:
//
//   - youtube-channel-context-backfill.ts had a local `chargedFetch` with
//     proper 403-quotaExceeded handling.
//   - youtube-metadata.ts had inline incrementUsage on 2xx only and NO
//     throttle-audit emission on 403.
//   - youtube-channel-adapter.ts (pollStatsBatch / pollContent) used
//     fetchWithTimeout + classifyError but never emitted a throttle audit
//     either; the poll-active / poll-cold workers handled it after the
//     fact via writeSnapshot's status field, while pollContent (auto-
//     import path, currently unused) had no recovery.
//
// Two helpers, two accounting boundaries:
//
//   chargedFetch — the canonical wrapper. Charges quota + emits throttle
//     audit at the fetch site. Used by every YouTube API call EXCEPT
//     pollStatsBatch (the per-event stats poller). That single exception
//     exists because pollStatsBatch's callers (poll-active / poll-cold
//     / poll-user / rehab-unavailable) charge via writeSnapshot's
//     per-video `unitsUsed` accounting and emit throttle audits via the
//     SnapshotStatus="rate_limited" status path — routing pollStatsBatch
//     through chargedFetch would double-charge. The accounting boundary
//     for stats polling lives at the writeSnapshot tx; the accounting
//     boundary for everything else (backfill, metadata, auto-import via
//     pollContent) lives at the fetch site.
//
//   fetchWithTimeout — the lower-level primitive. Used by pollStatsBatch
//     (the writeSnapshot-accounted path above) and nothing else.
//
// chargedFetch contract:
//
//   1. Charges `units` against youtube_service_quota_usage on EVERY
//      Response. Per Google's quota guide: "all API requests, including
//      invalid requests, incur at least a one-point quota cost." 2xx,
//      4xx, 5xx all bill the same; the only zero-cost case is a network
//      failure that never returns a Response — fetchWithTimeout throws
//      above the increment in that case.
//   2. On 403 with errors[0].reason='quotaExceeded', emits a single
//      quota.service_throttled audit row via markThrottleTransition.
//      Idempotent across replicas via the (date_pacific, state)
//      composite guard inside markThrottleTransition itself.
//   3. Logs a structured warn line with caller-supplied `ctx` so log
//      search finds non-2xx by jobId / channelId / videoId / handle.
//
// Returns the raw Response on 2xx so callers parse with their own zod
// schema. Returns null on non-2xx so callers shape their own
// continue/break/return locally — no exceptions thrown for status,
// keeping the wrapper composition-friendly.

import { incrementUsage, markThrottleTransition } from "../services/youtube-quota-tracker.js";
import { logger } from "../logger.js";

/**
 * Bare fetch with abort-on-timeout. Default 30s — covers Google's worst-
 * case latency for batched videos.list with quotaUser (the slowest YouTube
 * Data API call we make). The metadata-fetch path passes a tighter 10s
 * since it's user-facing (paste form blocks on the result).
 */
export async function fetchWithTimeout(url: URL, timeoutMs = 30_000): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Quota-charged + throttle-aware YouTube fetch.
 *
 * Returns the Response unconditionally (never throws on status). Callers
 * inspect `.ok` and choose their own bail shape — backfill uses
 * return/break/continue, the adapter classifies into a SnapshotStatus,
 * the metadata service throws an AppError(502). Quota is charged BEFORE
 * the response is returned so 4xx/5xx still consume units (Google's
 * docs: "all API requests, including invalid requests, incur at least
 * a one-point quota cost").
 *
 * `ctx.logTag` is the prefix every log line uses (e.g.
 * "channel-context-backfill: playlistItems.list"). The remaining ctx
 * keys are passed through unchanged so the operator's log search stays
 * tagged with jobId / channelId / videoId / handle / page / batch etc.
 *
 * `timeoutMs` defaults to fetchWithTimeout's 30s. Override to a shorter
 * value for user-facing paths (paste form metadata fetch).
 */
export async function chargedFetch(
  url: URL,
  picked: { apiKey: string; apiKeyId: string },
  units: number,
  ctx: Record<string, unknown> & { logTag: string },
  timeoutMs?: number,
): Promise<Response> {
  const resp = await fetchWithTimeout(url, timeoutMs);
  await incrementUsage({ apiKeyId: picked.apiKeyId, units });

  if (resp.ok) return resp;

  if (resp.status === 403) {
    let reason: string | null = null;
    try {
      const body = (await resp.clone().json()) as {
        error?: { errors?: { reason?: string }[] };
      };
      reason = body?.error?.errors?.[0]?.reason ?? null;
    } catch {
      reason = null;
    }
    if (reason === "quotaExceeded") {
      try {
        await markThrottleTransition({
          state: "ninetyfive",
          apiKeyId: picked.apiKeyId,
          estimatedUnits: 9500,
        });
      } catch (err) {
        logger.warn({ err, ...ctx }, `${ctx.logTag}: markThrottleTransition (95%) failed`);
      }
    }
  }

  logger.warn({ status: resp.status, ...ctx }, `${ctx.logTag}: non-2xx`);
  return resp;
}
