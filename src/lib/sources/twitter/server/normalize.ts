// Twitter/X (twitterapi.io) provider-shape → NormalizedPost / NormalizedSinglePost
// / ResolvedAccount mapping.
//
// PURE module: no HTTP, no DB. Every field name + nesting below is a
// LIVE-CONFIRMED fact from 11-SPIKE.md (run against `ConcernedApe` /
// `supergiantgames` / `PlayStation`, 2026-06-12), NOT the documented contract.
// The net deviations the spike caught versus the research/docs are encoded here:
//   1. The feed tweets nest at `data.tweets[]` (NOT the documented top-level
//      `tweets[]`) — the single biggest deviation. The SINGLE-tweet endpoint IS
//      top-level `tweets[]` (the two paths differ — encoded in distinct schemas).
//   2. Media/thumbnail at `extendedEntities.media[0].media_url_https`
//      (a pbs.twimg.com URL). `media[0].type` ∈ "photo"/"video"/"animated_gif";
//      a video tweet's media_url_https is the poster `.jpg`, mp4s are under
//      `media[0].video_info.variants`.
//   3. `has_next_page` is a clean BOOLEAN (NO TikTok numeric-vs-boolean trap);
//      end-of-feed = `!has_next_page || !next_cursor` (next_cursor "" on page 1).
//   4. Missing handle = HTTP 200 + `data: null` on /user/info (null-by-presence
//      on `data.id`, NOT a 404).
//   5. The profile object is under `body.data` (NOT top-level).
//
// Validate-then-map discipline (mirrors tiktok/server/normalize.ts): each response
// is parsed by a zod schema FIRST, then mapped. Fields the spike noted as optional
// are `.nullable().optional()` so a caption-less or metric-less tweet parses cleanly
// and maps to null (metrics-by-presence — never 0).
//
// PLAT-03 / D-05: Twitter is the FIRST platform whose `shares` is a DERIVED SUM —
// `retweetCount + quoteCount` (both are redistribution), unlike TikTok's single
// `share_count` field. The normalizer computes it (presence-mapped: both absent →
// null, never 0) AND surfaces the RAW retweet/quote/bookmark components as extra
// fields the walker passes to writeSnapshot (NOT on the port type — they ride
// alongside so the shares split stays reconstructable on twitter_post_snapshots).
//
// D-04 timeline filter: keep originals + quote tweets + self-replies (promo threads
// import whole); drop retweets (retweeted_tweet non-null) + replies to OTHER
// accounts (isReply && inReplyToUserId !== this account's id). The filter needs the
// account id in scope (the walker passes it; the single-tweet paste path skips it).

import { z } from "zod";
import type {
  FeedOwner,
  NormalizedPost,
  NormalizedSinglePost,
  ProviderPage,
  ResolvedAccount,
} from "$lib/sources/social-provider.js";

// ---- Media object (11-SPIKE.md Q1 — the undocumented path, pinned live) ----
// extendedEntities.media[0].media_url_https is the thumbnail (pbs.twimg.com). For
// a video tweet it is the poster .jpg; video_info.variants[] hold the mp4s. type
// discriminates the media kind ("photo" | "video" | "animated_gif").
const MEDIA = z
  .object({
    type: z.string().nullable().optional(),
    media_url_https: z.string().nullable().optional(),
    video_info: z.unknown().nullable().optional(),
  })
  .nullable()
  .optional();

const EXTENDED_ENTITIES = z
  .object({
    media: z.array(MEDIA).nullable().optional(),
  })
  .nullable()
  .optional();

// ---- Tweet author (the FREE feed owner — present on every tweet, 11-SPIKE.md) ----
// id is the stable numeric user id; userName is the renameable @handle.
const AUTHOR = z
  .object({
    id: z.string().nullable().optional(),
    userName: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    profilePicture: z.string().nullable().optional(),
    followers: z.number().nullable().optional(),
  })
  .nullable()
  .optional();

// ---- The tweet shape — IDENTICAL on the feed (data.tweets[]) and the single-tweet
// endpoint (top-level tweets[]), 11-SPIKE.md Call A + Call B. ----
const TWEET = z.object({
  id: z.string(),
  url: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  createdAt: z.string(),
  likeCount: z.number().nullable().optional(),
  retweetCount: z.number().nullable().optional(),
  replyCount: z.number().nullable().optional(),
  quoteCount: z.number().nullable().optional(),
  viewCount: z.number().nullable().optional(),
  bookmarkCount: z.number().nullable().optional(),
  isReply: z.boolean().nullable().optional(),
  inReplyToId: z.string().nullable().optional(),
  inReplyToUserId: z.string().nullable().optional(),
  inReplyToUsername: z.string().nullable().optional(),
  // Type-flag objects: populated on a retweet / quote, null otherwise (D-04).
  retweeted_tweet: z.unknown().nullable().optional(),
  quoted_tweet: z.unknown().nullable().optional(),
  extendedEntities: EXTENDED_ENTITIES,
  author: AUTHOR,
});

export type Tweet = z.infer<typeof TWEET>;

/**
 * The DERIVED `shares` metric (D-05): retweetCount + quoteCount. Metrics-by-presence
 * — both absent → null (never 0); when at least one component is present, treat the
 * absent component as 0 and sum. This is the central Twitter-specific delta vs TikTok
 * (which had a single share_count field).
 */
export function deriveShares(t: Tweet): number | null {
  const rt = t.retweetCount ?? null;
  const qt = t.quoteCount ?? null;
  if (rt === null && qt === null) return null;
  return (rt ?? 0) + (qt ?? 0);
}

/** D-09 event/preview title = the caption's FIRST line (~100 chars), falling back to
 *  a "Tweet · <date>" shape so a text-less tweet still produces a non-empty title
 *  (the Add Event form requires one). One spelling for both the walker and the paste
 *  preview. Lives here — the pure-mapping home — alongside the other tweet→event mappers. */
export function buildTwitterTitle(text: string | null, publishedAt: Date): string {
  const trimmed = text?.trim();
  if (trimmed !== undefined && trimmed !== "") {
    const firstLine = trimmed.split("\n", 1)[0]!.trim();
    if (firstLine !== "") return firstLine.length > 100 ? firstLine.slice(0, 100) : firstLine;
  }
  return `Tweet · ${publishedAt.toISOString().slice(0, 10)}`;
}

/** Media-type discriminator → cross-platform content kind (D-06).
 *
 *  DEVIATION from the plan's literal "video" | "other" wording (Rule 3 — blocking):
 *  "other" is NOT a member of the port NormalizedPost["kind"] union ("video" |
 *  "short" | "image" | "carousel" | "text"). "other" is the cross-source MEDIA-TYPE
 *  FILTER category, not a port kind. So a native-video tweet (media[0].type ===
 *  "video" OR video_info present) → "video"; a photo / animated_gif tweet → "image";
 *  a text-only tweet → "text". Per src/lib/feed/media-type-filter.ts
 *  postMediaKindToCategory, BOTH "image" and "text" classify into the "other" filter
 *  category — so the user-facing result matches the plan's intent (video → Video,
 *  text/image → Other) while staying inside the port type. NOT TikTok's
 *  "short"/"carousel" vocabulary (a tweet is not a short-form vertical clip).
 *
 *  NOTE for Plan 03: the cross-source filter currently classifies twitter_post at the
 *  KIND level (EVENT_KIND_MEDIA_CATEGORY.twitter_post = "other"), so a video tweet
 *  does NOT yet surface under the "Video" filter bucket. Flipping twitter_post to
 *  "per-post" (so the filter consults twitter_posts.media_type) is Plan 03's wiring,
 *  alongside storing this media_type on the snapshot/post row. */
function tweetKind(t: Tweet): NormalizedPost["kind"] {
  const media = t.extendedEntities?.media?.[0] ?? null;
  if (media === null || media === undefined) return "text";
  const isVideo = media.type === "video" || media.video_info != null;
  return isVideo ? "video" : "image";
}

/** Thumbnail = extendedEntities.media[0].media_url_https (11-SPIKE.md Q1). null on a
 *  text-only tweet (extendedEntities is {} with no media key). For a video tweet this
 *  is the renderable poster .jpg. */
function pickThumbnail(t: Tweet): string | null {
  return t.extendedEntities?.media?.[0]?.media_url_https ?? null;
}

/** The raw redistribution components retained for the snapshot writer (D-05). NOT on
 *  the port NormalizedPost — they ride alongside so twitter_post_snapshots can store
 *  retweet/quote/bookmark independently and the shares split stays reconstructable. */
export interface TweetRawComponents {
  retweetCount: number | null;
  quoteCount: number | null;
  bookmarkCount: number | null;
}

/** Extract the raw redistribution components (presence-mapped) for the snapshot writer. */
export function tweetRawComponents(t: Tweet): TweetRawComponents {
  return {
    retweetCount: t.retweetCount ?? null,
    quoteCount: t.quoteCount ?? null,
    bookmarkCount: t.bookmarkCount ?? null,
  };
}

/**
 * Map one tweet (a feed item or the single-tweet object) to a NormalizedPost.
 * Exported pure so the unit test asserts the mapping directly without spinning up
 * the provider.
 *
 * D-05: `shares = retweetCount + quoteCount` (presence-mapped — the DERIVED metric).
 * Metrics-by-presence: a metric whose source field is absent is null, never 0.
 */
export function normalizeTweet(t: Tweet): NormalizedPost {
  return {
    id: t.id,
    kind: tweetKind(t),
    publishedAt: new Date(t.createdAt),
    metrics: {
      views: t.viewCount ?? null,
      likes: t.likeCount ?? null,
      comments: t.replyCount ?? null,
      // D-05 — the DERIVED retweet+quote sum (presence-mapped).
      shares: deriveShares(t),
    },
    caption: t.text ?? null,
    thumbnailUrl: pickThumbnail(t),
    permalink: t.url ?? null,
  };
}

/**
 * D-04 timeline filter — whether a tweet should be IMPORTED for an account. Keep:
 * originals, quote tweets (quoted_tweet non-null, the account's own commentary),
 * self-replies (isReply && inReplyToUserId === accountId — a thread the account
 * wrote). Drop: retweets (retweeted_tweet non-null — someone else's content/metrics),
 * replies to OTHER accounts (isReply && inReplyToUserId !== accountId).
 *
 * `accountId` is the feed-owner's stable numeric id (the walker passes it). The
 * single-tweet paste path does NOT filter (the user explicitly chose that tweet).
 */
export function keepForAccount(t: Tweet, accountId: string): boolean {
  // Retweets carry someone else's content + metrics — never the account's own work.
  if (t.retweeted_tweet != null) return false;
  // A reply is kept ONLY when it is a self-reply (the account replying to its own
  // thread). A reply to another account is dropped.
  if (t.isReply === true) {
    return t.inReplyToUserId === accountId;
  }
  // Originals and quote tweets (quoted_tweet non-null but not a reply) are kept.
  return true;
}

/** Map a tweet `author` object → FeedOwner (the FREE owner fields the walker UPSERTs
 *  onto twitter_accounts with NO extra credit). Returns null when there is nothing to
 *  anchor an account row on (no id AND no userName). */
function pickFeedOwner(author: Tweet["author"]): FeedOwner | null {
  if (author === null || author === undefined) return null;
  const accountId = author.id ?? null;
  const username = author.userName ?? null;
  if (accountId === null && username === null) return null;
  return {
    accountId,
    username,
    avatarUrl: author.profilePicture ?? null,
  };
}

// ---- FEED response (/twitter/user/last_tweets — 11-SPIKE.md Call A) ----
// DEVIATION 1: tweets nest at `data.tweets[]` (NOT top-level). has_next_page is a
// clean boolean; next_cursor is a string ("" on page 1). end-of-feed =
// !has_next_page || !next_cursor.
const FEED_RESPONSE = z.object({
  data: z
    .object({
      tweets: z.array(TWEET).nullable().optional(),
    })
    .nullable()
    .optional(),
  has_next_page: z.boolean().nullable().optional(),
  next_cursor: z.string().nullable().optional(),
});

/**
 * Validate + map a feed response → uniform ProviderPage. The deviations die here —
 * callers see only `posts` / `nextCursor` / `endOfFeed`. The feed owner is read off
 * the FIRST item's author (every item carries the same author for a profile feed).
 *
 * NOTE: this does NOT apply the D-04 filter — the walker calls `keepForAccount(t,
 * accountId)` after resolving the account id (the page-level normalizer has no
 * account-id scope, and the feed owner's id IS the account id the walker filters by).
 */
export function normalizeFeedResponse(json: unknown): ProviderPage {
  // ONE feed-mapping body lives in normalizeFeedResponseWithRaw; this neutral
  // entry point just drops the Twitter-specific rawTweets, returning the port
  // ProviderPage for any generic consumer (the walker calls …WithRaw directly).
  return normalizeFeedResponseWithRaw(json).page;
}

/**
 * Tree-local feed page that carries the RAW tweets alongside the cross-source
 * ProviderPage. The port `ProviderPage` stays vendor-agnostic (no Twitter fields),
 * but the Twitter WALKER needs the raw `Tweet` objects to (a) apply the D-04
 * keepForAccount filter — its flags (retweeted_tweet / isReply / inReplyToUserId)
 * are NOT on NormalizedPost — and (b) thread the D-05 raw retweet/quote/bookmark
 * components into the snapshot. `rawTweets[i]` aligns with `page.posts[i]` by index
 * (both map the SAME `data.tweets[]` array in order), so the walker zips them.
 */
export interface TwitterFeedPage {
  page: ProviderPage;
  rawTweets: Tweet[];
}

/**
 * Validate + map a feed response → a TwitterFeedPage (the cross-source ProviderPage
 * PLUS the index-aligned raw tweets). This is the Twitter-tree-local fetch result:
 * the neutral `normalizeFeedResponse` (above) returns only the port shape for any
 * generic consumer; the walker calls THIS so it has the raw flags for D-04/D-05.
 * The D-04 filter is NOT applied here (the page-level normalizer has no account-id
 * scope — the walker applies keepForAccount after resolving the feed owner's id).
 */
export function normalizeFeedResponseWithRaw(json: unknown): TwitterFeedPage {
  const parsed = FEED_RESPONSE.parse(json);
  const tweets = parsed.data?.tweets ?? [];
  const nextCursor =
    parsed.next_cursor !== null && parsed.next_cursor !== undefined && parsed.next_cursor !== ""
      ? parsed.next_cursor
      : null;
  return {
    page: {
      posts: tweets.map((t) => normalizeTweet(t)),
      nextCursor,
      endOfFeed: parsed.has_next_page !== true || nextCursor === null,
      creditsUsed: 1,
      owner: pickFeedOwner(tweets[0]?.author),
    },
    rawTweets: tweets,
  };
}

// ---- SINGLE-TWEET response (/twitter/tweets?tweet_ids= — 11-SPIKE.md Call B) ----
// ASYMMETRY: tweets are at the TOP LEVEL `tweets[]` here (NOT `data.tweets` like the
// feed). A single-id query → a 1-element array; empty/absent → null.
const SINGLE_TWEET_RESPONSE = z.object({
  tweets: z.array(TWEET).nullable().optional(),
});

/**
 * Map one single tweet → NormalizedSinglePost (the paste-preview path). `author.id →
 * ownerId` (stable), `author.userName → ownerUsername` (renameable). shares carries
 * through as the DERIVED sum (D-05 for the paste path too). Exported pure so the unit
 * test asserts the mapping directly.
 */
export function normalizeSingleTweet(t: Tweet): NormalizedSinglePost {
  const post = normalizeTweet(t);
  return {
    id: post.id,
    // The tweet id IS the URL-intrinsic /status/<id> tail, so the shortcode == the id.
    shortcode: t.id,
    kind: post.kind,
    publishedAt: post.publishedAt,
    metrics: post.metrics,
    caption: post.caption,
    thumbnailUrl: post.thumbnailUrl,
    ownerId: t.author?.id ?? null,
    ownerUsername: t.author?.userName ?? null,
  };
}

/** Validate + map a single-tweet response → NormalizedSinglePost, or `null` when the
 *  body carries no tweets (deleted/private tweet — HTTP errors surface upstream as
 *  AdapterError from the HTTP seam, never here). */
export function normalizeSingleTweetResponse(json: unknown): NormalizedSinglePost | null {
  const parsed = SINGLE_TWEET_RESPONSE.parse(json);
  const tweet = parsed.tweets?.[0] ?? null;
  if (tweet === null) return null;
  return normalizeSingleTweet(tweet);
}

// ---- PROFILE response (/twitter/user/info — 11-SPIKE.md Call C) ----
// The user is under `body.data` (NOT top-level). Missing handle is HTTP 200 + `data:
// null` → null-by-presence on `data.id` (11-SPIKE.md Q3), NOT a 404.
const PROFILE_USER = z
  .object({
    id: z.string().nullable().optional(),
    userName: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    profilePicture: z.string().nullable().optional(),
    followers: z.number().nullable().optional(),
  })
  .nullable()
  .optional();

const PROFILE_RESPONSE = z.object({
  data: PROFILE_USER,
});

/**
 * Validate + map a profile response → ResolvedAccount, or `null` when the body
 * carries no `data.id` (missing/suspended handle — twitterapi.io returns HTTP 200 +
 * `data: null`, so null-by-presence is the PRIMARY missing-handle signal, NOT HTTP
 * status — 11-SPIKE.md Q3). The avatar / follower fields are read off the SAME
 * response (no extra fetch) to seed the twitter_accounts subject entity.
 */
export function normalizeProfile(json: unknown): ResolvedAccount | null {
  const parsed = PROFILE_RESPONSE.parse(json);
  const user = parsed.data ?? null;
  if (user === null) return null;

  const accountId = user.id ?? null;
  if (accountId === null || accountId === "") return null;

  return {
    accountId,
    displayName: user.name ?? user.userName ?? null,
    username: user.userName ?? null,
    fullName: user.name ?? null,
    avatarUrl: user.profilePicture ?? null,
    followerCount: user.followers ?? null,
  };
}
