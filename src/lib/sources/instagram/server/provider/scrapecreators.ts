// ScrapeCreators provider — the ONLY module in the codebase that issues
// ScrapeCreators HTTP (SOC-02 boundary).
//
// Nothing above this seam ever touches a ScrapeCreators field name: the
// provider issues the request via instagram/server/http.ts (which sets the
// x-api-key header + emits the per-request OBS metric), hands the raw JSON to
// the pure normalizer, and returns ONLY ProviderPage / NormalizedPost. Swapping
// vendors (EnsembleData / SocialData / a self-adapter) is implementing this
// interface in a sibling file — no consumer changes.
//
// Imports are deliberately narrow: env + http.ts + normalize.ts. It must NOT
// import from src/lib/server/services or src/lib/server/http/routes — review +
// the SOC-02 boundary enforce it. The actual `x-api-key` request header is set
// inside http.ts instagramFetch (header concerns belong in the HTTP wrapper,
// mirroring youtube/server/http.ts); this provider only chooses endpoints +
// cursors and never re-issues raw fetch.

import { env } from "$lib/server/config/env.js";
import { instagramFetch } from "../http.js";
import {
  normalizePostsResponse,
  normalizeReelsResponse,
  normalizeSinglePostResponse,
} from "../normalize.js";
import type {
  NormalizedSinglePost,
  ProviderOrigin,
  ProviderPage,
  SocialPlatform,
  SocialProvider,
} from "$lib/sources/social-provider.js";

// LIVE-CONFIRMED endpoint shapes (08-SPIKE.md):
//   posts: /v2/instagram/user/posts?handle=&next_max_id=  (cursor top-level)
//   reels: /v1/instagram/user/reels?handle=&max_id=        (cursor nested)
//   profile: /v1/instagram/profile?handle=                 (resolveAccount)
//   post:   /v1/instagram/post?url=<permalink>             (single-post preview)
//   balance: /v1/account/credit-balance                    (D-23 additive)
const POSTS_PATH = "/v2/instagram/user/posts";
const REELS_PATH = "/v1/instagram/user/reels";
const PROFILE_PATH = "/v1/instagram/profile";
const POST_PATH = "/v1/instagram/post";
const CREDIT_BALANCE_PATH = "/v1/account/credit-balance";

// A `/reel/` permalink is the ONLY short-vs-video discriminator on the
// single-post API (it exposes no product_type — 08-issue-65). Detected on the
// raw pasted URL so the normalizer can map XDTGraphVideo → "short" vs "video".
const REEL_PERMALINK_RE = /\/reels?\//i;

// resolveAccount profile response — kept narrow + tolerant; only the user-id +
// display-name fields are load-bearing. LIVE-CONFIRMED shape (real key, `nasa`,
// 2026-06-06): the user object is nested at `data.user`, NOT at `data` — e.g.
// `{ data: { user: { id, username, full_name, ... } } }`. We read `data.user`
// first and keep a top-level `user` as a defensive fallback. An empty/missing
// body or absent user → null (the caller reads that as missing/private —
// Pitfall 4 belt-and-suspenders alongside the HTTP-404 mapping in http.ts).
interface ProfileBody {
  data?: { user?: ProfileUser | null } | null;
  user?: ProfileUser | null;
}
interface ProfileUser {
  id?: string | null;
  pk?: string | null;
  user_id?: string | null;
  full_name?: string | null;
  username?: string | null;
}

interface CreditBalanceBody {
  credits_remaining?: number | null;
  credits?: number | null;
}

export const scrapeCreatorsProvider: SocialProvider = {
  name: "scrapecreators",

  async fetchPosts(
    platform: SocialPlatform,
    handle: string,
    cursor: string | null,
    opts: { kindFilter?: "posts" | "reels"; origin?: ProviderOrigin },
  ): Promise<ProviderPage> {
    const wantReels = opts.kindFilter === "reels";
    const url = new URL(`${env.SCRAPECREATORS_BASE_URL}${wantReels ? REELS_PATH : POSTS_PATH}`);
    url.searchParams.set("handle", handle);
    if (cursor !== null) {
      // Posts paginate on next_max_id; reels on max_id — the divergence is in
      // the QUERY name here and in the cursor FIELD name inside the normalizer.
      url.searchParams.set(wantReels ? "max_id" : "next_max_id", cursor);
    }

    const resp = await instagramFetch(url, {
      platform,
      provider: this.name,
      logTag: wantReels ? "ig.reels" : "ig.posts",
      // Reserve one prepaid credit against the chosen pool BEFORE the request
      // (BUDGET-02). Omitted origin (older callers) leaves the request unmetered.
      origin: opts.origin,
    });
    const json: unknown = await resp.json();
    return wantReels ? normalizeReelsResponse(json) : normalizePostsResponse(json);
  },

  async fetchPostByUrl(
    platform: SocialPlatform,
    url: string,
    opts: { origin?: ProviderOrigin },
  ): Promise<NormalizedSinglePost | null> {
    const reqUrl = new URL(`${env.SCRAPECREATORS_BASE_URL}${POST_PATH}`);
    reqUrl.searchParams.set("url", url);

    const resp = await instagramFetch(reqUrl, {
      platform,
      provider: this.name,
      logTag: "ig.post",
      // Reserve one prepaid credit BEFORE the request (BUDGET-02). The
      // paste-preview is user-initiated → the "user" pool.
      origin: opts.origin,
    });
    const json: unknown = await resp.json();
    return normalizeSinglePostResponse(json, REEL_PERMALINK_RE.test(url));
  },

  async resolveAccount(
    platform: SocialPlatform,
    handle: string,
  ): Promise<{ accountId: string; displayName: string | null } | null> {
    const url = new URL(`${env.SCRAPECREATORS_BASE_URL}${PROFILE_PATH}`);
    url.searchParams.set("handle", handle);

    const resp = await instagramFetch(url, {
      platform,
      provider: this.name,
      logTag: "ig.profile",
    });
    const body = (await resp.json()) as ProfileBody;
    const user = body.data?.user ?? body.user ?? null;
    if (user === null) return null;

    const accountId = user.id ?? user.pk ?? user.user_id ?? null;
    if (accountId === null || accountId === "") return null;

    return {
      accountId,
      displayName: user.full_name ?? user.username ?? null,
    };
  },

  async getCreditBalance(): Promise<number | null> {
    // D-23 additive-only: NEVER depended on. Any failure → null, never throws.
    try {
      const url = new URL(`${env.SCRAPECREATORS_BASE_URL}${CREDIT_BALANCE_PATH}`);
      const resp = await instagramFetch(url, {
        platform: "instagram",
        provider: this.name,
        logTag: "ig.credit_balance",
      });
      const body = (await resp.json()) as CreditBalanceBody;
      return body.credits_remaining ?? body.credits ?? null;
    } catch {
      return null;
    }
  },
};
