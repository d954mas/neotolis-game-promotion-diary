// ScrapeCreators Reddit provider — the ONLY module in the codebase that issues
// ScrapeCreators reddit HTTP (SOC-02 boundary). Gated on the 12-SPIKE GO
// decision: the author path rides `/v1/reddit/search?query=author:<u>&sort=new`
// (D-02, spike-confirmed complete + chronological + cursored), the subreddit path
// rides the native `/v1/reddit/subreddit?subreddit=<slug>&sort=new`.
//
// Nothing above this seam ever touches a ScrapeCreators (snake_case) reddit
// field: the provider issues the request via reddit/server/http.ts (which sets
// the x-api-key header + emits the per-request OBS metric + reserves the credit),
// hands the raw JSON to the pure normalizer, and returns ONLY ProviderPage /
// NormalizedPost / NormalizedSinglePost / ResolvedAccount / RedditFeedPage.
//
// Imports are deliberately narrow: env + http.ts + normalize.ts + url.ts. It must
// NOT import from src/lib/server/services or src/lib/server/http/routes — the
// SOC-02 boundary + review enforce it.
//
// TWO ENDPOINTS, ASYMMETRIC RULES (12-SPIKE.md):
//   author:    GET /v1/reddit/search?query=author:<h>&sort=new&timeframe=all[&after]
//   subreddit: GET /v1/reddit/subreddit?subreddit=<slug>&sort=new[&after]
//              ↑ NO `timeframe` — the subreddit endpoint returns HTTP 400
//                ("You need to sort by 'top' to provide a timeframe") when sort=new
//                is paired with timeframe. The /search endpoint accepts both.

import { env } from "$lib/server/config/env.js";
import { redditFetch } from "../http.js";
import {
  normalizeRedditFeed,
  normalizeSingleRedditPost,
  type RedditFeedPage,
} from "../normalize.js";
import { redditParsePostUrl } from "../url.js";
import type {
  NormalizedSinglePost,
  ProviderOrigin,
  ProviderPage,
  ResolvedAccount,
  SocialPlatform,
  SocialProvider,
} from "$lib/sources/social-provider.js";

const SEARCH_PATH = "/v1/reddit/search";
const SUBREDDIT_PATH = "/v1/reddit/subreddit";

/** Which native feed a Reddit walk targets. `reddit_account` sources use the
 *  author-search path (D-02); `reddit_subreddit` sources use the native subreddit
 *  path — the port's `fetchPosts` can't express this two-mode split, so the
 *  walker (Plan 12-05) calls `fetchRedditFeedPage` directly with the mode. */
export type RedditFeedMode = "author" | "subreddit";

/**
 * Fetch ONE page of a Reddit feed (author-search OR native subreddit) and map it
 * through the pure normalizer to the tree-local RedditFeedPage. This is the real
 * walker entry point (the port `fetchPosts` below is a thin author-default shim).
 *
 * `handle` is the lowercase username (author) or subreddit slug (subreddit).
 * `cursor` is the opaque `after` blob from the previous page (null on first
 * request). `origin` threads the budget pool for the reserve-before-HTTP seam.
 */
export async function fetchRedditFeedPage(
  mode: RedditFeedMode,
  handle: string,
  cursor: string | null,
  opts: { origin?: ProviderOrigin },
): Promise<RedditFeedPage> {
  const url =
    mode === "author"
      ? new URL(`${env.SCRAPECREATORS_BASE_URL}${SEARCH_PATH}`)
      : new URL(`${env.SCRAPECREATORS_BASE_URL}${SUBREDDIT_PATH}`);

  if (mode === "author") {
    url.searchParams.set("query", `author:${handle}`);
    url.searchParams.set("sort", "new");
    // The /search endpoint accepts sort=new + timeframe=all (12-SPIKE.md).
    url.searchParams.set("timeframe", "all");
  } else {
    url.searchParams.set("subreddit", handle);
    url.searchParams.set("sort", "new");
    // NO `timeframe` — the subreddit endpoint 400s on timeframe unless sort=top
    // (12-SPIKE.md). The daily-newest poll uses sort=new with no timeframe.
  }
  if (cursor !== null && cursor !== "") {
    url.searchParams.set("after", cursor);
  }

  const resp = await redditFetch(url, {
    platform: "reddit",
    provider: scrapeCreatorsRedditProvider.name,
    logTag: mode === "author" ? "reddit.search" : "reddit.subreddit",
    origin: opts.origin,
  });
  const json: unknown = await resp.json();
  return normalizeRedditFeed(json);
}

export const scrapeCreatorsRedditProvider: SocialProvider = {
  name: "scrapecreators-reddit",

  async fetchPosts(
    platform: SocialPlatform,
    handle: string,
    cursor: string | null,
    opts: { kindFilter?: "posts" | "reels"; origin?: ProviderOrigin },
  ): Promise<ProviderPage> {
    // Port-shim: the SocialProvider port can't carry the author-vs-subreddit mode
    // (no Reddit-only enum on the shared port — RESEARCH Pattern 1), so the walker
    // calls fetchRedditFeedPage directly. This shim defaults to the D-02 author
    // path so a generic port caller still resolves the primary feed.
    void platform;
    void opts.kindFilter;
    return fetchRedditFeedPage("author", handle, cursor, { origin: opts.origin });
  },

  async resolveAccount(platform: SocialPlatform, handle: string): Promise<ResolvedAccount | null> {
    // Reddit exposes NO user-profile endpoint (12-SPIKE / RESEARCH) — lazy
    // validation (Pattern 2 / RESEARCH option (a)): anchor a minimal
    // ResolvedAccount off the pasted handle with NO extra credit. A typo'd handle
    // simply yields an empty first walk (matches the diary tolerance); the
    // subreddit existence probe (RESEARCH option (b)) is deferred to Plan 12-06.
    void platform;
    const normalized = handle.toLowerCase();
    return {
      accountId: normalized,
      displayName: handle,
      username: normalized,
      fullName: null,
      avatarUrl: null,
      followerCount: null,
    };
  },

  async fetchPostByUrl(
    platform: SocialPlatform,
    url: string,
    opts: { origin?: ProviderOrigin },
  ): Promise<NormalizedSinglePost | null> {
    // Host-check-first parse (T-12-03-T): a non-Reddit URL can never reach the
    // provider. ScrapeCreators exposes no single-post-by-id endpoint (only
    // search + subreddit — RESEARCH endpoint list), so the paste-preview resolves
    // the post from the subreddit feed: fetch the subreddit's newest page and
    // match the post by its t3_ fullname. Recent posts (the common paste case)
    // resolve in 1 credit; a cold post absent from page 1 yields null (the
    // preview falls back to the pasted-URL metadata in Plan 12-06).
    const parsed = redditParsePostUrl(url);
    if (parsed === null) return null;
    const subreddit = (parsed.metadata?.subreddit as string | null | undefined) ?? null;
    if (subreddit === null) return null; // redd.it short-link: sub not in URL (Plan 12-06)

    const page = await fetchRedditFeedPage("subreddit", subreddit, null, { origin: opts.origin });
    void platform;
    const fullname = `t3_${parsed.externalId}`;
    const match = page.posts.find((p) => p.id === fullname);
    if (match === undefined) return null;
    return normalizeSingleRedditPost({
      name: match.id,
      id: parsed.externalId,
      author: match.author,
      author_fullname: match.authorFullname,
      subreddit: match.subredditSlug,
      title: match.title,
      selftext: match.selftext,
      score: match.raw.score,
      upvote_ratio: match.raw.upvoteRatio,
      num_comments: match.raw.numComments,
      created_utc: Math.floor(match.publishedAt.getTime() / 1000),
      permalink: match.permalink,
    });
  },
};
