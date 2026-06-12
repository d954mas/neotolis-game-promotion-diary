// TikTok (ScrapeCreators) HTTP wrapper — timeout + status→AdapterError mapping
// + per-request OBS emission, the SECOND impl of the social-provider HTTP seam
// (instagram/server/http.ts is the first). Cloned from the IG wrapper and
// re-pointed to platform label "tiktok"; the budget machinery
// (reserveSocialCredits / getSocialSpendToday) is the SHARED social-provider
// quota — keyed by PROVIDER ("scrapecreators"), the prepaid balance is one pool
// across IG + TikTok (D-01) — so we import it from the instagram tree rather
// than fork a second copy of the credit ledger.
//
// This wrapper is where the provider seam's HTTP discipline lives, so the
// provider (provider/scrapecreators-tiktok.ts) stays a thin issuer that never
// touches prom-client and never re-implements the AbortController/error-map
// boilerplate.
//
// status→AdapterError taxonomy (IDENTICAL to IG — D-24):
//   - 401 → operator-issue   (bad / revoked x-api-key)
//   - 402 → operator-issue   (prepaid balance exhausted — surfaces in /admin/quota)
//   - 404 → not-found        (missing handle — belt-and-suspenders; TikTok's
//                             PRIMARY missing-handle signal is HTTP 200 + no
//                             `user` body on /v1/tiktok/profile, mapped by
//                             null-by-presence in resolveAccount — 10-SPIKE.md)
//   - 429 → rate-limited     (parse Retry-After)
//   - 5xx → transient
//   - 400 → permanent
//
// Credit reservation (reserve-before-HTTP, D-18 / BUDGET-02): every provider
// request reserves one prepaid credit via reserveSocialCredits BEFORE the HTTP
// call when an `origin` pool is set. A null permit (prepaid balance exhausted OR
// the daily pool / 95% throttle full) STOPS the request — the provider is never
// over-spent past the prepaid balance. resolveAccount (create-time profile
// resolution) now meters against the "user" pool — the profile endpoint costs a
// credit (10-SPIKE), so leaving it unmetered let add-source floods bypass the
// budget guardrails. The only remaining unmetered path is the additive
// credit-balance read (getCreditBalance — D-23, never depended on), which omits
// `origin`.

import { env } from "$lib/server/config/env.js";
import { logger } from "$lib/server/logger.js";
import { AdapterError } from "$lib/sources/errors.js";
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

/**
 * Bare fetch with abort-on-timeout. 30s default mirrors the IG wrapper (covers
 * ScrapeCreators' slowest payloads). The x-api-key header rides in `headers`.
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

export interface TikTokFetchContext {
  platform: SocialPlatform;
  provider: string;
  logTag: string;
  /** Credits charged on a successful (200) request. Defaults to 1 (D-18). */
  creditsUsed?: number;
  /**
   * Budget pool to reserve against BEFORE the HTTP call (BUDGET-02).
   *   - "user": user-initiated work (onboarding add / refresh-now / widen).
   *   - "cron": background work (incremental + auto-backfill continuation pages).
   * When set, reserveSocialCredits(units=creditsUsed??1) runs first; a null
   * permit throws AdapterError (operator-issue when the prepaid balance is the
   * blocker, rate-limited when the daily pool / 95% throttle is the blocker) so
   * the walker pauses + persists its cursor. resolveAccount (create-time profile
   * resolution) meters against the "user" pool — the profile endpoint costs a
   * credit (10-SPIKE), so leaving it unmetered let add-source floods bypass the
   * budget guardrails. The only remaining unmetered path is the additive
   * credit-balance read, which omits `origin`.
   */
  origin?: SocialQuotaPool;
}

/** Bucket an HTTP status (or a non-HTTP failure) into the `status` OBS label. */
function statusLabel(httpStatus: number): string {
  if (httpStatus === 200) return "200";
  if (httpStatus >= 500) return "5xx";
  if (httpStatus >= 400) return "4xx";
  return "other";
}

/**
 * Issue a ScrapeCreators TikTok request with the x-api-key header, emit the
 * per-request OBS metrics, and map non-2xx to AdapterError. Returns the raw
 * Response on 200 for the caller to JSON-parse + normalize.
 */
export async function tiktokFetch(url: URL, ctx: TikTokFetchContext): Promise<Response> {
  const { platform: reservePlatform, provider: reserveProvider } = ctx;
  if (ctx.origin !== undefined) {
    // Reserve-before-HTTP (BUDGET-02): decrement the daily counter AND the
    // shared prepaid balance in one FOR-UPDATE tx before issuing the request. A
    // null permit means the spend would over-run the budget — refuse it.
    const permit = await reserveSocialCredits({
      platform: reservePlatform,
      provider: reserveProvider,
      origin: ctx.origin,
      units: ctx.creditsUsed ?? 1,
    });
    if (permit === null) {
      // Disambiguate the two null causes so the caller maps the right
      // AdapterError category (mirrors IG's two-branch null handling):
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

  const headers = { "x-api-key": env.SCRAPECREATORS_API_KEY };
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
    throw new AdapterError(`ScrapeCreators ${status}`, {
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
      `${ctx.logTag}: 401 -> AdapterError(operator-issue, x-api-key invalid/revoked)`,
    );
    throw new AdapterError("ScrapeCreators auth failed (401 - key invalid or revoked)", {
      category: "operator-issue",
      context: { platform, provider, status: 401, logTag: ctx.logTag },
    });
  }

  if (resp.status === 402) {
    logger.warn(
      { status: 402, platform, provider, logTag: ctx.logTag },
      `${ctx.logTag}: 402 -> AdapterError(operator-issue, prepaid balance exhausted)`,
    );
    throw new AdapterError("ScrapeCreators prepaid balance exhausted (402)", {
      category: "operator-issue",
      context: { platform, provider, status: 402, logTag: ctx.logTag },
    });
  }

  if (resp.status === 404) {
    logger.warn(
      { status: 404, platform, provider, logTag: ctx.logTag },
      `${ctx.logTag}: 404 -> AdapterError(not-found, missing handle)`,
    );
    throw new AdapterError("ScrapeCreators resource not found (404 - missing handle)", {
      category: "not-found",
      context: { platform, provider, status: 404, logTag: ctx.logTag },
    });
  }

  if (resp.status === 429) {
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
      { status: 429, retryAfterMs, platform, provider, logTag: ctx.logTag },
      `${ctx.logTag}: 429 -> AdapterError(rate-limited)`,
    );
    throw new AdapterError("ScrapeCreators rate-limited (429)", {
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
    throw new AdapterError(`ScrapeCreators transient ${resp.status}`, {
      category: "transient",
      context: { platform, provider, status: resp.status, logTag: ctx.logTag },
    });
  }

  if (resp.status === 400) {
    logger.warn(
      { status: 400, platform, provider, logTag: ctx.logTag },
      `${ctx.logTag}: 400 -> AdapterError(permanent, request shape rejected)`,
    );
    throw new AdapterError("ScrapeCreators bad request (400 - caller bug)", {
      category: "permanent",
      context: { platform, provider, status: 400, logTag: ctx.logTag },
    });
  }

  logger.warn(
    { status: resp.status, platform, provider, logTag: ctx.logTag },
    `${ctx.logTag}: ${resp.status} -> AdapterError(transient, last-resort)`,
  );
  throw new AdapterError(`ScrapeCreators unexpected ${resp.status}`, {
    category: "transient",
    context: { platform, provider, status: resp.status, logTag: ctx.logTag },
  });
}
