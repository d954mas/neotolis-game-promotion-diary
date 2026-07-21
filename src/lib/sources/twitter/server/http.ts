// Twitter/X (twitterapi.io) HTTP wrapper — timeout + status→AdapterError mapping
// + per-request OBS emission. This is the THIRD impl of the social-provider HTTP
// seam (instagram/server/http.ts + tiktok/server/http.ts are the first two) and
// the FIRST against a SECOND vendor (twitterapi.io, NOT ScrapeCreators — D-01).
//
// Cloned from the TikTok wrapper and re-pointed in exactly three places
// (11-RESEARCH §Pattern 2):
//   1. base URL  → https://api.twitterapi.io (a literal const — no env override;
//                  the spike found no need, and the single-home rule keeps the
//                  base in ONE place rather than a fourth env var).
//   2. auth header → { "X-API-Key": env.TWITTERAPIIO_API_KEY }  (NOT x-api-key /
//                    SCRAPECREATORS_API_KEY — twitterapi.io's own prepaid key).
//   3. platform/provider labels → "twitter" / "twitterapi.io" in reserveSocialCredits,
//                                 the OBS emit, and every AdapterError context.
//
// The budget machinery (reserveSocialCredits / getSocialSpendToday) is the SHARED
// social-provider quota imported from the instagram tree. The prepaid balance is
// keyed by PROVIDER, so "twitterapi.io" gets its OWN balance row automatically
// (the Plan 10-01 per-provider re-key, D-02) — we do NOT fork a fourth ledger.
//
// CREDIT-UNIT DECISION (11-SPIKE.md Q5, Pattern 3): internal credit = ONE provider
// request (`creditsUsed: 1` per page), exactly like ScrapeCreators — so the 80/95
// throttle + daily cap + prepaid balance count REQUESTS uniformly across both
// vendors. twitterapi.io bills per RETURNED TWEET (15 credits/tweet in their own
// 100k-credits-per-$1 unit), so the real-dollar cost is documented separately as
// USD_PER_REQUEST below; the ledger never tracks twitterapi.io's native credits.
//
// status→AdapterError taxonomy (IDENTICAL to TikTok/IG — D-24):
//   - 401 → operator-issue   (bad / revoked X-API-Key)
//   - 402 → operator-issue   (prepaid balance exhausted — surfaces in /admin/quota)
//   - 404 → not-found        (missing handle — belt-and-suspenders; twitterapi.io's
//                             PRIMARY missing-handle signal is HTTP 200 + `data:null`
//                             on /twitter/user/info, mapped by null-by-presence in
//                             resolveAccount — 11-SPIKE.md Q3)
//   - 429 → rate-limited     (parse Retry-After — see the QPS NOTE below)
//   - 5xx → transient
//   - 400 → permanent
//
// QPS NOTE (the operator's explicit requirement — twitterapi.io rate-limits PER
// API KEY: 0.2 QPS = 1 request / 5s for a never-paid account, 3 QPS after the first
// top-up, higher only with a subscription). The ceiling is shared across EVERY call
// path (backfill / warm-refresh / paste) and across replicas, so this seam enforces
// it PROACTIVELY: every twitterFetch acquires the DB-backed twitter_pacer slot
// (./pacer.ts) BEFORE reserving budget or making the call. A
// denied slot throws AdapterError(rate-limited, retryAfterMs) with NO reservation and
// NO HTTP — the backfill self-resumes and the lane defers, the same path 429 takes.
// Two layers, one classification: (a) the proactive pacer keeps the global rate under
// the floor so a 429 is rarely even provoked; (b) when twitterapi.io DOES return 429
// (e.g. a manual top-up raised the ceiling and the floor is now conservative), the
// honored Retry-After (below) drives the same rate-limited pause-and-resume. The QPS
// knob (TWITTERAPIIO_MIN_REQUEST_INTERVAL_MS) has its single home in ./pacer.ts.
//
// Credit reservation (reserve-before-HTTP, D-18 / BUDGET-02): every provider request
// reserves one prepaid credit via reserveSocialCredits BEFORE the HTTP call when an
// `origin` pool is set. A null permit (prepaid balance exhausted OR the daily pool /
// 95% throttle full) STOPS the request — the provider is never over-spent past the
// prepaid balance.

import { env } from "$lib/server/config/env.js";
import { logger } from "$lib/server/logger.js";
import { AdapterError } from "$lib/sources/errors.js";
import { acquireTwitterPacerSlot, TWITTERAPIIO_MIN_REQUEST_INTERVAL_MS } from "./pacer.js";
import {
  socialProviderCredits,
  socialProviderRequestDuration,
  socialProviderRequests,
} from "$lib/server/metrics.js";
import {
  getSocialSpendToday,
  reserveSocialCredits,
  type SocialQuotaPool,
} from "$lib/sources/instagram/server/quota.js";
import type { SocialPlatform } from "$lib/sources/social-provider.js";

/** twitterapi.io API base — the single home for the literal (Pattern 2 delta #1).
 *  No env override: the spike confirmed one stable base, and a fourth env var
 *  would violate the single-source-of-truth rule for no benefit. */
export const TWITTERAPIIO_BASE_URL = "https://api.twitterapi.io";

/** Real-dollar cost of ONE provider request, for the observability header /
 *  /admin/quota operator note (11-SPIKE.md Q5). A 20-tweet feed page bills ~300
 *  twitterapi.io credits at their 100k-credits-per-$1 rate ≈ $0.003. The internal
 *  ledger counts requests, not these native credits (see the credit-unit decision
 *  above); this constant is documentation, never a reservation amount. */
export const USD_PER_REQUEST = 0.003;

// The QPS floor constant now lives in ./pacer.ts (its single home — the pacer is its
// primary consumer). Re-exported here (imported above) so the seam + walker lane keep
// their existing `import { TWITTERAPIIO_MIN_REQUEST_INTERVAL_MS } from "./http.js"` sites.
export { TWITTERAPIIO_MIN_REQUEST_INTERVAL_MS };

/**
 * Bare fetch with abort-on-timeout. 30s default mirrors the TikTok/IG wrappers.
 * The X-API-Key header rides in `headers`.
 */
export async function fetchWithTimeout(
  url: URL,
  headers: Record<string, string>,
  timeoutMs = 30_000,
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { headers, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface TwitterFetchContext {
  platform: SocialPlatform;
  provider: string;
  logTag: string;
  /** Credits charged on a successful (200) request. Defaults to 1 (D-18) — the
   *  credit-unit decision is 1 request = 1 internal credit (11-SPIKE.md Q5). */
  creditsUsed?: number;
  /**
   * Budget pool to reserve against BEFORE the HTTP call (BUDGET-02).
   *   - "user": user-initiated work (onboarding add / refresh-now / widen).
   *   - "cron": background work (incremental + auto-backfill continuation pages).
   * When set, reserveSocialCredits(units=creditsUsed??1) runs first; a null permit
   * throws AdapterError (operator-issue when the prepaid balance is the blocker,
   * rate-limited when the daily pool / 95% throttle is the blocker) so the walker
   * pauses + persists its cursor.
   */
  origin?: SocialQuotaPool;
  /**
   * Set true when the caller already holds the twitter_pacer slot for this tick (the
   * refresh-lane claimGate acquires it — Plan 11 P1). The seam then SKIPS its own
   * acquireTwitterPacerSlot so the slot isn't double-spent. The backfill pg-boss path
   * has no claimGate → leaves this undefined and acquires at the seam as before.
   */
  pacerAlreadyAcquired?: boolean;
}

/** Bucket an HTTP status (or a non-HTTP failure) into the `status` OBS label. */
function statusLabel(httpStatus: number): string {
  if (httpStatus === 200) return "200";
  if (httpStatus >= 500) return "5xx";
  if (httpStatus >= 400) return "4xx";
  return "other";
}

/**
 * Issue a twitterapi.io request with the X-API-Key header, emit the per-request
 * OBS metrics, and map non-2xx to AdapterError. Returns the raw Response on 200
 * for the caller to JSON-parse + normalize.
 */
export async function twitterFetch(url: URL, ctx: TwitterFetchContext): Promise<Response> {
  const { platform: reservePlatform, provider: reserveProvider } = ctx;

  // Global QPS gate (the per-key twitterapi.io ceiling, shared across backfill / warm /
  // paste / replicas). Acquire the pacer slot FIRST — before the budget reservation —
  // so a denied slot consumes NO prepaid credit and makes NO HTTP call. A miss throws
  // rate-limited with the exact wait; the backfill self-resumes and the lane defers,
  // unified with the 429 handling below. In tests the slot is 0ms so this always passes.
  //
  // EXCEPTION (Plan 11 P1): the refresh lane's claimGate already acquired the slot for
  // this tick and threads pacerAlreadyAcquired=true — re-acquiring here would double-
  // spend the slot (a spurious deny on the second of the pair). Skip in that case.
  if (ctx.pacerAlreadyAcquired !== true) {
    const slot = await acquireTwitterPacerSlot();
    if (!slot.acquired) {
      logger.debug(
        {
          waitMs: slot.waitMs,
          platform: reservePlatform,
          provider: reserveProvider,
          logTag: ctx.logTag,
        },
        `${ctx.logTag}: pacer slot denied -> AdapterError(rate-limited, proactive QPS gate)`,
      );
      throw new AdapterError("twitterapi.io paced (per-key QPS slot not yet available)", {
        category: "rate-limited",
        retryAfterMs: slot.waitMs,
        context: { platform: reservePlatform, provider: reserveProvider, logTag: ctx.logTag },
      });
    }
  }

  if (ctx.origin !== undefined) {
    // Reserve-before-HTTP (BUDGET-02): decrement the daily counter AND the shared
    // prepaid balance in one FOR-UPDATE tx before issuing the request. A null
    // permit means the spend would over-run the budget — refuse it.
    const permit = await reserveSocialCredits({
      platform: reservePlatform,
      provider: reserveProvider,
      origin: ctx.origin,
      units: ctx.creditsUsed ?? 1,
    });
    if (permit === null) {
      // Disambiguate the two null causes so the caller maps the right AdapterError
      // category (mirrors TikTok/IG's two-branch null handling):
      //   prepaid balance == 0 → operator-issue (operator must top up)
      //   daily pool / 95% throttle full → rate-limited (resets at midnight PT)
      const { prepaidBalance } = await getSocialSpendToday(reservePlatform, reserveProvider);
      const exhausted = prepaidBalance <= 0;
      logger.warn(
        {
          platform: reservePlatform,
          provider: reserveProvider,
          origin: ctx.origin,
          prepaidBalance,
        },
        `${ctx.logTag}: reserveSocialCredits null -> AdapterError(${exhausted ? "operator-issue" : "rate-limited"})`,
      );
      throw new AdapterError(
        exhausted
          ? "social provider budget exhausted (prepaid balance depleted)"
          : "social provider daily budget exhausted (throttled)",
        {
          category: exhausted ? "operator-issue" : "rate-limited",
          context: {
            platform: reservePlatform,
            provider: reserveProvider,
            origin: ctx.origin,
            prepaidBalance,
            logTag: ctx.logTag,
          },
        },
      );
    }
  }

  const headers = { "X-API-Key": env.TWITTERAPIIO_API_KEY };
  const { platform, provider } = ctx;
  const startedAt = performance.now();

  let resp: Response;
  try {
    resp = await fetchWithTimeout(url, headers);
  } catch (err) {
    const status = err instanceof DOMException && err.name === "AbortError" ? "timeout" : "error";
    const seconds = (performance.now() - startedAt) / 1000;
    socialProviderRequestDuration.observe({ platform, provider, status }, seconds);
    socialProviderRequests.inc({ platform, provider, status });
    logger.warn(
      { err, platform, provider, logTag: ctx.logTag },
      `${ctx.logTag}: ${status} -> AdapterError(transient)`,
    );
    throw new AdapterError(`twitterapi.io ${status}`, {
      category: "transient",
      cause: err,
      context: { platform, provider, logTag: ctx.logTag },
    });
  }

  const status = statusLabel(resp.status);
  const seconds = (performance.now() - startedAt) / 1000;
  socialProviderRequestDuration.observe({ platform, provider, status }, seconds);
  socialProviderRequests.inc({ platform, provider, status });

  if (resp.ok) {
    // Each successful request consumes one prepaid credit (D-18).
    socialProviderCredits.inc({ platform, provider }, ctx.creditsUsed ?? 1);
    return resp;
  }

  if (resp.status === 401) {
    logger.warn(
      { status: 401, platform, provider, logTag: ctx.logTag },
      `${ctx.logTag}: 401 -> AdapterError(operator-issue, X-API-Key invalid/revoked)`,
    );
    throw new AdapterError("twitterapi.io auth failed (401 - key invalid or revoked)", {
      category: "operator-issue",
      context: { platform, provider, status: 401, logTag: ctx.logTag },
    });
  }

  if (resp.status === 402) {
    logger.warn(
      { status: 402, platform, provider, logTag: ctx.logTag },
      `${ctx.logTag}: 402 -> AdapterError(operator-issue, prepaid balance exhausted)`,
    );
    throw new AdapterError("twitterapi.io prepaid balance exhausted (402)", {
      category: "operator-issue",
      context: { platform, provider, status: 402, logTag: ctx.logTag },
    });
  }

  if (resp.status === 404) {
    logger.warn(
      { status: 404, platform, provider, logTag: ctx.logTag },
      `${ctx.logTag}: 404 -> AdapterError(not-found, missing handle)`,
    );
    throw new AdapterError("twitterapi.io resource not found (404 - missing handle)", {
      category: "not-found",
      context: { platform, provider, status: 404, logTag: ctx.logTag },
    });
  }

  if (resp.status === 429) {
    // The QPS ceiling (TWITTERAPIIO_MIN_REQUEST_INTERVAL_MS above) was crossed —
    // the operator's per-account rate limit. Surface as rate-limited with the
    // honored Retry-After so Plan 03's walker lane backs off (pauses + persists
    // cursor) rather than failing the job. Default 5s if no header — exactly the
    // 0.2-QPS floor a never-paid account must wait between requests.
    const retryAfterHeader = resp.headers.get("retry-after");
    let retryAfterMs = TWITTERAPIIO_MIN_REQUEST_INTERVAL_MS;
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
      { status: 429, retryAfterMs, platform, provider, logTag: ctx.logTag },
      `${ctx.logTag}: 429 -> AdapterError(rate-limited, QPS ceiling)`,
    );
    throw new AdapterError("twitterapi.io rate-limited (429 - per-account QPS ceiling)", {
      category: "rate-limited",
      retryAfterMs,
      context: { platform, provider, status: 429, logTag: ctx.logTag },
    });
  }

  if (resp.status >= 500) {
    logger.warn(
      { status: resp.status, platform, provider, logTag: ctx.logTag },
      `${ctx.logTag}: 5xx -> AdapterError(transient)`,
    );
    throw new AdapterError(`twitterapi.io transient ${resp.status}`, {
      category: "transient",
      context: { platform, provider, status: resp.status, logTag: ctx.logTag },
    });
  }

  if (resp.status === 400) {
    logger.warn(
      { status: 400, platform, provider, logTag: ctx.logTag },
      `${ctx.logTag}: 400 -> AdapterError(permanent, request shape rejected)`,
    );
    throw new AdapterError("twitterapi.io bad request (400 - caller bug)", {
      category: "permanent",
      context: { platform, provider, status: 400, logTag: ctx.logTag },
    });
  }

  logger.warn(
    { status: resp.status, platform, provider, logTag: ctx.logTag },
    `${ctx.logTag}: ${resp.status} -> AdapterError(transient, last-resort)`,
  );
  throw new AdapterError(`twitterapi.io unexpected ${resp.status}`, {
    category: "transient",
    context: { platform, provider, status: resp.status, logTag: ctx.logTag },
  });
}
