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

/** Returns null when Reddit is not configured (REDDIT_USER_AGENT empty).
 *  Returns { userAgent } when configured. Caller adds `User-Agent: userAgent`
 *  header on every Reddit HTTP request. A fresh object is returned per
 *  call so callers may add/mutate fields without leaking state to others. */
export function pickRedditCredentials(): { userAgent: string } | null {
  const ua = env.REDDIT_USER_AGENT;
  if (ua === "") return null;
  return { userAgent: ua };
}

/** Boolean form. Used by observability.auth.isOperatorConfigured and by
 *  the paste-flow + preview-flow guards to throw `reddit_not_configured`
 *  before attempting any HTTP. */
export function isRedditConfigured(): boolean {
  return env.REDDIT_USER_AGENT !== "";
}
