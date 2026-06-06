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

export type SocialPlatform = "instagram" | "tiktok" | "twitter"; // grows per later phase

export interface NormalizedPost {
  /** Platform-native post/reel id → events.external_id. */
  id: string;
  /** D-04 content shape → events.metadata.media_type. `reel` is distinct from
   *  `video`: a reel (provider integer media_type 2 + product_type "clips") is
   *  the IG short-form surface, a plain `video` (media_type 2, NOT clips) is a
   *  long-form feed video. The card renders a different corner glyph per form. */
  kind: "video" | "reel" | "image" | "carousel" | "text";
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
}

/** Which prepaid budget pool a provider request reserves against (BUDGET-02).
 *  "user" = user-initiated (onboarding / refresh-now / widen); "cron" =
 *  background continuation. Passed through to reserveSocialCredits in the HTTP
 *  seam so EVERY page counts against the operator budget. */
export type ProviderOrigin = "cron" | "user";

export interface SocialProvider {
  /** "scrapecreators" — the `provider` OBS label. */
  readonly name: string;
  fetchPosts(
    platform: SocialPlatform,
    handle: string,
    cursor: string | null,
    opts: { kindFilter?: "posts" | "reels"; origin?: ProviderOrigin },
  ): Promise<ProviderPage>;
  resolveAccount(
    platform: SocialPlatform,
    handle: string,
  ): Promise<{ accountId: string; displayName: string | null } | null>;
  /** D-23 additive-only; NEVER depended on. */
  getCreditBalance?(): Promise<number | null>;
}
