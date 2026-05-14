// Reddit HTTP wrapper — DV-RDT-7 public-`.json` adapter.
//
// Responsibilities:
//   - Add `User-Agent: env.REDDIT_USER_AGENT` to every outgoing fetch
//     (V4 — Reddit aggressively rate-limits default UAs).
//   - Map response codes to AdapterError 5-category taxonomy
//     (transient | rate-limited | not-found | permanent | operator-issue).
//   - Detect 403-burst (3 × 403 within a 5-min rolling window) and emit
//     ONE `reddit.adapter_degraded` audit row per burst window
//     (D-RDT-AUTH-403, V5 — not per request: per burst).
//   - Parse `Retry-After` (preferred) or `X-Ratelimit-Reset` for retryAfterMs
//     (V16).
//
// Deliberately NOT here:
//   - Rate-limit budget enforcement — the 8-tick worker in plan 05A owns
//     this. http.ts is a fetch wrapper, not a scheduler.
//   - Bearer/OAuth refresh — no OAuth under DV-RDT-7 (Reddit closed
//     self-service registration Nov 2025; see CONTEXT D-RDT-AUTH-MODEL).
//   - Key rotation — single operator UA.
//   - Retry loops — caller (worker tick or paste flow) decides retry policy
//     based on AdapterError category + retryAfterMs.
//
// Module-scope burst state is in-process. Acceptable under DV-RDT-7
// because D-RDT-WORKER is single-process (env's WORKER_REPLICA_COUNT
// guard rejects N>1 when any adapter sets usesInProcessRateLimiter=true).
// A worker restart loses the burst counter — at worst we emit one extra
// audit row when the next burst trips; safer than over-suppressing.
//
// Audit row policy: writeAudit requires userId NOT NULL (audit_log schema).
// We resolve operator user_id via ADMIN_EMAIL_ALLOWLIST[0] — same pattern
// as YouTube's quota.markThrottleTransition. If no operator is resolvable
// (empty allowlist or admin hasn't signed in yet), we log at WARN and skip
// the audit row; the underlying AdapterError still propagates, so the
// caller sees the rate-limit signal regardless.

import type { z } from "zod";
import { AdapterError } from "$lib/sources/errors.js";
import { pickRedditCredentials } from "./credentials.js";
import { writeAudit } from "$lib/server/audit.js";
import { logger } from "$lib/server/logger.js";
import { env } from "$lib/server/config/env.js";
import { resolveOperatorUserId, __resetOperatorIdCacheForTest } from "./operator-resolver.js";

export interface RedditHttpResult<T> {
  data: T;
  statusCode: number;
  headers: Headers;
}

// Production default = the official reddit.com endpoint. The CI smoke gate
// sets env.REDDIT_BASE_URL_OVERRIDE to a mock reverse-proxy URL so worker
// traffic is intercepted by tests/smoke/lib/reddit-mock.mjs (no live Reddit
// calls in CI). Mirrors YouTube's YOUTUBE_API_BASE_URL precedent.
const REDDIT_BASE = env.REDDIT_BASE_URL_OVERRIDE ?? "https://www.reddit.com";

// 403-burst detection state. Module-scope (single-process under
// DV-RDT-7 — see header for the WORKER_REPLICA_COUNT guard rationale).
interface BurstState {
  count: number;
  windowStartMs: number;
  auditEmittedThisBurst: boolean;
}
let burstState: BurstState = { count: 0, windowStartMs: 0, auditEmittedThisBurst: false };
const BURST_WINDOW_MS = 5 * 60_000;
const BURST_THRESHOLD = 3;

/**
 * Wraps native fetch with Reddit-specific behavior:
 *   - User-Agent header from credentials.ts
 *   - AdapterError taxonomy on non-2xx
 *   - Optional Zod schema validation on response body
 *
 * `path` may be a relative `/r/...` path (REDDIT_BASE is prepended) or a
 * full https URL (used as-is — useful for redd.it short-links or
 * cross-host calls inside the same domain family).
 */
export async function redditFetch<T = unknown>(
  path: string,
  opts: { schema?: z.ZodTypeAny; method?: "GET" } = {},
): Promise<RedditHttpResult<T>> {
  const creds = pickRedditCredentials();
  if (creds === null) {
    // Safety-net. The usual path is /admin/quota Reddit tab + ingest.ts
    // checking isRedditConfigured() before calling — but if some new
    // caller forgets the check, this throws a clear operator-issue
    // instead of leaking an Authorization-less request.
    throw new AdapterError("reddit_not_configured (REDDIT_USER_AGENT env empty)", {
      category: "operator-issue",
      context: { httpStatus: 0 },
    });
  }

  const url = path.startsWith("http") ? path : REDDIT_BASE + path;
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        "User-Agent": creds.userAgent,
        Accept: "application/json",
      },
    });
  } catch (cause) {
    throw new AdapterError(`Reddit fetch network error: ${String(cause)}`, {
      category: "transient",
      cause,
    });
  }

  const statusCode = res.status;
  const headers = res.headers;

  // 403-burst detection (D-RDT-AUTH-403). Emit `reddit.adapter_degraded`
  // audit row ONCE per burst window; always throw AdapterError(rate-limited).
  if (statusCode === 403) {
    await maybeEmitBurstAuditAndThrow(headers);
    // unreachable — maybeEmitBurstAuditAndThrow always throws.
  }
  if (statusCode === 429) {
    const retryAfterMs = parseRetryAfter(headers);
    throw new AdapterError("Reddit 429 — rate limited", {
      category: "rate-limited",
      retryAfterMs,
      context: { httpStatus: 429 },
    });
  }
  if (statusCode === 404) {
    throw new AdapterError("Reddit resource not found", {
      category: "not-found",
      context: { httpStatus: 404 },
    });
  }
  if (statusCode >= 500) {
    throw new AdapterError(`Reddit ${statusCode}`, {
      category: "transient",
      context: { httpStatus: statusCode },
    });
  }
  if (statusCode < 200 || statusCode >= 300) {
    throw new AdapterError(`Reddit unexpected ${statusCode}`, {
      category: "permanent",
      context: { httpStatus: statusCode },
    });
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (cause) {
    throw new AdapterError("Reddit response not JSON", {
      category: "permanent",
      cause,
      context: { httpStatus: statusCode },
    });
  }

  if (opts.schema) {
    const parsed = opts.schema.safeParse(body);
    if (!parsed.success) {
      throw new AdapterError("Reddit response schema mismatch", {
        category: "permanent",
        cause: parsed.error,
        context: { httpStatus: statusCode },
      });
    }
    return { data: parsed.data as T, statusCode, headers };
  }
  return { data: body as T, statusCode, headers };
}

/**
 * Parse Retry-After (preferred — RFC 7231 seconds form) or
 * X-Ratelimit-Reset (Reddit-specific fallback) into milliseconds.
 *
 * Both headers carry SECONDS in Reddit's responses (Retry-After is
 * sometimes an HTTP-date but Reddit's API uses seconds). Default 60s
 * gives the worker a sane backoff when both headers are absent.
 */
function parseRetryAfter(headers: Headers): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const n = parseInt(retryAfter, 10);
    if (!Number.isNaN(n) && n > 0) return n * 1000;
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset !== null) {
    const n = parseInt(reset, 10);
    if (!Number.isNaN(n) && n > 0) return n * 1000;
  }
  // Default: 60s + 0-5s jitter so a burst of simultaneous 429s does not
  // thundering-herd retry in the same second when the window opens.
  // For the 8-tick worker the fan-out is small, but the jitter also
  // applies to user-driven preview/refresh paths that hit redditFetch
  // directly without queue claim ordering.
  return 60_000 + Math.floor(Math.random() * 5000);
}

/**
 * Burst tracker. Increments count within the rolling 5-min window;
 * resets count on a new window. Emits the audit row exactly ONCE per
 * burst when count crosses BURST_THRESHOLD; always throws
 * AdapterError(rate-limited).
 *
 * Audit emission is best-effort — never throws upward. A failed audit
 * write must not mask the 403; the caller still gets the AdapterError.
 */
async function maybeEmitBurstAuditAndThrow(headers: Headers): Promise<never> {
  const now = Date.now();
  const elapsed = now - burstState.windowStartMs;
  if (elapsed > BURST_WINDOW_MS) {
    // New window starts now. First 403 of the new burst.
    burstState = { count: 1, windowStartMs: now, auditEmittedThisBurst: false };
  } else {
    burstState.count++;
  }
  if (burstState.count >= BURST_THRESHOLD && !burstState.auditEmittedThisBurst) {
    burstState.auditEmittedThisBurst = true;
    try {
      const operatorId = await resolveOperatorUserId();
      if (operatorId === null) {
        // No operator resolvable — log loudly and skip the audit row.
        // The cap state still applies via the AdapterError thrown below.
        logger.warn(
          { burst_count: burstState.count, window_minutes: 5 },
          "reddit.adapter_degraded burst detected but no operator user_id resolvable",
        );
      } else {
        await writeAudit({
          userId: operatorId,
          action: "reddit.adapter_degraded",
          // System-emitted (worker-context). Loopback sentinel matches
          // quota.service_throttled convention.
          ipAddress: "127.0.0.1",
          metadata: {
            burst_count: burstState.count,
            since: new Date(burstState.windowStartMs).toISOString(),
            window_minutes: 5,
          },
        });
      }
    } catch (err) {
      // Best-effort — never mask the 403.
      logger.warn(
        { err: String((err as Error)?.message ?? err) },
        "reddit.adapter_degraded audit emit failed",
      );
    }
  }
  const retryAfterMs = parseRetryAfter(headers);
  throw new AdapterError("Reddit 403 (anti-bot fence?) — adapter may be degraded", {
    category: "rate-limited",
    retryAfterMs,
    context: { httpStatus: 403 },
  });
}

/** Test-only helper — flushes burst state between cases.
 *  Not exported from the package barrel; only the test file imports it. */
export function __resetBurstStateForTest(): void {
  burstState = { count: 0, windowStartMs: 0, auditEmittedThisBurst: false };
  __resetOperatorIdCacheForTest();
}
