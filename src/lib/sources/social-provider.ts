// SocialProvider port — the cross-platform vendor seam beneath SourceAdapter.
//
// This is the SOC-04 contract boundary. A SourceAdapter (Plans 03/05) and the
// walker call `provider.fetchPosts(...)` / `provider.resolveAccount(...)` and
// see ONLY NormalizedPost / ProviderPage — never a ScrapeCreators (or any other
// vendor's) field name. Each provider implementation (ScrapeCreators today;
// EnsembleData / SocialData / a self-adapter later) maps its own response
// shapes to these types inside its own module, so swapping vendors is a
// one-file change and Phases 9-11 (TikTok / X) extend this port with one more
// impl rather than editing every consumer.
//
// Types + interfaces only. No implementation lives here.

export type SocialPlatform = "instagram" | "tiktok" | "twitter" | "reddit"; // grows per later phase

export interface NormalizedPost {
  /** Platform-native post/reel id → events.external_id. */
  id: string;
  /** D-04 content shape → events.metadata.media_type. `short` is distinct from
   *  `video`: a short (provider integer media_type 2 + product_type "clips") is
   *  the IG short-form surface, a plain `video` (media_type 2, NOT clips) is a
   *  long-form feed video. `short` is the ONE cross-platform term for the
   *  short-form video form (IG Reels / YouTube Shorts / TikTok). The card
   *  renders a different corner glyph per form. */
  kind: "video" | "short" | "image" | "carousel" | "text";
  publishedAt: Date;
  /**
   * D-04 / D-05 metrics-by-presence: a metric whose source field is absent on
   * this content type is `null`, never `0`. `shares` is ALWAYS null for
   * Instagram (no share field in either endpoint, 08-SPIKE.md).
   */
  metrics: {
    views: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
  };
  /** D-09 title = first line; full caption → notes/metadata. `null` when the post is caption-less. */
  caption: string | null;
  /** D-08 hotlink; the CDN URL expires, so consumers re-resolve on demand. */
  thumbnailUrl: string | null;
  permalink: string | null;
}

export interface ProviderPage {
  posts: NormalizedPost[];
  /**
   * UNIFORM cursor — the adapter hides the posts (`next_max_id`, top-level) vs
   * reels (`paging_info.max_id`, nested) divergence behind this single field.
   * `null` at end of feed.
   */
  nextCursor: string | null;
  /** Derived from `more_available === false` (posts) / `paging_info.more_available === false` (reels). */
  endOfFeed: boolean;
  /** 1 per request (D-18) — feeds OBS + the operator spend counter. */
  creditsUsed: number;
  /**
   * The account whose feed this page is (the top-level owner object the feed
   * response already carries — FREE). The walker UPSERTs the subject entity
   * (instagram_accounts) from this with NO extra credit. `null` when the
   * response omits the owner (or the provider doesn't surface it).
   */
  owner?: FeedOwner | null;
}

/** Which prepaid budget pool a provider request reserves against (BUDGET-02).
 *  "user" = user-initiated (onboarding / refresh-now / widen); "cron" =
 *  background continuation. Passed through to reserveSocialCredits in the HTTP
 *  seam so EVERY page counts against the operator budget. */
export type ProviderOrigin = "cron" | "user";

export interface ProviderPostFetchOptions {
  origin?: ProviderOrigin;
}

/**
 * Single-post lookup result (paste-preview path). The provider issues ONE
 * by-URL request (1 credit) and maps the vendor's single-media shape into this
 * cross-platform type — nothing above the provider seam sees a ScrapeCreators
 * field name (SOC-04). Optional-by-presence metrics are `null` when the source
 * field is absent on this content type (mirrors NormalizedPost.metrics), never
 * `0`.
 */
export interface NormalizedSinglePost {
  /** Platform-native post/reel id → events.external_id. */
  id: string;
  /** URL-intrinsic shortcode (the `/p/<code>` | `/reel/<code>` slug). */
  shortcode: string | null;
  /** Same cross-platform content-form vocabulary as NormalizedPost.kind. */
  kind: "video" | "short" | "image" | "carousel" | "text";
  publishedAt: Date;
  /**
   * Metrics-by-presence (mirrors NormalizedPost.metrics): a metric whose source
   * field is absent on this content type is `null`, never `0`. `shares` is the
   * TikTok-populated metric (PLAT-02) — Instagram's single-post endpoint exposes
   * no share field, so its provider impl ALWAYS nulls it; TikTok is the first
   * platform to surface a real share count here.
   */
  metrics: {
    views: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
  };
  /** `null` when the post is caption-less. */
  caption: string | null;
  /** `null` when no thumbnail is exposed. The CDN URL expires (D-08). */
  thumbnailUrl: string | null;
  /** Stable platform-native owner/account id (the channel key). */
  ownerId: string | null;
  /** Owner handle/username — display value, read from source-of-truth, not cached. */
  ownerUsername: string | null;
  /** Reddit post FORM ("self"|"link"|"image"|"gallery") when the provider is Reddit;
   *  else null/absent. OPTIONAL so non-Reddit provider impls stay untouched (same
   *  pattern as ResolvedAccount.secUid). Lets the paste-preview snapshot persist the
   *  real reddit_posts.media_type so an image/gallery card renders its media variant
   *  IMMEDIATELY — without it the paste stored null and the card fell back to a plain
   *  text layout until the next source walk re-derived the form. */
  mediaType?: string | null;
}

/**
 * Resolved account profile (the resolveAccount result). The provider reads
 * these off the ONE profile response it already pays for on source-resolve — no
 * extra fetch. `accountId` + `displayName` are the load-bearing create-time
 * fields (the channelKey + the data_sources.display_name seed); the remaining
 * fields are the richer subject-entity metadata (instagram_accounts) populated
 * from the same response. Any field the provider response omits is `null`.
 */
export interface ResolvedAccount {
  /** Stable platform-native account id (the channelKey). */
  accountId: string;
  /** full_name (fallback username) — the data_sources.display_name seed. */
  displayName: string | null;
  /** Current @handle / username (without the leading '@'). */
  username: string | null;
  /** Upstream account name (full_name) — entity source-of-truth metadata. */
  fullName: string | null;
  /** Avatar / profile-pic URL (expires; refreshed on each resolve). */
  avatarUrl: string | null;
  /** Follower count when the profile response exposes it; else null. */
  followerCount: number | null;
  /** Platform secondary opaque id (TikTok secUid) when the profile response carries
   *  it; else null/absent. OPTIONAL so the IG provider impl (no secUid) is untouched. */
  secUid?: string | null;
}

/**
 * Owner of a feed page — the account whose feed was fetched. Read from the FREE
 * feed response (the posts/reels endpoint carries a top-level owner object), so
 * the walker can refresh the subject entity (instagram_accounts) opportunistically
 * with NO extra credit. The richer fields (avatar / follower count) come from the
 * PAID profile resolve; the feed owner carries only the always-present id +
 * @handle (+ avatar when present). `null` when the response omits the owner.
 */
export interface FeedOwner {
  /** Stable platform-native account id. */
  accountId: string | null;
  /** Current @handle / username. */
  username: string | null;
  /** Avatar / profile-pic URL when the feed owner carries one; else null. */
  avatarUrl: string | null;
}

export interface SocialProvider {
  /** "scrapecreators" — the `provider` OBS label. */
  readonly name: string;
  fetchPosts(
    platform: SocialPlatform,
    handle: string,
    cursor: string | null,
    opts: { kindFilter?: "posts" | "reels"; origin?: ProviderOrigin },
  ): Promise<ProviderPage>;
  resolveAccount(platform: SocialPlatform, handle: string): Promise<ResolvedAccount | null>;
  /**
   * Fetch ONE post/reel by its public permalink (paste-preview path). The
   * `mediaType` is resolved from the response media kind combined with the URL
   * shape (a `/reel/` permalink → "short"; the single-post API exposes no
   * product_type, so the permalink IS the short-vs-video discriminator). 1
   * credit per call — the HTTP seam meters it via the threaded `origin` pool.
   * The provider returns `null` only when the response body carries no media
   * object (HTTP errors surface as AdapterError from the HTTP seam).
   */
  fetchPostByUrl(
    platform: SocialPlatform,
    url: string,
    opts: ProviderPostFetchOptions,
  ): Promise<NormalizedSinglePost | null>;
  /** D-23 additive-only; NEVER depended on. */
  getCreditBalance?(): Promise<number | null>;
}
