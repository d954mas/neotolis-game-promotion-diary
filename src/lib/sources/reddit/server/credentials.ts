// Reddit operator credentials — public-`.json` model.
//
// One env var (REDDIT_USER_AGENT) covers every Reddit request. No OAuth,
// no client_id/secret, no bearer cache: Reddit closed self-service OAuth
// registration in late 2025, so we read its public JSON endpoints with a
// distinct, identifying User-Agent and stay inside the unauthenticated
// rate budget (10 req/min, bounded further by the global pacer).
//
// Empty REDDIT_USER_AGENT is the unconfigured state — boot still
// succeeds, downstream callers short-circuit, /admin/quota's Reddit
// tab shows "not configured", smoke validates. This module is the
// ONLY consumer of env.REDDIT_USER_AGENT; cross-source code threads
// the value through redditFetch instead of reading env directly.

import { env } from "$lib/server/config/env.js";
import { AppError } from "$lib/server/services/errors.js";

/** Returns null when Reddit is not configured (REDDIT_USER_AGENT empty).
 *  Returns { userAgent } when configured. A fresh object per call so
 *  callers may mutate without leaking state to others. */
export function pickRedditCredentials(): { userAgent: string } | null {
  const ua = env.REDDIT_USER_AGENT;
  if (ua === "") return null;
  return { userAgent: ua };
}

/** Boolean form. Use for graceful-return callers (preview returns
 *  `unreachable`, syncStats returns null). Throw-path callers prefer
 *  `assertRedditConfigured` for the uniform 503 surface. */
export function isRedditConfigured(): boolean {
  return env.REDDIT_USER_AGENT !== "";
}

/** Throw-path guard. Use at every server boundary that cannot meaningfully
 *  proceed without REDDIT_USER_AGENT — backfill enqueue, refresh-now, paste
 *  normalize, walker reset, /reddit/fetch-metadata route. All sites throw
 *  the same AppError shape; pass call-site identity through `context` so
 *  the error metadata still pinpoints what was attempted. */
export function assertRedditConfigured(context: Record<string, unknown> = {}): void {
  if (env.REDDIT_USER_AGENT !== "") return;
  throw new AppError(
    "Reddit is not configured on this instance (REDDIT_USER_AGENT empty)",
    "reddit_not_configured",
    503,
    context,
  );
}
