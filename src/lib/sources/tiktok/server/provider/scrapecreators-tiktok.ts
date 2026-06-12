// ScrapeCreators TikTok provider — the ONLY module in the codebase that issues
// ScrapeCreators TikTok HTTP (SOC-02 boundary).
//
// Nothing above this seam ever touches a ScrapeCreators (snake_case) aweme
// field: the provider issues the request via tiktok/server/http.ts (which sets
// the x-api-key header + emits the per-request OBS metric), hands the raw JSON
// to the pure normalizer, and returns ONLY ProviderPage / NormalizedPost /
// NormalizedSinglePost / ResolvedAccount. Swapping vendors is implementing this
// interface in a sibling file — no consumer changes.
//
// Imports are deliberately narrow: env + http.ts + normalize.ts. It must NOT
// import from src/lib/server/services or src/lib/server/http/routes — review +
// the SOC-02 boundary enforce it.
//
// TikTok is a SINGLE-FEED platform — there is no posts/reels split (unlike IG),
// so the `kindFilter` opt is ignored. shares is REAL (PLAT-02) — the metric IG
// never carried.

import { env } from "$lib/server/config/env.js";
import { tiktokFetch } from "../http.js";
import {
  normalizeProfile,
  normalizeSingleVideoResponse,
  normalizeVideosResponse,
} from "../normalize.js";
import type {
  NormalizedSinglePost,
  ProviderOrigin,
  ProviderPage,
  ResolvedAccount,
  SocialPlatform,
  SocialProvider,
} from "$lib/sources/social-provider.js";

// LIVE-CONFIRMED endpoint shapes (10-SPIKE.md, 2026-06-10):
//   videos:  /v3/tiktok/profile/videos?handle=&sort_by=latest[&max_cursor=]  (1 credit)
//   video:   /v2/tiktok/video?url=<canonical>                                (1 credit)
//   profile: /v1/tiktok/profile?handle=                                      (1 credit)
const VIDEOS_PATH = "/v3/tiktok/profile/videos";
const VIDEO_PATH = "/v2/tiktok/video";
const PROFILE_PATH = "/v1/tiktok/profile";

export const scrapeCreatorsTikTokProvider: SocialProvider = {
  name: "scrapecreators",

  async fetchPosts(
    platform: SocialPlatform,
    handle: string,
    cursor: string | null,
    opts: { kindFilter?: "posts" | "reels"; origin?: ProviderOrigin },
  ): Promise<ProviderPage> {
    // TikTok is single-feed — IGNORE kindFilter (no posts/reels split).
    const url = new URL(`${env.SCRAPECREATORS_BASE_URL}${VIDEOS_PATH}`);
    url.searchParams.set("handle", handle);
    url.searchParams.set("sort_by", "latest");
    if (cursor !== null) {
      // The port cursor is a string; the videos endpoint takes it as max_cursor
      // (it returns max_cursor as a NUMBER — the normalizer coerced it to a
      // string on the way out; the API accepts the string form on the way in).
      url.searchParams.set("max_cursor", cursor);
    }

    const resp = await tiktokFetch(url, {
      platform,
      provider: this.name,
      logTag: "tiktok.videos",
      // Reserve one prepaid credit against the chosen pool BEFORE the request
      // (BUDGET-02). Omitted origin leaves the request unmetered.
      origin: opts.origin,
    });
    const json: unknown = await resp.json();
    return normalizeVideosResponse(json);
  },

  async fetchPostByUrl(
    platform: SocialPlatform,
    url: string,
    opts: { origin?: ProviderOrigin },
  ): Promise<NormalizedSinglePost | null> {
    const reqUrl = new URL(`${env.SCRAPECREATORS_BASE_URL}${VIDEO_PATH}`);
    reqUrl.searchParams.set("url", url);

    const resp = await tiktokFetch(reqUrl, {
      platform,
      provider: this.name,
      logTag: "tiktok.video",
      // Reserve one prepaid credit BEFORE the request (BUDGET-02). The
      // paste-preview is user-initiated → the "user" pool.
      origin: opts.origin,
    });
    const json: unknown = await resp.json();
    return normalizeSingleVideoResponse(json);
  },

  async resolveAccount(platform: SocialPlatform, handle: string): Promise<ResolvedAccount | null> {
    const url = new URL(`${env.SCRAPECREATORS_BASE_URL}${PROFILE_PATH}`);
    url.searchParams.set("handle", handle);

    const resp = await tiktokFetch(url, {
      platform,
      provider: this.name,
      logTag: "tiktok.profile",
      // resolveAccount is the create-time handle→account-id resolution (the ONLY
      // caller is resolveHandleToAccountId from canonicalizeOnCreate). The
      // /v1/tiktok/profile endpoint costs 1 prepaid credit (10-SPIKE), so it MUST
      // reserve against the budget ledger like every other paid request — an
      // unmetered profile call would let a flood of add-source attempts drain the
      // shared prepaid balance below the budget guardrails. The create flow is
      // user-initiated → the "user" pool. A null permit (budget/throttle) throws
      // AdapterError, which canonicalizeOnCreate maps to a clean 429/503 BEFORE the
      // INSERT (no phantom source).
      origin: "user",
    });
    const json: unknown = await resp.json();
    // Missing handle is HTTP 200 + no `user` body — the normalizer maps the
    // absent `user.id` → null (the PRIMARY missing-handle signal for TikTok,
    // 10-SPIKE.md Call 4).
    return normalizeProfile(json);
  },
};
