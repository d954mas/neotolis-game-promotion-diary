// twitterapi.io Twitter/X provider — the ONLY module in the codebase that issues
// twitterapi.io HTTP (SOC-02 boundary).
//
// Nothing above this seam ever touches a twitterapi.io field name (data.tweets,
// extendedEntities.media, has_next_page, etc.): the provider issues the request via
// twitter/server/http.ts (which sets the X-API-Key header + emits the per-request OBS
// metric + reserves the prepaid credit), hands the raw JSON to the pure normalizer,
// and returns ONLY ProviderPage / NormalizedPost / NormalizedSinglePost /
// ResolvedAccount. Swapping vendors is implementing this interface in a sibling file —
// no consumer changes.
//
// Imports are deliberately narrow: env + http.ts + normalize.ts + url.ts. It must NOT
// import from src/lib/server/services or src/lib/server/http/routes — review + the
// SOC-02 boundary enforce it.
//
// Twitter is a SINGLE-FEED platform — there is no posts/reels split (unlike IG), so
// the `kindFilter` opt is ignored. shares is the DERIVED retweet+quote sum (D-05),
// computed in the normalizer.
//
// QPS (the operator's per-account rate-limit requirement): the seam (http.ts)
// classifies a twitterapi.io 429 → AdapterError(rate-limited) with the honored
// Retry-After so the walker backs off; the >=5s inter-request PACING that keeps the
// 429 from being provoked at all (never-paid accounts cap at 0.2 QPS) lives in Plan
// 03's walker lane (the shared pacer), reading TWITTERAPIIO_MIN_REQUEST_INTERVAL_MS
// from http.ts. This provider stays a thin issuer — it does NOT loop/sleep.

import { twitterFetch } from "../http.js";
import {
  normalizeFeedResponse,
  normalizeFeedResponseWithRaw,
  normalizeProfile,
  normalizeSingleTweetResponse,
  type TwitterFeedPage,
} from "../normalize.js";
import { twitterParseUrl } from "../url.js";
import type {
  NormalizedSinglePost,
  ProviderOrigin,
  ProviderPage,
  ResolvedAccount,
  SocialPlatform,
  SocialProvider,
} from "$lib/sources/social-provider.js";
import { TWITTERAPIIO_BASE_URL } from "../http.js";

// LIVE-CONFIRMED endpoint shapes (11-SPIKE.md, 2026-06-12):
//   feed:    /twitter/user/last_tweets?userName=&includeReplies=true[&cursor=]  (1 credit/page)
//   tweets:  /twitter/tweets?tweet_ids=<comma-sep>                              (1 credit)
//   profile: /twitter/user/info?userName=                                       (1 credit)
const FEED_PATH = "/twitter/user/last_tweets";
const TWEETS_PATH = "/twitter/tweets";
const PROFILE_PATH = "/twitter/user/info";

export const twitterapiioTwitterProvider: SocialProvider = {
  name: "twitterapi.io",

  async fetchPosts(
    platform: SocialPlatform,
    handle: string,
    cursor: string | null,
    opts: { kindFilter?: "posts" | "reels"; origin?: ProviderOrigin },
  ): Promise<ProviderPage> {
    // The page-level normalizer maps data.tweets[] → ProviderPage WITHOUT the D-04
    // filter (it has no account-id scope); the walker applies keepForAccount(t,
    // accountId) using the feed owner's id (Plan 03) via fetchTwitterFeedPageWithRaw.
    const json = await fetchFeedJson(platform, this.name, handle, cursor, opts.origin);
    return normalizeFeedResponse(json);
  },

  async fetchPostByUrl(
    platform: SocialPlatform,
    url: string,
    opts: { origin?: ProviderOrigin },
  ): Promise<NormalizedSinglePost | null> {
    // Extract the URL-intrinsic numeric status id (the /tweets endpoint keys on the id,
    // not the permalink). A non-status URL → null (no preview).
    const parsed = twitterParseUrl(url);
    if (parsed === null) return null;

    const reqUrl = new URL(`${TWITTERAPIIO_BASE_URL}${TWEETS_PATH}`);
    reqUrl.searchParams.set("tweet_ids", parsed.externalId);

    const resp = await twitterFetch(reqUrl, {
      platform,
      provider: this.name,
      logTag: "twitter.tweets",
      // Reserve one prepaid credit BEFORE the request (BUDGET-02). The paste-preview is
      // user-initiated → the "user" pool.
      origin: opts.origin,
    });
    const json: unknown = await resp.json();
    // Single-tweet endpoint nests at TOP-LEVEL tweets[] (NOT data.tweets — 11-SPIKE.md
    // Call B). Empty array → null.
    return normalizeSingleTweetResponse(json);
  },

  async resolveAccount(platform: SocialPlatform, handle: string): Promise<ResolvedAccount | null> {
    const url = new URL(`${TWITTERAPIIO_BASE_URL}${PROFILE_PATH}`);
    url.searchParams.set("userName", handle);

    const resp = await twitterFetch(url, {
      platform,
      provider: this.name,
      logTag: "twitter.user_info",
      // resolveAccount is the create-time handle→account-id resolution. The
      // /twitter/user/info endpoint costs 1 prepaid credit (11-SPIKE.md Q5), so it MUST
      // reserve against the budget ledger like every other paid request — an unmetered
      // profile call would let a flood of add-source attempts drain the shared prepaid
      // balance below the budget guardrails. The create flow is user-initiated → the
      // "user" pool. A null permit (budget/throttle) throws AdapterError, which
      // canonicalizeOnCreate maps to a clean 429/503 BEFORE the INSERT (no phantom source).
      origin: "user",
    });
    const json: unknown = await resp.json();
    // Missing/suspended handle is HTTP 200 + `data: null` — the normalizer maps the
    // absent `data.id` → null (the PRIMARY missing-handle signal, 11-SPIKE.md Q3).
    return normalizeProfile(json);
  },
};

/** Issue one /twitter/user/last_tweets request via the seam and return the raw JSON.
 *  Shared by the port `fetchPosts` (which normalizes to ProviderPage) and the
 *  tree-local `fetchTwitterFeedPageWithRaw` (which also surfaces the raw tweets for
 *  the walker's D-04 filter + D-05 raw components). */
async function fetchFeedJson(
  platform: SocialPlatform,
  providerName: string,
  handle: string,
  cursor: string | null,
  origin: ProviderOrigin | undefined,
): Promise<unknown> {
  // Twitter is single-feed — no posts/reels split.
  const url = new URL(`${TWITTERAPIIO_BASE_URL}${FEED_PATH}`);
  url.searchParams.set("userName", handle);
  // D-04 / Pitfall 5: surface self-reply threads so the walker's keepForAccount
  // filter can import whole promo threads (it drops replies-to-others client-side).
  url.searchParams.set("includeReplies", "true");
  // twitterapi.io's first-page cursor is the empty string; only thread a non-empty
  // cursor for page 2+ (11-SPIKE.md Q2).
  if (cursor !== null && cursor !== "") {
    url.searchParams.set("cursor", cursor);
  }
  const resp = await twitterFetch(url, {
    platform,
    provider: providerName,
    logTag: "twitter.last_tweets",
    // Reserve one prepaid credit against the chosen pool BEFORE the request
    // (BUDGET-02). Omitted origin leaves the request unmetered.
    origin,
  });
  return resp.json();
}

/**
 * Tree-local feed fetch used by the WALKER (handlers/backfill-account.ts) — returns
 * the cross-source ProviderPage PLUS the index-aligned RAW tweets. The walker needs
 * the raw tweets because the D-04 keepForAccount filter reads flags
 * (retweeted_tweet / isReply / inReplyToUserId) that are NOT on the port
 * NormalizedPost, and the D-05 snapshot stores the raw retweet/quote/bookmark
 * components. The NEUTRAL port method `fetchPosts` (above) keeps returning only the
 * vendor-agnostic ProviderPage — this richer result is Twitter-tree-local, so the
 * port stays clean.
 *
 * Same single twitterapi.io request as `fetchPosts` (1 credit reserved in the seam);
 * the only difference is the response is normalized to ALSO carry the raw tweets.
 */
export async function fetchTwitterFeedPageWithRaw(
  handle: string,
  cursor: string | null,
  origin: ProviderOrigin | undefined,
): Promise<TwitterFeedPage> {
  const json = await fetchFeedJson("twitter", twitterapiioTwitterProvider.name, handle, cursor, origin);
  return normalizeFeedResponseWithRaw(json);
}
