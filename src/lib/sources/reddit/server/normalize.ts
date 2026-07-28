// Reddit (ScrapeCreators) provider-shape → NormalizedPost / NormalizedSinglePost
// / ResolvedAccount mapping (D-09).
//
// PURE module: no HTTP, no DB. Every field name + shape below is a LIVE-CONFIRMED
// fact from 12-SPIKE.md (the `author:` search walk of u/d954mas + the native
// r/gamedev subreddit envelope, 2026-07-21), NOT the documented contract. The net
// deviations the spike froze versus the pre-spike docs are encoded here:
//   1. externalId = `post.name` (the `t3_<base36>` fullname), NOT `post.id` (the
//      base36 short id with no prefix).
//   2. `is_self` + `thumbnail` are ABSENT from the response → the post FORM
//      (self|link|image|gallery) is DERIVED from `post_hint` (subreddit endpoint)
//      / `domain` / `url`-vs-`permalink` / `selftext`-non-empty / `is_video`.
//   3. `removed_by_category` + `num_crossposts` are ABSENT → surfaced as null
//      (forward-compat snapshot columns; deletion rides on disappearance-from-walk,
//      NOT a field flag — spike Variant A).
//   4. Two endpoints, ASYMMETRIC field sets — author-search adds `relative_position`;
//      subreddit adds `post_hint`/`domain`/`subreddit_id`. Read the UNION by-presence.
//
// D-09 metric mapping (metrics-by-presence — absent → null, never 0):
//   likes    = score         comments = num_comments
//   views    = null (Reddit exposes none)   shares = null (num_crossposts absent)
//
// Validate-then-map discipline (mirrors tiktok/server/normalize.ts): each response
// is parsed by a zod schema FIRST, then mapped. Spike-optional fields are
// `.nullable().optional()` so a caption-less or metric-less post parses cleanly.
//
// SPIKE COVERAGE: image/gallery card variants were NOT sampled (neither u/d954mas
// nor r/gamedev returned an image post) — the media-type derivation is built
// defensively and live-confirmed at Plan 12-06 UAT.

import { z } from "zod";
import { AdapterError } from "$lib/sources/errors.js";
import { mapPostsResilient } from "$lib/sources/feed-normalize.js";
import type {
  NormalizedPost,
  NormalizedSinglePost,
  ProviderPage,
  ResolvedAccount,
  FeedOwner,
} from "$lib/sources/social-provider.js";

/** Reddit post FORM (stored in reddit_posts.media_type). Distinct from the
 *  cross-platform NormalizedPost.kind vocabulary — is_self/thumbnail are ABSENT
 *  so this is derived from post_hint / domain / url-vs-permalink / selftext. */
export type RedditMediaType = "self" | "link" | "image" | "gallery";

// ---- The ScrapeCreators reddit post shape (union across both endpoints) ----
// name (t3_ fullname) + id (short) are the only always-present required ids;
// everything else is nullable/optional so a trimmed or older post parses.
const REDDIT_POST = z.object({
  name: z.string(), // t3_<base36> fullname → externalId (spike deviation #1)
  id: z.string(), // base36 short id (no prefix)
  author: z.string().nullable().optional(),
  author_fullname: z.string().nullable().optional(),
  subreddit: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  selftext: z.string().nullable().optional(),
  selftext_html: z.string().nullable().optional(),
  score: z.number().nullable().optional(),
  ups: z.number().nullable().optional(),
  downs: z.number().nullable().optional(),
  upvote_ratio: z.number().nullable().optional(),
  total_awards_received: z.number().nullable().optional(),
  num_comments: z.number().nullable().optional(),
  // ABSENT from the ScrapeCreators response (spike) — forward-compat only.
  num_crossposts: z.number().nullable().optional(),
  removed_by_category: z.string().nullable().optional(),
  created_utc: z.number().nullable().optional(),
  created_at_iso: z.string().nullable().optional(),
  permalink: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  is_video: z.boolean().nullable().optional(),
  over_18: z.boolean().nullable().optional(),
  spoiler: z.boolean().nullable().optional(),
  subreddit_subscribers: z.number().nullable().optional(),
  // author-search-only.
  relative_position: z.number().nullable().optional(),
  // subreddit-only (the is_self replacement discriminator).
  post_hint: z.string().nullable().optional(),
  domain: z.string().nullable().optional(),
  subreddit_id: z.string().nullable().optional(),
  // ABSENT from ScrapeCreators (spike deviation #2) — accepted for forward-compat.
  thumbnail: z.string().nullable().optional(),
});

type RedditPostRaw = z.infer<typeof REDDIT_POST>;

// ---- The feed envelope (IDENTICAL for author-search + native subreddit) ----
// { success, posts:[...], after }. End-of-feed = `after` absent/null (spike Q3:
// the terminal page still carried posts) OR an empty posts[] (belt-and-suspenders).
// posts is z.unknown()[] — NOT z.array(REDDIT_POST) — so ONE malformed post cannot
// throw at the envelope parse and nuke the whole paid page. Each post is strict-parsed
// (REDDIT_POST.parse) independently in normalizeRedditFeed via mapPostsResilient, which
// drops a stray bad row but throws on a majority-drop shape change.
const FEED_ENVELOPE = z.object({
  success: z.boolean().nullable().optional(),
  posts: z.array(z.unknown()).nullable().optional(),
  after: z.string().nullable().optional(),
});

/** Thumbnail literals Reddit historically used for "no image" (self/default/nsfw/
 *  spoiler). The ScrapeCreators response OMITS `thumbnail` entirely, so this only
 *  fires on the forward-compat path — harmless either way (Pitfall 5). */
const THUMBNAIL_NON_URLS = new Set(["self", "default", "nsfw", "spoiler", "image", ""]);

// i.redd.it + bare image extensions → an image the card can hotlink.
const IMAGE_URL_RE = /(?:^https?:\/\/i\.redd\.it\/)|(?:\.(?:jpg|jpeg|png|gif|webp)(?:\?|$))/i;
// A url that points BACK at a reddit comments permalink ⇒ a self/text post.
const REDDIT_COMMENTS_URL_RE = /reddit\.com\/(?:r|user)\/[^/]+\/comments\//i;

/** Derive the Reddit post FORM. is_self + thumbnail are ABSENT (spike deviation
 *  #2), so classify from the union-by-presence discriminators: gallery URL →
 *  gallery; post_hint/url image signal → image; self.<sub> domain / self-hint /
 *  selftext / comments-url → self; everything else with an external domain →
 *  link. Defensive (image/gallery unsampled — confirm at 12-06 UAT). */
function deriveMediaType(raw: RedditPostRaw): RedditMediaType {
  const url = raw.url ?? "";
  const domain = raw.domain ?? null;
  const postHint = raw.post_hint ?? null;
  const hasSelftext = typeof raw.selftext === "string" && raw.selftext.trim() !== "";

  if (/\/gallery\//i.test(url)) return "gallery";
  if (postHint === "image") return "image";
  if (IMAGE_URL_RE.test(url)) return "image";

  const isSelfDomain = domain !== null && domain.startsWith("self.");
  if (postHint === "self" || postHint === "text") return "self";
  if (isSelfDomain) return "self";
  if (REDDIT_COMMENTS_URL_RE.test(url)) return "self";

  if (postHint === "link") return "link";
  if (domain !== null && !isSelfDomain) return "link";
  return hasSelftext ? "self" : "link";
}

/** Reddit FORM → the cross-platform NormalizedPost.kind vocabulary. reddit_posts
 *  stores the richer RedditMediaType (via `mediaType` below); the port only
 *  carries the shared vocab so the feed card + cross-source filter stay uniform. */
function toPortKind(mediaType: RedditMediaType, raw: RedditPostRaw): NormalizedPost["kind"] {
  if (raw.is_video === true) return "video";
  switch (mediaType) {
    case "image":
      return "image";
    case "gallery":
      return "carousel";
    case "self":
    case "link":
      return "text";
  }
}

/** BOUNDARY VALIDATION for provider-supplied absolute URLs (review fix): permalink
 *  lands in href and thumbnail in img src, so an EXTERNAL provider must not be able
 *  to persist an arbitrary host (broken Reddit permalink contract + third-party
 *  tracking requests on render). HTTPS + an allowlisted host family or nothing. */
function urlHostAllowed(value: string, allowed: (host: string) => boolean): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && allowed(parsed.hostname.toLowerCase());
}

/** reddit.com + subdomains (www / old / new / mobile spellings all resolve). */
function isRedditPermalinkHost(host: string): boolean {
  return host === "reddit.com" || host.endsWith(".reddit.com");
}

/** The Reddit media CDN families (i.redd.it / preview.redd.it / *.redditmedia.com). */
function isRedditCdnHost(host: string): boolean {
  return host === "redd.it" || host.endsWith(".redd.it") || host.endsWith(".redditmedia.com");
}

/** Thumbnail by-presence: a real Reddit-CDN URL survives; a Reddit "no image"
 *  literal or an off-CDN host → null; otherwise DERIVE from the post url for image
 *  posts (i.redd.it). `thumbnail` is absent from ScrapeCreators, so the image path
 *  is the live one (spike #2). An external image host (e.g. an imgur link post)
 *  yields null — the card renders no image chip rather than hotlinking a
 *  third-party host from every feed view. */
function pickThumbnail(raw: RedditPostRaw, mediaType: RedditMediaType): string | null {
  const thumb = raw.thumbnail ?? null;
  if (thumb !== null && !THUMBNAIL_NON_URLS.has(thumb) && urlHostAllowed(thumb, isRedditCdnHost)) {
    return thumb;
  }
  if (
    mediaType === "image" &&
    typeof raw.url === "string" &&
    IMAGE_URL_RE.test(raw.url) &&
    urlHostAllowed(raw.url, isRedditCdnHost)
  ) {
    return raw.url;
  }
  return null;
}

/** Canonical permalink. ScrapeCreators returns `permalink` as a path (e.g.
 *  `/r/<sub>/comments/<id>/<slug>/`); prefix the host. `url` may be an EXTERNAL
 *  link (link posts), so never use it as the permalink. An absolute permalink on a
 *  non-Reddit host is a provider anomaly → null (the walker then falls back to the
 *  canonical /comments/<id> URL rebuilt from the post id). */
function pickPermalink(raw: RedditPostRaw): string | null {
  if (typeof raw.permalink === "string" && raw.permalink !== "") {
    // A path MUST be root-relative ("/r/…") so the prefix cannot be smuggled into a
    // different authority; anything else must parse as an https reddit.com URL.
    if (raw.permalink.startsWith("/")) return `https://www.reddit.com${raw.permalink}`;
    return urlHostAllowed(raw.permalink, isRedditPermalinkHost) ? raw.permalink : null;
  }
  return null;
}

/** Resolve a post's publish time, or null when NEITHER source is valid. `created_utc`
 *  (epoch SECONDS) is the live ScrapeCreators field (always present in 12-SPIKE);
 *  `created_at_iso` is the documented fallback for the schema's `.optional()` shape.
 *  The neither-present branch is forward-compat only.
 *
 *  Returns null (NOT epoch 0, NOT `now`) when unresolvable. Two rejected fallbacks:
 *    - epoch 0 → the newest-first walker reads 1970 as older-than-target and HALTS
 *      the pass, silently dropping every remaining older post (breaks D-02).
 *    - `now` → fabricates a timestamp that mis-tiers the post as freshly-active AND
 *      re-orders chronology, and can MASK the real newest post (the tier + frontier
 *      key on published_at). The caller drops the row instead (mapPostsResilient) —
 *      safe now that a dropped page suppresses the disappearance reconcile
 *      (droppedCount), so a dropped-but-alive post is never false-flagged deleted. */
function resolveRedditPublishedAt(raw: RedditPostRaw): Date | null {
  if (typeof raw.created_utc === "number") return new Date(raw.created_utc * 1000);
  if (typeof raw.created_at_iso === "string" && raw.created_at_iso !== "") {
    const iso = new Date(raw.created_at_iso);
    if (!Number.isNaN(iso.getTime())) return iso;
  }
  return null;
}

/** D-09 event/preview title = the FIRST non-empty line of the given text, capped
 *  at ~100 chars (the Add Event form title). One spelling for the walker + the
 *  paste preview — callers pass the post title (falling back to selftext). */
export function buildRedditTitle(text: string | null | undefined): string {
  const trimmed = text?.trim() ?? "";
  if (trimmed === "") return "";
  const firstLine = trimmed.split("\n", 1)[0]!.trim();
  return firstLine.length > 100 ? `${firstLine.slice(0, 99).trimEnd()}…` : firstLine;
}

/** The Reddit-specific fields the walker passes to the snapshot writer + the
 *  reddit_posts row — they ride ALONGSIDE the port NormalizedPost (D-09), never
 *  on the port type itself (nothing above the seam sees a ScrapeCreators name). */
export interface NormalizedRedditPost extends NormalizedPost {
  /** reddit_posts.media_type — the richer Reddit FORM (self|link|image|gallery). */
  mediaType: RedditMediaType;
  /** The post title (reddit_posts.title) — reddit posts carry a title distinct
   *  from the self-post body, unlike IG/TikTok captions. */
  title: string | null;
  /** The self-post body (reddit_posts.caption) — null for link/image posts. */
  selftext: string | null;
  /** Lowercase intrinsic slug (the safe denorm — reddit_posts.subreddit_slug). */
  subredditSlug: string | null;
  /** Reddit username (reddit_posts.author — PURGED to null by the deletion cron). */
  author: string | null;
  /** Stable `t2_` id (reddit_posts.author_fullname). */
  authorFullname: string | null;
  /** The raw D-09 platform-owned columns the snapshot writer retains verbatim. */
  raw: {
    score: number | null;
    upvoteRatio: number | null;
    numComments: number | null;
    numCrossposts: number | null;
    removedByCategory: string | null;
    /** Reddit's literal `[deleted]` author tombstone was present. */
    authorDeleted?: boolean;
  };
}

/** Map one ScrapeCreators reddit post → NormalizedRedditPost. externalId =
 *  post.name (the t3_ fullname — spike deviation #1). Exported pure so the unit
 *  test asserts the mapping directly without spinning up the provider. */
export function normalizeRedditPost(raw: unknown): NormalizedRedditPost {
  const post = REDDIT_POST.parse(raw);
  // Identity belt (review fix): only a t3_ (link/submission) fullname is a post. A
  // non-t3 row (t1_ comment, t5_ subreddit — a provider mixing shapes) must not be
  // cached / imported under a bogus externalId → THROW so mapPostsResilient drops it.
  if (!/^[a-z0-9]+$/i.test(post.id) || post.name !== `t3_${post.id}`) {
    throw new Error(`reddit post ${post.name}: fullname does not match id ${post.id}`);
  }
  const mediaType = deriveMediaType(post);
  const selftext =
    typeof post.selftext === "string" && post.selftext.trim() !== "" ? post.selftext : null;
  const title = typeof post.title === "string" && post.title !== "" ? post.title : null;
  const authorDeleted = post.author?.trim().toLowerCase() === "[deleted]";
  // Timestamp is load-bearing (tier + frontier + newest-first walk boundary). A post
  // with no resolvable published_at is malformed → THROW so mapPostsResilient DROPS it
  // (a minority-drop is tolerated; a majority-drop throws transient). Better an honest
  // drop than a fabricated "now" that mis-tiers + re-orders + masks the real newest.
  const publishedAt = resolveRedditPublishedAt(post);
  if (publishedAt === null) {
    throw new Error(`reddit post ${post.name}: unresolvable published_at (no created_utc)`);
  }

  return {
    id: post.name, // t3_<base36> fullname — the rename-proof externalId (NOT post.id)
    kind: toPortKind(mediaType, post),
    publishedAt,
    metrics: {
      // D-09 metrics-by-presence: absent → null, never 0.
      views: null, // Reddit exposes no view count
      likes: typeof post.score === "number" ? post.score : null,
      comments: typeof post.num_comments === "number" ? post.num_comments : null,
      shares: null, // num_crossposts is ABSENT from the response
    },
    caption: title, // the post title is the headline; the body rides in `selftext`
    thumbnailUrl: pickThumbnail(post, mediaType),
    permalink: pickPermalink(post),
    mediaType,
    title,
    selftext,
    subredditSlug: post.subreddit != null ? post.subreddit.toLowerCase() : null,
    author: authorDeleted ? null : (post.author ?? null),
    authorFullname: authorDeleted ? null : (post.author_fullname ?? null),
    raw: {
      score: typeof post.score === "number" ? post.score : null,
      upvoteRatio: typeof post.upvote_ratio === "number" ? post.upvote_ratio : null,
      numComments: typeof post.num_comments === "number" ? post.num_comments : null,
      // ABSENT from ScrapeCreators — always null (forward-compat column).
      numCrossposts: typeof post.num_crossposts === "number" ? post.num_crossposts : null,
      removedByCategory: post.removed_by_category ?? null,
      authorDeleted,
    },
  };
}

/** Map one reddit post → NormalizedSinglePost (the paste-preview path). The
 *  shortcode is the base36 short id (`post.id`, the `/comments/<id>/` URL tail);
 *  the owner is the post's author (Reddit has no separate profile response). */
export function normalizeSingleRedditPost(raw: unknown): NormalizedSinglePost {
  const post = REDDIT_POST.parse(raw);
  const full = normalizeRedditPost(raw);
  return {
    id: full.id,
    shortcode: post.id,
    kind: full.kind,
    publishedAt: full.publishedAt,
    metrics: full.metrics,
    caption: full.caption,
    thumbnailUrl: full.thumbnailUrl,
    ownerId: full.authorFullname,
    ownerUsername: full.author,
    ownerDeleted: full.raw.authorDeleted === true,
  };
}

/** Anchor a ResolvedAccount off a post's FREE author fields (Reddit exposes no
 *  user-profile endpoint — spike). `t2_` fullname → accountId (falls back to the
 *  username), username → the renameable @handle. Null when there is no author. */
export function normalizeRedditOwner(raw: unknown): ResolvedAccount | null {
  const post = REDDIT_POST.parse(raw);
  const username = post.author ?? null;
  if (username === null || username === "" || username.trim().toLowerCase() === "[deleted]") {
    return null;
  }
  return {
    accountId: post.author_fullname ?? username,
    displayName: username,
    username,
    fullName: null,
    avatarUrl: null,
    followerCount: null,
  };
}

/** The FREE feed owner (the account/subreddit the page belongs to) — read off the
 *  first SUCCESSFULLY-PARSED post's author. Reddit's feed carries no top-level owner
 *  object, so we anchor on the post author (author-search: one author for the whole
 *  page). Taking the first MAPPED post (not the first raw one) means a dropped
 *  malformed lead post doesn't blank the owner. */
function pickFeedOwner(post: NormalizedRedditPost | undefined): FeedOwner | null {
  if (post === undefined) return null;
  const username = post.author;
  if (username === null) return null;
  return {
    accountId: post.authorFullname,
    username,
    avatarUrl: null,
  };
}

/** Tree-local feed page — the richer ProviderPage the reddit walker (Plan 12-05)
 *  consumes: `posts` carry the reddit-specific columns for the snapshot writer. */
export interface RedditFeedPage extends ProviderPage {
  posts: NormalizedRedditPost[];
  /** How many raw posts on this page failed to parse and were DROPPED by
   *  mapPostsResilient (minority-drop — a majority-drop throws instead). Load-bearing
   *  for Variant-A deletion reconciliation: a dropped-but-alive post is absent from the
   *  walker's seenIds, so a pass that dropped ANY row is NOT lossless coverage and must
   *  NOT drive the disappearance reconcile (it would false-flag the dropped post as
   *  deleted → purge). The walker skips reconcile when the pass dropped anything. */
  droppedCount: number;
}

/** Validate + map a feed envelope (author-search OR subreddit) → RedditFeedPage.
 *  Throws AdapterError(transient) on an explicit success:false soft-error page.
 *  nextCursor = `after` (null/absent/"" all collapse to null = end-of-feed);
 *  endOfFeed = no-more-pages OR empty posts[]. 1 credit/page (spike Q5). */
export function normalizeRedditFeed(json: unknown): RedditFeedPage {
  const parsed = FEED_ENVELOPE.parse(json);
  // A well-formed envelope that EXPLICITLY reports success:false is a provider-side
  // soft error served as HTTP 200 (a failed/empty page) — NOT a genuinely exhausted
  // feed. Treat it as transient so the walker RETRIES rather than marking the source
  // end-of-feed / backfill-complete / needs_reconnect on a transient upstream hiccup.
  // `success` absent or null is the older/looser shape → treated as ok. The paste
  // path maps this AdapterError to a graceful "unreachable" preview (index.ts).
  if (parsed.success === false) {
    throw new AdapterError("ScrapeCreators reddit feed returned success:false", {
      category: "transient",
      context: { after: parsed.after ?? null },
    });
  }
  // A success envelope MUST carry posts[] (review fix). An envelope with the field
  // ABSENT/null is a provider shape anomaly, NOT an authoritative empty feed — treated
  // as empty it would read as a complete zero-post coverage pass and (on an established
  // source) trigger reconcileAllDisappeared → a mass false deletion-flag. A genuinely
  // empty feed serves posts: [] (present, empty), which stays the authoritative path.
  if (parsed.posts == null) {
    throw new AdapterError("ScrapeCreators reddit feed envelope carried no posts[]", {
      category: "transient",
      context: { after: parsed.after ?? null },
    });
  }
  const rawPosts = parsed.posts;
  // Resilient per-post mapping: a stray malformed post is dropped, but a majority-drop
  // (provider shape change) throws AdapterError(transient) instead of yielding a partial
  // page that would read as a false end-of-feed.
  const posts = mapPostsResilient(rawPosts, normalizeRedditPost, "reddit feed");
  // mapPostsResilient pushes one output per SUCCESSFUL parse and drops failures (and
  // throws on a majority-drop), so the minority-drop count is exactly input − output.
  // The walker reads this to suppress the disappearance reconcile on a lossy page.
  const droppedCount = rawPosts.length - posts.length;
  // Treat an empty-string `after` as end-of-feed. The fetch layer sends no `after`
  // param for "" (it guards `cursor !== "" `, same as null), so a non-null "" cursor
  // would otherwise re-request PAGE 1 every loop iteration until the page cap —
  // burning one paid credit per loop and falsely tripping backfill-complete on the
  // re-counted posts. `after` null/absent/"" all mean the same thing: no more pages.
  const nextCursor = parsed.after != null && parsed.after !== "" ? parsed.after : null;
  return {
    posts,
    nextCursor,
    endOfFeed: nextCursor === null || posts.length === 0,
    creditsUsed: 1,
    owner: pickFeedOwner(posts[0]),
    droppedCount,
  };
}
