// Reddit HTTP wrapper — public-`.json` adapter.
//
// Responsibilities:
//   - Add `User-Agent: env.REDDIT_USER_AGENT` to every outgoing fetch
//     (Reddit aggressively rate-limits the default Node UA).
//   - Acquire a slot from the global pacer before firing the request.
//   - Map response codes to AdapterError 5-category taxonomy
//     (transient | rate-limited | not-found | permanent | operator-issue).
//   - Detect 403-burst (3 × 403 within a 5-min rolling window) and emit
//     ONE `reddit.adapter_degraded` audit row per burst window — not
//     per failed request.
//   - Parse `Retry-After` (preferred) or `X-Ratelimit-Reset` for
//     retryAfterMs.
//
// Not here:
//   - Rate-limit budget enforcement — owned by the global pacer
//     (pacer.ts) and the 8-tick worker (worker-tick.ts).
//   - Bearer/OAuth refresh — no OAuth in this adapter (single UA env var).
//   - Retry loops — callers decide retry policy from the AdapterError
//     category + retryAfterMs.
//
// Module-scope burst state is in-process. Under multi-replica deploys
// each replica counts independently — a real 403 burst that trips on
// K replicas writes K `reddit.adapter_degraded` audit rows instead of
// one. Conscious trade-off:
//   - Load-bearing concerns (rate-limit, per-user cap, adapter pause)
//     all live in DB rows — multi-replica safe by construction.
//   - This counter only coalesces a forensic audit signal; dup rows on
//     a catastrophic path (Reddit fenced us out) are an acceptable cost
//     vs the cleaner-but-heavier alternatives below.
// Fix paths if dup rows ever become annoying:
//   (a) Set requiresSingletonRuntime=true on the adapter — 1-line change;
//       Reddit-loop runs on one replica only. YouTube still parallel.
//   (b) Move counter into reddit_pacer (new columns + SQL writer) — keeps
//       Reddit-loop on every replica.
// A worker restart loses the in-memory counter — worst case one extra
// audit row when the next burst trips, which is safer than over-
// suppressing.
//
// Audit user-id: `audit_log.user_id` is NOT NULL by schema, so we
// resolve operator user-id via ADMIN_EMAIL_ALLOWLIST[0] (same pattern
// YouTube uses). When no operator is resolvable we log at WARN and
// skip the audit row; the AdapterError still propagates, so the caller
// always sees the rate-limit signal.

import type { z } from "zod";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { AdapterError } from "$lib/sources/errors.js";
import { pickRedditCredentials } from "./credentials.js";
import { writeAudit } from "$lib/server/audit.js";
import { logger } from "$lib/server/logger.js";
import { env } from "$lib/server/config/env.js";
import { resolveOperatorUserId, __resetOperatorIdCacheForTest } from "./operator-resolver.js";
import { acquireRedditPacerSlot, recordRedditAdapterPause } from "./pacer.js";

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

// 403-burst detection state. Module-scope is conscious — see the
// "multi-replica trade-off" section in the file header. The load-bearing
// rate-limit gate lives in pacer.ts (DB row, atomic). This counter just
// coalesces the forensic `reddit.adapter_degraded` audit signal.
interface BurstState {
  count: number;
  windowStartMs: number;
  auditEmittedThisBurst: boolean;
}
let burstState: BurstState = { count: 0, windowStartMs: 0, auditEmittedThisBurst: false };
const BURST_WINDOW_MS = 5 * 60_000;
const BURST_THRESHOLD = 3;

// Outbound HTTP proxy for Reddit. Lazily constructed on first use so the
// undici ProxyAgent's connection pool is created once and reused across
// every redditFetch (keep-alive is what makes residential-proxy latency
// tolerable — TCP+TLS handshake per call would dominate).
// Empty/unset env var → null → direct fetch (self-host parity).
let cachedProxyAgent: ProxyAgent | null = null;
function getProxyDispatcher(): ProxyAgent | null {
  if (!env.REDDIT_PROXY_URL) return null;
  if (cachedProxyAgent === null) {
    cachedProxyAgent = new ProxyAgent(env.REDDIT_PROXY_URL);
    logger.info(
      { proxyHost: new URL(env.REDDIT_PROXY_URL).host },
      "reddit outbound proxy configured",
    );
  }
  return cachedProxyAgent;
}

/** Test-only helper — drop the cached ProxyAgent so tests can swap
 *  REDDIT_PROXY_URL via vi.stubEnv and pick up the new value. */
export function __resetProxyAgentForTest(): void {
  cachedProxyAgent = null;
}

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
  opts: { schema?: z.ZodTypeAny; method?: "GET"; pacer?: "acquire" | "already-acquired" } = {},
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

  // Global pacer — every redditFetch goes through one DB-side token so
  // the 10 req/min Reddit ceiling is enforced across worker + sync
  // user paths uniformly. Denial surfaces as rate-limited; caller
  // (worker re-queues with backoff via next_attempt_at, sync paths
  // return 429 to the UI).
  if (opts.pacer !== "already-acquired") {
    const slot = await acquireRedditPacerSlot();
    if (!slot.acquired) {
      throw new AdapterError(`Reddit pacer denied -- ${slot.waitMs}ms until next slot`, {
        category: "rate-limited",
        retryAfterMs: slot.waitMs,
        context: {
          httpStatus: 0,
          source: slot.paused ? "adapter-pause" : "global-pacer",
          pauseReason: slot.pauseReason,
          pausedUntil: slot.pausedUntil?.toISOString() ?? null,
        },
      });
    }
  }

  const url = path.startsWith("http") ? path : REDDIT_BASE + path;
  const dispatcher = getProxyDispatcher();
  let res: Response;
  try {
    if (dispatcher !== null) {
      // Proxy path. undiciFetch is API-compatible with global fetch but
      // accepts the `dispatcher` option that routes through ProxyAgent.
      res = (await undiciFetch(url, {
        method: opts.method ?? "GET",
        headers: {
          "User-Agent": creds.userAgent,
          Accept: "application/json",
        },
        dispatcher,
      })) as unknown as Response;
    } else {
      // No proxy → use global fetch so tests can mock via vi.stubGlobal.
      // Behaviour identical (Node 18+ global fetch is undici under the
      // hood); only the test surface differs.
      res = await fetch(url, {
        method: opts.method ?? "GET",
        headers: {
          "User-Agent": creds.userAgent,
          Accept: "application/json",
        },
      });
    }
  } catch (cause) {
    throw new AdapterError(`Reddit fetch network error: ${String(cause)}`, {
      category: "transient",
      cause,
    });
  }

  const statusCode = res.status;
  const headers = res.headers;

  // 403-burst detection — Reddit's anti-bot fence. Emit
  // `reddit.adapter_degraded` audit ONCE per burst window; always throw
  // AdapterError(rate-limited).
  if (statusCode === 403) {
    await maybeEmitBurstAuditAndThrow(headers);
    // unreachable — maybeEmitBurstAuditAndThrow always throws.
  }
  if (statusCode === 429) {
    const retryAfterMs = parseRetryAfter(headers);
    await recordRedditAdapterPause("http_429", retryAfterMs);
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
/** Jitter window applied to EVERY retry value — header-supplied or
 *  default. N concurrent clients (preview button + paste submit + sub_poll
 *  cron) seeing the same Retry-After otherwise retry in the same second.
 *  5s smear is small enough not to violate the server's hint, large
 *  enough to spread thundering-herd hits across multiple ticks of the
 *  8-tick worker (7.5s tick interval). */
const RETRY_JITTER_MS = 5_000;

function jitteredRetryMs(base: number): number {
  return base + Math.floor(Math.random() * RETRY_JITTER_MS);
}

function parseRetryAfter(headers: Headers): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const n = parseInt(retryAfter, 10);
    if (!Number.isNaN(n) && n > 0) return jitteredRetryMs(n * 1000);
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset !== null) {
    const n = parseInt(reset, 10);
    if (!Number.isNaN(n) && n > 0) return jitteredRetryMs(n * 1000);
  }
  // No header — default to 60s + jitter.
  return jitteredRetryMs(60_000);
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
  await recordRedditAdapterPause("http_403", retryAfterMs);
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
