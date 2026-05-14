// Reddit operator credentials — DV-RDT-7 public-`.json` model.
//
// Single env var (REDDIT_USER_AGENT) covers all Reddit requests. No OAuth,
// no client_id/secret, no bearer cache (Reddit closed self-service OAuth
// registration Nov 2025; see .planning/phases/03.1-reddit-adapter/03.1-CONTEXT.md
// D-RDT-AUTH-MODEL / D-RDT-AUTH-ENV / D-RDT-AUTH-EMPTY for the policy context).
//
// pickRedditCredentials returns null when env.REDDIT_USER_AGENT === "" —
// self-host parity preserved (boot succeeds with empty env; downstream
// code short-circuits, /admin/quota Reddit tab shows "not configured",
// smoke gate validates).
//
// This module is the ONLY consumer of env.REDDIT_USER_AGENT across the
// codebase (cross-source code never reads env directly; the adapter's
// http wrapper threads userAgent through). Mirrors the YouTube pattern
// in $lib/sources/youtube/server/credentials.ts where pickCredentials is
// the single contract surface for credential selection.

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

/** Boolean form. Used by observability.auth.isOperatorConfigured (plan 07
 *  redditAdapter barrel) and by services/ingest.ts (plan 09 paste flow)
 *  to throw `reddit_not_configured` 422 instead of attempting a request. */
export function isRedditConfigured(): boolean {
  return env.REDDIT_USER_AGENT !== "";
}
