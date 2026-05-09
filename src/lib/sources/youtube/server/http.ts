// Phase 03.0.1 Plan 08 — shared YouTube HTTP wrapper with rate-limit reservoir
// (D-09) + AdapterError taxonomy (D-13) wired in.
//
// Pre-Plan-08: chargedFetch returned a Response unconditionally and let
// callers inspect `.ok` to shape their own bail (each call site classified
// errors into a SnapshotStatus or threw an AppError(502) ad-hoc). Plan 08
// upgrades the wrapper so EVERY non-2xx flows through AdapterError's 5
// categories — the worker handler's catch block (./handlers/poll-user.ts
// + Plan 10's backfill-user.ts + channel-context-backfill.ts) routes by
// category to needs_reconnect / pg-boss retry / silent skip.
//
// Two helpers, two accounting boundaries (unchanged from pre-Plan-08):
//
//   chargedFetch — canonical wrapper; charges quota + emits throttle audit
//     at the fetch site. Now also: consumes a rate-limit reservoir
//     (cron 80% / user 20% pool split per ctx.origin) BEFORE the fetch,
//     and throws AdapterError on every error path. Used by every YouTube
//     API call EXCEPT pollStatsBatch (the per-event stats poller — see
//     adapter.ts header for why).
//
//   fetchWithTimeout — lower-level primitive used by pollStatsBatch (the
//     writeSnapshot-accounted path). Unchanged: never throws on status,
//     never charges. The adapter's pollStatsBatch path emits its own
//     SnapshotStatus rather than going through AdapterError because each
//     video result needs its own status mapping (the batched videos.list
//     call returns a 200 with N item-level outcomes; mapping to a single
//     AdapterError throw would lose the per-video resolution).
//
// Rate-limit reservoir (D-09 / RESEARCH.md SOTA divergence #1):
//   In-process RateLimiterMemory split into two pools per Pacific day:
//     - cronReservoir (8000 points / 24h) — 80% of envelope, consumed by
//       handlers running in scheduler/cron context (poll-cron tier-batch,
//       channel-context-backfill on createSource, rehab-unavailable, etc.).
//     - userReservoir (2000 points / 24h) — 20% of envelope, consumed by
//       handlers running in user-driven context (poll-user, Plan 10
//       backfill-user, /events/new metadata fetch).
//   Origin is a property of AdapterContext — NOT the call site. The same
//   chargedFetch invocation reads ctx.origin from the caller-supplied
//   context.
//   The persistent counter (youtube_service_quota_usage) remains the
//   AUTHORITATIVE state — the reservoir is a fast-path approximation that
//   prevents one origin from starving the other within a Pacific day.
//   reconcileReservoirsOnBoot() syncs the in-memory reservoirs to the
//   durable counter at worker boot; mid-process restarts may briefly
//   over-allow until reconciliation runs.
//   The "Simpler alternative" in RESEARCH.md notes this is partly redundant
//   with the existing throttle gate at scheduler-tick (which pauses Cold
//   + auto-import at 80% of the AGGREGATE counter). The reservoir adds
//   ORIGIN-SCOPED budget split — the throttle gate alone could let a
//   user-driven Refresh-now flood eat into the cron's reserve. Per CONTEXT
//   D-09 (locked) we ship the reservoir as the explicit mechanism.
//
// AdapterError taxonomy (D-13 — see $lib/sources/errors.ts):
//   - 'rate-limited'  → quota / reservoir exhausted; pg-boss retries with retryAfterMs
//   - 'not-found'     → 404 from upstream; worker marks event unavailable
//   - 'operator-issue'→ 403 non-quotaExceeded; worker sets data_sources.needs_reconnect
//   - 'permanent'     → not used by this adapter (future ToS-block path)
//   - 'transient'     → 5xx; pg-boss retries with backoff
//   The 200 + .ok return path is unchanged — non-error responses still flow
//   back to callers for body parsing.

import { RateLimiterMemory, type RateLimiterRes } from "rate-limiter-flexible";
import { hashApiKeyId, incrementUsage, markThrottleTransition, todayPacific } from "./quota.js";
import { youtubeServiceQuotaUsage } from "$lib/server/db/schema/index.js";
import { db } from "$lib/server/db/client.js";
import { eq } from "drizzle-orm";
import { logger } from "$lib/server/logger.js";
import { AdapterError } from "$lib/sources/errors.js";

// ---- Rate-limit reservoir (D-09 — RESEARCH.md SOTA divergence #1) ----
//
// 24-hour reservoirs (one per origin pool) capping the operator's daily
// envelope. Total across pools = 10000 (one key) — operators with N>1
// keys still see N×10000 from the persistent counter; reservoirs are a
// SAFETY FLOOR, not a ceiling-extender. If env.SERVICE_YOUTUBE_API_KEYS
// has 3 keys the reservoirs cap at 10000 across origins — over-cautious
// vs. the 30000 actual envelope; acceptable for v0.1 (RESEARCH.md notes
// this is a "Simpler alternative" candidate; CONTEXT D-09 locks the
// reservoir mechanism).
//
// `duration: 86400` rolls a sliding 24h window. The youtube.quota_reset
// cron at midnight Pacific re-resolves alignment with the
// youtube_service_quota_usage counter via reconcileReservoirsOnBoot()
// (which is called explicitly by the worker bootstrap and by the
// quota-reset handler so the reservoir tracks the persistent counter
// after each Pacific-day flip).
const cronReservoir = new RateLimiterMemory({ points: 8000, duration: 86_400 });
const userReservoir = new RateLimiterMemory({ points: 2000, duration: 86_400 });

const RESERVOIR_KEY = "youtube"; // single bucket per pool — operator-side counter, no per-user shard.

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
 * Caller-supplied context for chargedFetch.
 *
 * `origin` selects the reservoir pool ('cron' → 80% pool; 'user' → 20%).
 * `logTag` prefixes structured log lines (existing contract).
 * Other keys are passed through to log lines unchanged (jobId / channelId /
 * videoId / handle / page / batch).
 *
 * `origin` is required because v0.1's call sites (channel-context-backfill,
 * poll-content auto-import) all run in cron context; threading the value
 * through forces a deliberate decision at every new caller in Phases 6+.
 */
export interface ChargedFetchContext {
  origin: "cron" | "user";
  logTag: string;
  [key: string]: unknown;
}

/**
 * Quota-charged + reservoir-aware + AdapterError-throwing YouTube fetch.
 *
 * Behavior:
 *   1. Consume `units` from the origin's reservoir (cron / user pool).
 *      Throws AdapterError(rate-limited) on exhaustion with retryAfterMs
 *      from RateLimiterRes.msBeforeNext.
 *   2. fetchWithTimeout → upstream Response.
 *   3. UPSERT youtube_service_quota_usage += units (charged on EVERY
 *      Response per Google's quota guide: "all API requests, including
 *      invalid requests, incur at least a one-point quota cost").
 *   4. If 2xx — return the Response. Caller parses body + drives logic.
 *   5. If 403 + reason='quotaExceeded' — emit throttle audit (idempotent
 *      via markThrottleTransition's per-(date_pacific, state) guard),
 *      then throw AdapterError(rate-limited) with retryAfterMs honoring
 *      msUntilMidnightPacific.
 *   6. If 403 other — throw AdapterError(operator-issue). Worker handler
 *      flips data_sources.needs_reconnect = true (D-13).
 *   7. If 404 — throw AdapterError(not-found). Worker handler marks the
 *      event unavailable; source is NOT flagged (D-13 — the upstream
 *      resource is gone, source itself may be fine).
 *   8. If 5xx — throw AdapterError(transient). pg-boss retries with backoff.
 *   9. Other 4xx (401 / 400 / 429 etc.) — throw AdapterError(transient)
 *      conservatively (default to retry rather than swallow — the existing
 *      pre-Plan-08 callers logged + bailed; AdapterError(transient) gives
 *      pg-boss the same retry posture without swallowing).
 *
 * The reservoir consume happens BEFORE fetch so a flooded cron run is
 * detected without burning a unit upstream. The persistent counter increment
 * happens AFTER fetch on every Response so accounting matches Google's
 * "every request bills" rule even on errors.
 */
export async function chargedFetch(
  url: URL,
  picked: { apiKey: string; apiKeyId: string },
  units: number,
  ctx: ChargedFetchContext,
  timeoutMs?: number,
): Promise<Response> {
  // 1. Reservoir consume — origin-scoped pool. Throws rate-limited on
  //    exhaustion BEFORE we burn the upstream unit.
  const reservoir = ctx.origin === "cron" ? cronReservoir : userReservoir;
  try {
    await reservoir.consume(RESERVOIR_KEY, units);
  } catch (rejRes: unknown) {
    const msBefore = (rejRes as RateLimiterRes | undefined)?.msBeforeNext ?? 60_000;
    throw new AdapterError(`YouTube reservoir exhausted for origin=${ctx.origin}`, {
      category: "rate-limited",
      retryAfterMs: msBefore,
      context: {
        apiKeyId: picked.apiKeyId,
        origin: ctx.origin,
        units,
        logTag: ctx.logTag,
      },
    });
  }

  // 2. Upstream fetch.
  const resp = await fetchWithTimeout(url, timeoutMs);

  // 3. Charge the persistent counter on EVERY Response. Network failures
  //    that throw above this line (timeout / connection refused) charge 0
  //    — they never reached YouTube.
  await incrementUsage({ apiKeyId: picked.apiKeyId, units });

  // 4. Success path — return for caller-side body parse.
  if (resp.ok) return resp;

  // 5-9. Error path — classify into AdapterError category.
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
      logger.warn(
        { status: 403, reason, ...ctx },
        `${ctx.logTag}: 403 quotaExceeded → AdapterError(rate-limited)`,
      );
      throw new AdapterError("YouTube daily quota exceeded", {
        category: "rate-limited",
        retryAfterMs: msUntilMidnightPacific(),
        context: { apiKeyId: picked.apiKeyId, reason, logTag: ctx.logTag },
      });
    }
    logger.warn(
      { status: 403, reason, ...ctx },
      `${ctx.logTag}: 403 non-quotaExceeded → AdapterError(operator-issue)`,
    );
    throw new AdapterError("YouTube auth failed (operator-issue)", {
      category: "operator-issue",
      context: { apiKeyId: picked.apiKeyId, reason, logTag: ctx.logTag },
    });
  }
  if (resp.status === 404) {
    logger.warn({ status: 404, ...ctx }, `${ctx.logTag}: 404 → AdapterError(not-found)`);
    throw new AdapterError("YouTube resource not found", {
      category: "not-found",
      context: { apiKeyId: picked.apiKeyId, logTag: ctx.logTag },
    });
  }
  if (resp.status >= 500) {
    logger.warn({ status: resp.status, ...ctx }, `${ctx.logTag}: 5xx → AdapterError(transient)`);
    throw new AdapterError(`YouTube transient ${resp.status}`, {
      category: "transient",
      context: { apiKeyId: picked.apiKeyId, status: resp.status, logTag: ctx.logTag },
    });
  }
  // Phase 03.0.1 (post-review) — explicit 4xx classification. Pre-fix all
  // remaining 4xx fell through to `transient` which made pg-boss retry
  // forever on permanent errors:
  //   - 401 invalid/expired API key → operator-issue (flag needs_reconnect,
  //     stop retrying, surface to /admin/quota)
  //   - 429 rate-limited per-key (not the daily quota — that's 403
  //     quotaExceeded above) → rate-limited with Retry-After backoff
  //   - 400 bad request → permanent (caller bug; retrying same payload
  //     will fail same way)
  //   - other unexpected 4xx → transient (last resort fallback — surfaces
  //     in audit so operator sees retry storms and investigates)
  if (resp.status === 401) {
    logger.warn(
      { status: 401, ...ctx },
      `${ctx.logTag}: 401 → AdapterError(operator-issue, key may be revoked)`,
    );
    throw new AdapterError("YouTube auth failed (401 — key invalid or revoked)", {
      category: "operator-issue",
      context: { apiKeyId: picked.apiKeyId, status: 401, logTag: ctx.logTag },
    });
  }
  if (resp.status === 429) {
    // Parse Retry-After (seconds OR HTTP-date). Default to 60s if missing
    // or unparseable — gives pg-boss a sane backoff without hammering.
    const retryAfterHeader = resp.headers.get("retry-after");
    let retryAfterMs = 60_000;
    if (retryAfterHeader !== null) {
      const asInt = parseInt(retryAfterHeader, 10);
      if (Number.isFinite(asInt) && asInt > 0) {
        retryAfterMs = asInt * 1000;
      } else {
        const asDate = Date.parse(retryAfterHeader);
        if (Number.isFinite(asDate)) {
          retryAfterMs = Math.max(1000, asDate - Date.now());
        }
      }
    }
    logger.warn(
      { status: 429, retryAfterMs, ...ctx },
      `${ctx.logTag}: 429 → AdapterError(rate-limited)`,
    );
    throw new AdapterError("YouTube rate-limited (429)", {
      category: "rate-limited",
      retryAfterMs,
      context: { apiKeyId: picked.apiKeyId, status: 429, logTag: ctx.logTag },
    });
  }
  if (resp.status === 400) {
    logger.warn(
      { status: 400, ...ctx },
      `${ctx.logTag}: 400 → AdapterError(permanent, request shape rejected)`,
    );
    throw new AdapterError("YouTube bad request (400 — caller bug)", {
      category: "permanent",
      context: { apiKeyId: picked.apiKeyId, status: 400, logTag: ctx.logTag },
    });
  }
  // Other unexpected 4xx — last-resort transient. Audit storms surface in
  // /admin/quota so operator can investigate.
  logger.warn(
    { status: resp.status, ...ctx },
    `${ctx.logTag}: ${resp.status} → AdapterError(transient, last-resort)`,
  );
  throw new AdapterError(`YouTube unexpected ${resp.status}`, {
    category: "transient",
    context: { apiKeyId: picked.apiKeyId, status: resp.status, logTag: ctx.logTag },
  });
}

/**
 * Compute milliseconds until the next midnight Pacific (YouTube's daily
 * quota reset boundary). Used as retryAfterMs for rate-limited
 * AdapterErrors so pg-boss waits until the reset instead of hammering.
 */
function msUntilMidnightPacific(): number {
  const now = new Date();
  const todayPT = todayPacific(now);
  // todayPT is "YYYY-MM-DD" in America/Los_Angeles. Compute the next-day
  // midnight by adding 24h to today's PT-midnight UTC instant. Use Intl
  // to get the offset; sv-SE locale gives ISO shape.
  // Alternative: parse todayPT via a fixture date and add 24h. Simpler:
  // rely on Date.now() walked forward to the next PT-midnight, computed
  // by checking the next 25 hours (covers DST forward leaps).
  for (let i = 1; i <= 25; i++) {
    const candidate = new Date(now.getTime() + i * 3_600_000);
    const candidatePT = todayPacific(candidate);
    if (candidatePT !== todayPT) {
      // candidate's hour is the FIRST hour of the next PT day (or close to
      // it; minute granularity is acceptable for retryAfter bounding).
      // Walk back to the boundary.
      const boundary = new Date(candidate.getTime());
      boundary.setUTCMinutes(0, 0, 0);
      // Refine to find the minute the day flipped. We're within a 1h
      // window; round up rather than refine further — the retry-after is
      // a hint, not a deadline.
      return Math.max(60_000, boundary.getTime() - now.getTime());
    }
  }
  // Fallback — shouldn't reach (todayPacific changes within 25h by
  // construction). Default to 1h.
  return 3_600_000;
}

/**
 * Reconcile in-memory reservoirs to the persistent youtube_service_quota_usage
 * counter on worker boot.
 *
 * RateLimiterMemory loses state across process restarts; without
 * reconciliation a worker that crashed at 7000 cron units used would re-
 * start with a fresh 8000-unit cron pool — temporary over-allow until the
 * youtube_service_quota_usage counter catches the next throttle threshold.
 *
 * Reconciliation strategy (RESEARCH.md Pattern 5 paragraph): sum today's
 * persistent counter rows and consume that many points from the cron
 * reservoir at boot (we do NOT split the persistent counter between cron
 * and user — pre-Plan-08 the counter was origin-agnostic, so attributing
 * past usage to a pool would be guesswork). User reservoir starts fresh.
 * This is intentionally lossy on the over-cautious side: a worker restart
 * after heavy user activity briefly under-allows user requests until they
 * settle into the user pool's natural cadence; that's safer than over-
 * allowing past the operator's daily envelope.
 *
 * Called from src/worker/index.ts BEFORE the per-source registerQueues
 * loop, and from quota-reset.ts at midnight Pacific (RateLimiterMemory's
 * 24h sliding window may not align exactly with the YouTube reset
 * boundary — re-syncing on the boundary keeps drift bounded).
 */
export async function reconcileReservoirsOnBoot(): Promise<void> {
  const todayPT = todayPacific();
  const rows = await db
    .select({
      estimatedUnits: youtubeServiceQuotaUsage.estimatedUnits,
    })
    .from(youtubeServiceQuotaUsage)
    .where(eq(youtubeServiceQuotaUsage.datePacific, todayPT));
  const totalUnitsUsedToday = rows.reduce((sum, r) => sum + (r.estimatedUnits ?? 0), 0);
  if (totalUnitsUsedToday <= 0) {
    logger.info(
      { totalUnitsUsedToday: 0, datePacific: todayPT },
      "youtube reservoirs: no usage today; reservoirs start fresh",
    );
    return;
  }
  // Cap the consume at the cron reservoir's points so we don't error on
  // RateLimiterMemory's "consumed > points" rejection — if usage exceeds
  // the cron pool budget we just zero out the cron pool (worst case:
  // worker that ran above the 80% cron budget mid-day; user pool starts
  // fresh).
  const cronConsume = Math.min(totalUnitsUsedToday, 8000);
  try {
    await cronReservoir.consume(RESERVOIR_KEY, cronConsume);
    logger.info(
      { totalUnitsUsedToday, cronConsume, datePacific: todayPT },
      "youtube reservoirs reconciled to persistent counter",
    );
  } catch (err) {
    logger.warn(
      { err, totalUnitsUsedToday, cronConsume },
      "youtube reservoirs: cronReservoir consume failed during reconciliation",
    );
  }
}

/**
 * Reset both reservoirs to full. Called from quota-reset.ts at midnight
 * Pacific (D-13 alignment with YouTube's daily quota reset boundary —
 * RateLimiterMemory's 24h sliding window may not align exactly with the
 * YouTube reset, so we reset on the cron tick and follow with
 * reconcileReservoirsOnBoot to seed today's already-burned units), and
 * from unit tests that need a clean slate between cases.
 */
export async function resetReservoirs(): Promise<void> {
  await cronReservoir.delete(RESERVOIR_KEY);
  await userReservoir.delete(RESERVOIR_KEY);
}

/**
 * Test-only alias for resetReservoirs — preserved for grep-friendly
 * test discovery. Production code should call resetReservoirs directly.
 */
export const __resetReservoirsForTest = resetReservoirs;

/**
 * Re-export hashApiKeyId so test fixtures and the reconciliation helper
 * can compute the same identifier the adapter writes. Avoids forcing
 * tests/integration/* to reach into ./quota.js for a pure-function helper.
 */
export { hashApiKeyId };
