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
import { normalizeRedditFeed, type RedditFeedPage } from "../normalize.js";
import { redditParsePostUrl } from "../url.js";
import type { DailyUserRequestAccounting } from "$lib/server/daily-user-quota.js";
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

export type RedditPostFetchOptions =
  | {
      origin?: ProviderOrigin;
      userAccounting?: never;
    }
  | {
      origin: "user";
      userAccounting: DailyUserRequestAccounting;
    };

export type RedditSocialProvider = Omit<SocialProvider, "fetchPostByUrl"> & {
  fetchPostByUrl(
    platform: SocialPlatform,
    url: string,
    opts: RedditPostFetchOptions,
  ): Promise<NormalizedSinglePost | null>;
};

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
  opts: RedditPostFetchOptions,
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
    ...opts,
  });
  const json: unknown = await resp.json();
  return normalizeRedditFeed(json);
}

export const scrapeCreatorsRedditProvider: RedditSocialProvider = {
  // BUDGET KEY, not a registry identity: `name` is the value the HTTP seam
  // (redditFetch) passes to reserveSocialCredits + the OBS metric as `provider`.
  // The prepaid ledger (social_provider_balance / social_provider_spend) + the
  // 80/95 throttle are keyed by PROVIDER, and the ScrapeCreators balance is ONE
  // pool shared across IG + TikTok + Reddit (D-01) — so this MUST be the canonical
  // "scrapecreators" (matching IG/TikTok's provider.name), NOT a reddit-private
  // "scrapecreators-reddit". A distinct key seeds a SECOND full prepaid balance and
  // makes Reddit spend invisible to the shared hard ceiling + the throttle gate the
  // read paths (observability / poll-cron) already query under "scrapecreators".
  // The platform label ("reddit") is what keeps per-platform metric/spend
  // attribution distinct; the registry resolves providers by PLATFORM, never name.
  name: "scrapecreators",

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
    opts: RedditPostFetchOptions,
  ): Promise<NormalizedSinglePost | null> {
    // Host-check-first parse (T-12-03-T): a non-Reddit URL can never reach the
    // provider. ScrapeCreators exposes no single-post-by-id endpoint (only
    // search + subreddit — RESEARCH endpoint list), so the paste-preview resolves
    // the post from the subreddit feed: fetch the subreddit's newest page and
    // match the post by its t3_ fullname. Recent posts (the common paste case)
    // resolve in 1 credit; a cold post absent from page 1 yields null (the
    // preview falls back to the pasted-URL metadata in Plan 12-06).
    //
    // The slug the parser hands over is the FEED identity, which for a
    // `/user/<name>/comments/<id>` profile post is Reddit's pseudo-subreddit
    // `u_<name>` (url.ts PROFILE_SUB_PREFIX) — passing the bare `<name>` here asked
    // for the unrelated r/<name> community and never matched the post.
    const parsed = redditParsePostUrl(url);
    if (parsed === null) return null;
    const subreddit = (parsed.metadata?.subreddit as string | null | undefined) ?? null;
    // redd.it short-link: no subreddit in the URL ⇒ no feed to search. The paste
    // preview rejects this BEFORE the cap gate with an explicit
    // `reddit_short_link_unsupported` cause (index.ts); this stays as the seam-level
    // belt for any other caller (e.g. a cached permalink that is somehow a short link).
    if (subreddit === null) return null;

    const page = await fetchRedditFeedPage("subreddit", subreddit, null, opts);
    void platform;
    const fullname = `t3_${parsed.externalId}`;
    const match = page.posts.find((p) => p.id === fullname);
    if (match === undefined) return null;
    // `match` is ALREADY a fully-normalized post — project it straight to the single-post
    // shape. Do NOT re-normalize a stripped synthetic object: that dropped url/is_video/
    // post_hint/thumbnail, so the preview kind always collapsed to text/link and image
    // posts lost their thumbnail. The derived kind + thumbnail carry through here.
    return {
      id: match.id,
      shortcode: parsed.externalId,
      kind: match.kind,
      publishedAt: match.publishedAt,
      metrics: match.metrics,
      caption: match.caption,
      thumbnailUrl: match.thumbnailUrl,
      ownerId: match.authorFullname,
      ownerUsername: match.author,
      // Carry the richer Reddit FORM so the paste-preview snapshot persists the real
      // media_type (image/gallery cards render correctly before the source walk).
      mediaType: match.mediaType,
    };
  },
};
