// Twitter/X tweet -> NormalizedPost / single-tweet -> NormalizedSinglePost normalizer,
// with the DERIVED shares metric threaded (D-05 = retweetCount + quoteCount), raw
// component retention, the D-04 timeline filter, media_type discrimination, and the
// provider's endpoint/cursor/credit mapping. Pure unit test — no DB, no live HTTP (the
// provider's HTTP boundary is mocked).
//
// Fixtures mirror the LIVE-CONFIRMED twitterapi.io shapes from 11-SPIKE.md (run against
// `ConcernedApe` / `supergiantgames` / `PlayStation`, 2026-06-12): feed tweets nest at
// `data.tweets[]`, single-tweet at TOP-LEVEL `tweets[]`, profile under `data`, media at
// `extendedEntities.media[0].media_url_https`, has_next_page a clean BOOLEAN, next_cursor
// a string ("" on page 1), createdAt a string date, derived shares = retweet+quote.
//
// Requirements: PLAT-03 (D-04 filter, D-05 derived shares + raw-component retention), SOC-02/03/04.
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  deriveShares,
  keepForAccount,
  normalizeTweet,
  normalizeFeedResponse,
  normalizeProfile,
  normalizeSingleTweet,
  normalizeSingleTweetResponse,
  tweetRawComponents,
  type Tweet,
} from "$lib/sources/twitter/server/normalize.js";

const ACCOUNT_ID = "115216851"; // supergiantgames numeric user id (11-SPIKE.md)

// A native-video tweet with all metrics + an author + a video media object.
const VIDEO_TWEET: Tweet = {
  id: "1799999999999999999",
  url: "https://x.com/supergiantgames/status/1799999999999999999",
  text: "Hades II — Technical Test out now!\nA second line here",
  createdAt: "Wed Jun 11 18:00:00 +0000 2026",
  likeCount: 12000,
  retweetCount: 1500,
  replyCount: 340,
  quoteCount: 200,
  viewCount: 980000,
  bookmarkCount: 88,
  isReply: false,
  inReplyToId: null,
  inReplyToUserId: null,
  inReplyToUsername: null,
  retweeted_tweet: null,
  quoted_tweet: null,
  extendedEntities: {
    media: [
      {
        type: "video",
        media_url_https: "https://pbs.twimg.com/amplify_video_thumb/abc/img/poster.jpg",
        video_info: { variants: [{ url: "https://video.twimg.com/v.mp4" }] },
      },
    ],
  },
  author: {
    id: ACCOUNT_ID,
    userName: "supergiantgames",
    name: "Supergiant Games",
    profilePicture: "https://pbs.twimg.com/profile_images/avatar.jpg",
    followers: 500000,
  },
};

// A text-only tweet (extendedEntities {} with no media) — thumbnail null, kind "other".
const TEXT_TWEET: Tweet = {
  id: "1800000000000000000",
  url: "https://x.com/supergiantgames/status/1800000000000000000",
  text: "We are hiring!",
  createdAt: "Thu Jun 12 09:00:00 +0000 2026",
  likeCount: 800,
  // retweetCount + quoteCount BOTH absent → shares null-by-presence.
  replyCount: 20,
  viewCount: 40000,
  isReply: false,
  retweeted_tweet: null,
  quoted_tweet: null,
  extendedEntities: {},
  author: { id: ACCOUNT_ID, userName: "supergiantgames" },
};

describe("twitter normalizer", () => {
  describe("tweet -> NormalizedPost", () => {
    it("[11-02] maps shares = retweetCount + quoteCount (the derived PLAT-03 metric)", () => {
      expect(deriveShares(VIDEO_TWEET)).toBe(1700); // 1500 + 200
      expect(normalizeTweet(VIDEO_TWEET).metrics.shares).toBe(1700);
    });

    it("[11-02] retains the raw retweet_count / quote_count / bookmark_count components (D-05)", () => {
      expect(tweetRawComponents(VIDEO_TWEET)).toEqual({
        retweetCount: 1500,
        quoteCount: 200,
        bookmarkCount: 88,
      });
    });

    it("[11-02] maps view->impressions, comment->replies, like->favorites", () => {
      const post = normalizeTweet(VIDEO_TWEET);
      expect(post.metrics.views).toBe(980000);
      expect(post.metrics.comments).toBe(340);
      expect(post.metrics.likes).toBe(12000);
      expect(post.caption).toBe("Hades II — Technical Test out now!\nA second line here");
      expect(post.thumbnailUrl).toBe(
        "https://pbs.twimg.com/amplify_video_thumb/abc/img/poster.jpg",
      );
      expect(post.permalink).toBe("https://x.com/supergiantgames/status/1799999999999999999");
      expect(post.publishedAt).toEqual(new Date("Wed Jun 11 18:00:00 +0000 2026"));
    });

    it("[11-02] metrics-by-presence: a metric whose field is absent is null, never 0", () => {
      const bare = normalizeTweet({
        id: "1",
        createdAt: "Thu Jun 12 09:00:00 +0000 2026",
        author: { id: ACCOUNT_ID },
      });
      expect(bare.metrics).toEqual({ views: null, likes: null, comments: null, shares: null });
    });

    it("[11-02] both retweet and quote absent -> shares is null (not 0)", () => {
      expect(deriveShares(TEXT_TWEET)).toBeNull();
      expect(normalizeTweet(TEXT_TWEET).metrics.shares).toBeNull();
      // One present, one absent → the absent component is treated as 0.
      expect(deriveShares({ ...TEXT_TWEET, retweetCount: 5 })).toBe(5);
    });

    it("[11-02] media_type = 'video' for a native-video tweet; text-only -> 'text', photo -> 'image' (both -> 'other' filter category) (D-06)", () => {
      // The port kind union has NO "other" — "other" is the cross-source FILTER
      // category. A video tweet → "video"; text-only → "text"; photo → "image". Per
      // media-type-filter.ts postMediaKindToCategory, BOTH "text" and "image" land in
      // the "other" filter bucket — matching the plan's intent within the port type.
      expect(normalizeTweet(VIDEO_TWEET).kind).toBe("video");
      expect(normalizeTweet(TEXT_TWEET).kind).toBe("text");
      // A photo tweet (type 'photo', no video_info) → "image", thumbnail still set.
      const photo = normalizeTweet({
        ...TEXT_TWEET,
        extendedEntities: {
          media: [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/p.jpg" }],
        },
      });
      expect(photo.kind).toBe("image");
      expect(photo.thumbnailUrl).toBe("https://pbs.twimg.com/media/p.jpg");
    });
  });

  describe("D-04 timeline filter (keepForAccount)", () => {
    it("[11-02] keeps original tweets authored by the account", () => {
      expect(keepForAccount(VIDEO_TWEET, ACCOUNT_ID)).toBe(true);
    });

    it("[11-02] keeps quote tweets (the account's own commentary)", () => {
      const quote: Tweet = { ...VIDEO_TWEET, quoted_tweet: { id: "999" } };
      expect(keepForAccount(quote, ACCOUNT_ID)).toBe(true);
    });

    it("[11-02] keeps self-replies (a thread the account wrote)", () => {
      const selfReply: Tweet = {
        ...VIDEO_TWEET,
        isReply: true,
        inReplyToUserId: ACCOUNT_ID, // replying to its OWN thread
      };
      expect(keepForAccount(selfReply, ACCOUNT_ID)).toBe(true);
    });

    it("[11-02] drops pure retweets (no original authored content)", () => {
      const retweet: Tweet = { ...VIDEO_TWEET, retweeted_tweet: { id: "777" } };
      expect(keepForAccount(retweet, ACCOUNT_ID)).toBe(false);
    });

    it("[11-02] drops replies to other accounts", () => {
      const replyToOther: Tweet = {
        ...VIDEO_TWEET,
        isReply: true,
        inReplyToUserId: "999000111", // someone else's id
      };
      expect(keepForAccount(replyToOther, ACCOUNT_ID)).toBe(false);
    });
  });

  describe("single-tweet -> NormalizedSinglePost (paste/preview path)", () => {
    it("[11-02] maps a single fetched tweet to NormalizedSinglePost incl. derived shares", () => {
      const single = normalizeSingleTweet(VIDEO_TWEET);
      expect(single.id).toBe("1799999999999999999");
      expect(single.shortcode).toBe("1799999999999999999");
      expect(single.kind).toBe("video");
      expect(single.metrics.shares).toBe(1700); // derived retweet+quote
      expect(single.ownerId).toBe(ACCOUNT_ID);
      expect(single.ownerUsername).toBe("supergiantgames");
    });
  });

  describe("response envelopes (the 11-SPIKE.md nesting deviations)", () => {
    it("[11-02] normalizeFeedResponse reads data.tweets[] (NOT top-level) + boolean has_next_page", () => {
      const page = normalizeFeedResponse({
        status: "success",
        data: { tweets: [VIDEO_TWEET, TEXT_TWEET] },
        has_next_page: true,
        next_cursor: "cursor-page-2-abc",
      });
      expect(page.posts).toHaveLength(2);
      expect(page.nextCursor).toBe("cursor-page-2-abc");
      expect(page.endOfFeed).toBe(false);
      expect(page.creditsUsed).toBe(1);
      // FREE feed owner read off data.tweets[0].author.
      expect(page.owner).toEqual({
        accountId: ACCOUNT_ID,
        username: "supergiantgames",
        avatarUrl: "https://pbs.twimg.com/profile_images/avatar.jpg",
      });
    });

    it("[11-02] end-of-feed when has_next_page false OR next_cursor empty (Q2)", () => {
      const byFlag = normalizeFeedResponse({
        data: { tweets: [VIDEO_TWEET] },
        has_next_page: false,
        next_cursor: "still-here",
      });
      expect(byFlag.endOfFeed).toBe(true);
      // First-page cursor is the empty string — also end-of-feed when has_next_page is
      // not true.
      const emptyCursor = normalizeFeedResponse({
        data: { tweets: [VIDEO_TWEET] },
        has_next_page: true,
        next_cursor: "",
      });
      expect(emptyCursor.nextCursor).toBeNull();
      expect(emptyCursor.endOfFeed).toBe(true);
    });

    it("[11-02] normalizeSingleTweetResponse reads TOP-LEVEL tweets[] (asymmetry vs feed)", () => {
      expect(normalizeSingleTweetResponse({ tweets: [VIDEO_TWEET] })?.id).toBe(
        "1799999999999999999",
      );
      expect(normalizeSingleTweetResponse({ tweets: [] })).toBeNull();
      expect(normalizeSingleTweetResponse({ status: "error" })).toBeNull();
    });

    it("[11-02] normalizeProfile reads body.data + null-by-presence on data.id (Q3)", () => {
      const account = normalizeProfile({
        status: "success",
        data: {
          id: ACCOUNT_ID,
          userName: "supergiantgames",
          name: "Supergiant Games",
          profilePicture: "https://pbs.twimg.com/profile_images/avatar.jpg",
          followers: 500000,
        },
      });
      expect(account).toEqual({
        accountId: ACCOUNT_ID,
        displayName: "Supergiant Games",
        username: "supergiantgames",
        fullName: "Supergiant Games",
        avatarUrl: "https://pbs.twimg.com/profile_images/avatar.jpg",
        followerCount: 500000,
      });
      // Missing/suspended handle → HTTP 200 + data:null → null-by-presence.
      expect(normalizeProfile({ status: "error", msg: "not found", data: null })).toBeNull();
    });
  });
});

// ---- Provider endpoint/cursor/credit mapping (Task 2 — mock the HTTP layer) ----
const twitterFetch = vi.fn();
vi.mock("$lib/sources/twitter/server/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/sources/twitter/server/http.js")>();
  return {
    ...actual, // keep TWITTERAPIIO_BASE_URL + the QPS constants real
    twitterFetch: (...args: unknown[]): unknown => twitterFetch(...args),
  };
});

const { twitterapiioTwitterProvider } =
  await import("$lib/sources/twitter/server/provider/twitterapiio-twitter.js");
const { isTwitterConfigured } = await import("$lib/sources/twitter/server/provider/registry.js");

function jsonResponse(body: unknown): { json: () => Promise<unknown> } {
  return { json: async () => body };
}

describe("twitterapiioTwitterProvider (endpoint + credit mapping)", () => {
  beforeEach(() => {
    twitterFetch.mockReset();
  });

  it("[11-02] name is twitterapi.io (the OBS provider label)", () => {
    expect(twitterapiioTwitterProvider.name).toBe("twitterapi.io");
  });

  it("[11-02] fetchPosts hits /twitter/user/last_tweets with includeReplies + maps creditsUsed/endOfFeed/owner", async () => {
    twitterFetch.mockResolvedValueOnce(
      jsonResponse({
        data: { tweets: [VIDEO_TWEET] },
        has_next_page: true,
        next_cursor: "next-abc",
      }),
    );
    const page = await twitterapiioTwitterProvider.fetchPosts("twitter", "supergiantgames", null, {
      origin: "user",
    });
    const calledUrl = twitterFetch.mock.calls[0]![0] as URL;
    expect(calledUrl.pathname).toBe("/twitter/user/last_tweets");
    expect(calledUrl.searchParams.get("userName")).toBe("supergiantgames");
    expect(calledUrl.searchParams.get("includeReplies")).toBe("true");
    // First page: no cursor param (twitterapi.io's first-page cursor is the empty string).
    expect(calledUrl.searchParams.has("cursor")).toBe(false);
    expect(page.creditsUsed).toBe(1);
    expect(page.nextCursor).toBe("next-abc");
    expect(page.endOfFeed).toBe(false);
    expect(page.owner?.accountId).toBe(ACCOUNT_ID);
  });

  it("[11-02] fetchPosts threads a non-empty cursor", async () => {
    twitterFetch.mockResolvedValueOnce(
      jsonResponse({ data: { tweets: [] }, has_next_page: false, next_cursor: "" }),
    );
    await twitterapiioTwitterProvider.fetchPosts("twitter", "h", "page2cursor", { origin: "cron" });
    const calledUrl = twitterFetch.mock.calls[0]![0] as URL;
    expect(calledUrl.searchParams.get("cursor")).toBe("page2cursor");
  });

  it("[11-02] resolveAccount hits /twitter/user/info and returns null for the missing-handle body", async () => {
    twitterFetch.mockResolvedValueOnce(jsonResponse({ status: "error", data: null }));
    const result = await twitterapiioTwitterProvider.resolveAccount("twitter", "ghost_handle_xyz");
    const calledUrl = twitterFetch.mock.calls[0]![0] as URL;
    expect(calledUrl.pathname).toBe("/twitter/user/info");
    expect(calledUrl.searchParams.get("userName")).toBe("ghost_handle_xyz");
    expect(result).toBeNull();
  });

  it("[11-02] fetchPostByUrl hits /twitter/tweets with the status id and maps derived shares", async () => {
    twitterFetch.mockResolvedValueOnce(jsonResponse({ tweets: [VIDEO_TWEET] }));
    const single = await twitterapiioTwitterProvider.fetchPostByUrl(
      "twitter",
      "https://x.com/supergiantgames/status/1799999999999999999",
      { origin: "user" },
    );
    const calledUrl = twitterFetch.mock.calls[0]![0] as URL;
    expect(calledUrl.pathname).toBe("/twitter/tweets");
    expect(calledUrl.searchParams.get("tweet_ids")).toBe("1799999999999999999");
    expect(single?.metrics.shares).toBe(1700);
  });

  it("[11-02] fetchPostByUrl returns null (no HTTP) for a non-status URL", async () => {
    const single = await twitterapiioTwitterProvider.fetchPostByUrl(
      "twitter",
      "https://x.com/supergiantgames",
      { origin: "user" },
    );
    expect(single).toBeNull();
    expect(twitterFetch).not.toHaveBeenCalled();
  });

  it("[11-02] isTwitterConfigured is false when TWITTER_PROVIDER is unset (graceful degrade)", () => {
    // The test env leaves TWITTER_PROVIDER empty → not configured → null provider path.
    expect(isTwitterConfigured()).toBe(false);
  });
});
