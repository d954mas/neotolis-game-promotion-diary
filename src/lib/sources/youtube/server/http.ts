// Shared YouTube HTTP wrapper with DB-backed quota reservation and
// AdapterError taxonomy.
//
// chargedFetch reserves quota in youtube_service_quota_usage before the
// upstream request starts. That makes the operator API budget clean-safe
// across worker replicas. A network failure may over-count our internal
// reservation, but it cannot over-burn Google's quota.
//
// fetchWithTimeout is the lower-level primitive used by batched videos.list
// paths that already reserved quota at the worker boundary.

import {
  hasYoutubeApiKeys,
  hashApiKeyId,
  markThrottleTransition,
  msUntilMidnightPacific,
  reserveYoutubeQuota,
} from "./quota.js";
import { logger } from "$lib/server/logger.js";
import { AdapterError } from "$lib/sources/errors.js";

/**
 * Bare fetch with abort-on-timeout. Default 30s covers Google's slowest
 * batched videos.list calls; user-facing paths pass a tighter timeout.
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

export interface ChargedFetchContext {
  origin: "cron" | "user";
  logTag: string;
  [key: string]: unknown;
}

export async function chargedFetch(
  url: URL,
  units: number,
  ctx: ChargedFetchContext,
  timeoutMs?: number,
): Promise<Response> {
  const permit = await reserveYoutubeQuota({ origin: ctx.origin, units });
  if (permit === null) {
    if (!hasYoutubeApiKeys()) {
      throw new AdapterError("YouTube API keys are not configured", {
        category: "operator-issue",
        context: { origin: ctx.origin, units, logTag: ctx.logTag },
      });
    }
    throw new AdapterError(`YouTube quota pool exhausted for origin=${ctx.origin}`, {
      category: "rate-limited",
      retryAfterMs: msUntilMidnightPacific(),
      context: { origin: ctx.origin, units, logTag: ctx.logTag },
    });
  }

  url.searchParams.set("key", permit.apiKey);
  const resp = await fetchWithTimeout(url, timeoutMs);
  if (resp.ok) return resp;

  if (resp.status === 403) {
    let reason: string | null;
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
          apiKeyId: permit.apiKeyId,
          estimatedUnits: 9500,
        });
      } catch (err) {
        logger.warn({ err, ...ctx }, `${ctx.logTag}: markThrottleTransition (95%) failed`);
      }
      logger.warn(
        { status: 403, reason, ...ctx },
        `${ctx.logTag}: 403 quotaExceeded -> AdapterError(rate-limited)`,
      );
      throw new AdapterError("YouTube daily quota exceeded", {
        category: "rate-limited",
        retryAfterMs: msUntilMidnightPacific(),
        context: { apiKeyId: permit.apiKeyId, reason, logTag: ctx.logTag },
      });
    }
    logger.warn(
      { status: 403, reason, ...ctx },
      `${ctx.logTag}: 403 non-quotaExceeded -> AdapterError(operator-issue)`,
    );
    throw new AdapterError("YouTube auth failed (operator-issue)", {
      category: "operator-issue",
      context: { apiKeyId: permit.apiKeyId, reason, logTag: ctx.logTag },
    });
  }

  if (resp.status === 404) {
    logger.warn({ status: 404, ...ctx }, `${ctx.logTag}: 404 -> AdapterError(not-found)`);
    throw new AdapterError("YouTube resource not found", {
      category: "not-found",
      context: { apiKeyId: permit.apiKeyId, logTag: ctx.logTag },
    });
  }

  if (resp.status >= 500) {
    logger.warn({ status: resp.status, ...ctx }, `${ctx.logTag}: 5xx -> AdapterError(transient)`);
    throw new AdapterError(`YouTube transient ${resp.status}`, {
      category: "transient",
      context: { apiKeyId: permit.apiKeyId, status: resp.status, logTag: ctx.logTag },
    });
  }

  if (resp.status === 401) {
    logger.warn(
      { status: 401, ...ctx },
      `${ctx.logTag}: 401 -> AdapterError(operator-issue, key may be revoked)`,
    );
    throw new AdapterError("YouTube auth failed (401 - key invalid or revoked)", {
      category: "operator-issue",
      context: { apiKeyId: permit.apiKeyId, status: 401, logTag: ctx.logTag },
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
      { status: 429, retryAfterMs, ...ctx },
      `${ctx.logTag}: 429 -> AdapterError(rate-limited)`,
    );
    throw new AdapterError("YouTube rate-limited (429)", {
      category: "rate-limited",
      retryAfterMs,
      context: { apiKeyId: permit.apiKeyId, status: 429, logTag: ctx.logTag },
    });
  }

  if (resp.status === 400) {
    logger.warn(
      { status: 400, ...ctx },
      `${ctx.logTag}: 400 -> AdapterError(permanent, request shape rejected)`,
    );
    throw new AdapterError("YouTube bad request (400 - caller bug)", {
      category: "permanent",
      context: { apiKeyId: permit.apiKeyId, status: 400, logTag: ctx.logTag },
    });
  }

  logger.warn(
    { status: resp.status, ...ctx },
    `${ctx.logTag}: ${resp.status} -> AdapterError(transient, last-resort)`,
  );
  throw new AdapterError(`YouTube unexpected ${resp.status}`, {
    category: "transient",
    context: { apiKeyId: permit.apiKeyId, status: resp.status, logTag: ctx.logTag },
  });
}

export { hashApiKeyId };
