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
  normalizeRedditPostDetail,
  type RedditFeedPage,
} from "../normalize.js";
import { redditParsePostUrl, redditParseShareUrl, redditBuildPermalink } from "../url.js";
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
// Single-post detail (12-06 UAT discovery — post-dates the 12-01 spike, whose
// endpoint list had no by-URL lookup): takes the FULL post URL, 1 credit, and
// returns the complete post object whose `url` is the TRUE media/destination
// url — the reliable resolver the page-1 feed lookup never was.
const POST_COMMENTS_PATH = "/v1/reddit/post/comments";

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

/** NormalizedSinglePost + two Reddit-only fields the by-URL path must carry:
 *
 *  `permalink` — the RESOLVED canonical permalink: the provider's own (detail
 *  response) when present, else REBUILT from the resolved subreddit / id / title.
 *  The /s/ share-link preview adopts it as the event URL (the pasted share URL
 *  carries no post id).
 *
 *  `subredditSlug` — the community identity as the RESPONSE reports it, which for a
 *  profile post is the `u_<name>` pseudo-subreddit. The preview persists it so a
 *  pasted post's cache row carries the same identity a walk would write (the feed
 *  card reads the community line from this column; a `redd.it` / bare
 *  `/comments/<id>` paste has no slug anywhere in its URL to fall back on). */
export type RedditSinglePost = NormalizedSinglePost & {
  permalink: string | null;
  subredditSlug: string | null;
};

export type RedditSocialProvider = Omit<SocialProvider, "fetchPostByUrl"> & {
  fetchPostByUrl(
    platform: SocialPlatform,
    url: string,
    opts: RedditPostFetchOptions,
  ): Promise<RedditSinglePost | null>;
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
  ): Promise<RedditSinglePost | null> {
    // Host-check-first parse (T-12-03-T): a non-Reddit URL can never reach the
    // provider. Resolution rides the /post/comments DETAIL endpoint (12-06 UAT
    // discovery): 1 credit for the exact post by its full URL — replacing the
    // old subreddit-page-1 lookup whose bounded miss made Refresh-Now / the
    // paste preview inconclusive for anything that scrolled off the feed. A null
    // here now means the post itself is gone/unresolvable, not "not on page 1".
    const parsed = redditParsePostUrl(url);
    // /s/ SHARE link: the path carries an opaque redirect token instead of the
    // post id — still a Reddit-host URL, and the detail endpoint follows the
    // redirect server-side (12-06 UAT probe: /r/itchio/s/… resolved fully).
    const share = parsed === null ? redditParseShareUrl(url) : null;
    if (parsed === null && share === null) return null;
    if (parsed !== null) {
      // redd.it short-link belt: recognition-only (the preview rejects it BEFORE
      // the cap gate with reddit_short_link_unsupported — index.ts). Kept until
      // the detail endpoint's short-link behavior is live-verified.
      const subreddit = (parsed.metadata?.subreddit as string | null | undefined) ?? null;
      if (subreddit === null) return null;
    }

    const detailUrl = new URL(`${env.SCRAPECREATORS_BASE_URL}${POST_COMMENTS_PATH}`);
    detailUrl.searchParams.set("url", url);
    detailUrl.searchParams.set("trim", "true");
    const resp = await redditFetch(detailUrl, {
      platform: "reddit",
      provider: scrapeCreatorsRedditProvider.name,
      logTag: "reddit.post_detail",
      ...opts,
    });
    const json: unknown = await resp.json();
    const post = normalizeRedditPostDetail(json);
    void platform;
    if (post === null) return null;
    // `post` is ALREADY fully normalized — project it straight to the single-post
    // shape so the derived kind / thumbnail / form / domain carry through.
    return {
      id: post.id,
      // A share paste has no URL-intrinsic short id — derive it from the resolved
      // t3 fullname (identity-belt-verified: name === `t3_${id}` in normalize).
      shortcode: parsed?.externalId ?? post.id.replace(/^t3_/, ""),
      kind: post.kind,
      publishedAt: post.publishedAt,
      metrics: post.metrics,
      caption: post.caption,
      thumbnailUrl: post.thumbnailUrl,
      ownerId: post.authorFullname,
      ownerUsername: post.author,
      ownerDeleted: post.raw.authorDeleted === true,
      // Carry the richer Reddit FORM so the snapshot persists the real media_type
      // (image/gallery cards render correctly before/without a source walk).
      mediaType: post.mediaType,
      // Same rationale for the link card: persist the outbound domain.
      linkDomain: post.linkDomain,
      subredditSlug: post.subredditSlug,
      // The resolved canonical permalink. The trim=true detail response carries no
      // `permalink` field (12-06 UAT probe), so the rebuild from resolved parts is
      // the live path; pickPermalink stays the preferred source as forward-compat.
      permalink:
        post.permalink ??
        (post.subredditSlug !== null
          ? redditBuildPermalink(post.subredditSlug, post.id.replace(/^t3_/, ""), post.title)
          : null),
    };
  },
};
