// Card-data derivation helpers — pure functions shared by FeedCard
// (default fallback), YoutubeFeedCard, and RedditFeedCard.
//
// These functions are deliberately tiny and pure so a fresh reader can
// inline-trace what each card renders without juggling component
// boundaries. They live OUTSIDE any .svelte file so unit tests can
// exercise them without the Svelte compiler.
//
// Each helper reads:
//   - intrinsic-to-URL identifiers from event.metadata (subreddit,
//     author handle, twitter @handle, telegram channel) — safe per
//     AGENTS.md denormalization rule because these are part of the
//     canonical URL itself and the platform forbids rename.
//   - display names from FK-joined rows (data_sources.displayName,
//     data_sources.channelTitle) — NEVER from event metadata.
//
// What's intentionally NOT here:
//   - event.metadata.channelTitle reads. The /feed loader populates
//     event.channelTitle by JOINing youtube_videos → youtube_channels
//     (source of truth post no-denorm fix V-1, see
//     docs/denormalization-policy.md). YoutubeFeedCard still prefers
//     the `source` prop (data_sources.channelTitle resolved at read
//     time) over event.channelTitle so a registered channel's rename
//     reflects everywhere immediately; event.channelTitle is the
//     fallback for unregistered channels.

export type CardEventKind =
  | "youtube_video"
  | "reddit_post"
  | "twitter_post"
  | "telegram_post"
  | "discord_drop"
  | "instagram_post"
  | "conference"
  | "talk"
  | "press"
  | "other"
  | "post";

export interface CardEventLite {
  id: string;
  kind: CardEventKind;
  gameIds: string[];
  externalId: string | null;
  metadata: unknown;
  occurredAt: Date | string;
  authorIsMe: boolean;
  title: string;
  notes: string | null;
  url: string | null;
  sourceId: string | null;
  publishedAt?: Date | string | null;
  lastPolledAt: Date | string | null;
  lastPollStatus: string | null;
  channelTitle?: string | null;
  stats?: {
    viewCount: number;
    likeCount: number;
    commentCount: number;
    polledAt: Date | string;
  } | null;
  redditEnrichment?: {
    stats: {
      score: number;
      numComments: number;
      upvoteRatio: number;
      awardsTotal: number;
    } | null;
    subredditSubscribers: number | null;
    authorKarma: number | null;
    baseline: {
      medianScore24h: number | null;
      p75Score24h: number | null;
      sampleSize: number;
    } | null;
    linkUrl?: string | null;
    bodyExcerpt?: string | null;
    /** Subreddit slug from reddit_posts.subreddit (source-of-truth). */
    subreddit?: string | null;
    /** Author handle from reddit_posts.author (source-of-truth, NULL on
     *  Reddit-side account deletion). */
    author?: string | null;
    /** ISO timestamp when the worker detected the post is gone from
     *  Reddit. Cards use this for the "Deleted on Reddit" banner. */
    deletionDetectedAt?: string | null;
  };
  /** Instagram public-data decoration attached by
   *  sources/instagram/server/feed-enrichment.ts (mirrors redditEnrichment).
   *  Each stat is INDEPENDENTLY nullable — metrics-by-presence (D-05): a
   *  photo/carousel has no views (Instagram exposes play_count only on
   *  reels/video), NEVER coerced to 0. thumbnailUrl is the fresh CDN hotlink
   *  (D-08), mediaType drives the per-form KindIcon placeholder. */
  instagramEnrichment?: {
    stats: {
      viewCount: number | null;
      likeCount: number | null;
      commentCount: number | null;
      polledAt: Date | string;
    } | null;
    thumbnailUrl: string | null;
    mediaType: string | null;
  };
}

export interface CardSourceLite {
  id: string;
  displayName: string | null;
  handleUrl: string;
  channelTitle?: string | null;
}

/** Read the YouTube channel name from FK-joined data_sources, NEVER
 *  from event.metadata. data_sources.channelTitle is updated when the
 *  channel renames; caching the name on the event would go stale.
 *  Falls back to displayName (user's own label) then the raw handleUrl. */
export function youtubeChannelLabel(source: CardSourceLite | null): string {
  return source?.channelTitle ?? source?.displayName ?? source?.handleUrl ?? "";
}

/** Read the subreddit slug from event metadata. SAFE per AGENTS.md —
 *  subreddit slug is intrinsic to the Reddit URL and Reddit forbids
 *  subreddit rename. The value cannot drift from the post. */
export function redditSubredditLabel(metadata: unknown): string {
  if (metadata === null || typeof metadata !== "object") return "";
  const md = metadata as { subreddit?: unknown };
  return typeof md.subreddit === "string" && md.subreddit.length > 0 ? `r/${md.subreddit}` : "";
}

/** Read the Reddit author handle from event metadata. SAFE — the
 *  author handle is the user's permanent identifier at post time and
 *  the post URL doesn't carry it; the metadata snapshot reflects who
 *  posted, not a renameable display name. */
export function redditAuthorByline(metadata: unknown): string | null {
  if (metadata === null || typeof metadata !== "object") return null;
  const md = metadata as { author?: unknown };
  if (typeof md.author === "string" && md.author.length > 0) {
    return `/u/${md.author}`;
  }
  return null;
}

/** Read the Instagram account handle/display name from FK-joined
 *  data_sources, NEVER from event metadata (no-denorm rule — the IG handle
 *  is owned by data_sources and can be renamed). Falls back to displayName
 *  (user's own label) then the raw handleUrl. Mirrors youtubeChannelLabel. */
export function instagramHandleLabel(source: CardSourceLite | null): string {
  return source?.channelTitle ?? source?.displayName ?? source?.handleUrl ?? "";
}

/** Read the Twitter @handle from event metadata. The handle is part of
 *  the tweet URL (twitter.com/<handle>/status/<id>) so the metadata
 *  snapshot is intrinsic-to-URL. Twitter allows renames but the URL
 *  carries the OLD handle until the user navigates; we mirror what the
 *  URL claims. */
export function twitterHandleLabel(metadata: unknown): string {
  if (metadata === null || typeof metadata !== "object") return "";
  const md = metadata as { handle?: unknown };
  return typeof md.handle === "string" && md.handle.length > 0 ? `@${md.handle}` : "";
}

/** Read the Telegram channel id from event metadata. Channel id is
 *  part of the t.me URL. */
export function telegramChannelLabel(metadata: unknown): string {
  if (metadata === null || typeof metadata !== "object") return "";
  const md = metadata as { channel?: unknown };
  return typeof md.channel === "string" && md.channel.length > 0 ? md.channel : "";
}

/** Image-URL predicate — accepts Reddit's CDN hosts + common image
 *  extensions. The card thumbnail only renders for Reddit posts when
 *  this returns true to avoid embedding non-image URLs as <img>. */
export function isImageLikeUrl(url: string): boolean {
  const lower = url.toLowerCase();
  if (lower.startsWith("https://i.redd.it/")) return true;
  if (lower.startsWith("https://preview.redd.it/")) return true;
  return /\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(lower);
}

/** Read metadata.media.url defensively — used by Reddit/Twitter/
 *  Telegram thumbnails. Returns null when missing/wrong shape. */
export function readMediaUrlFromMetadata(md: unknown): string | null {
  if (md === null || typeof md !== "object") return null;
  const mediaContainer = (md as { media?: unknown }).media;
  if (
    mediaContainer === null ||
    mediaContainer === undefined ||
    typeof mediaContainer !== "object"
  ) {
    return null;
  }
  const url = (mediaContainer as { url?: unknown }).url;
  return typeof url === "string" && url.length > 0 ? url : null;
}

/** Compute the thumbnail URL for any event kind. Returns null when no
 *  derivable thumbnail exists (text-shape kinds + reddit posts without
 *  image media). */
export function deriveThumbnailUrl(event: CardEventLite): string | null {
  if (event.kind === "youtube_video") {
    if (!event.externalId) return null;
    return `https://img.youtube.com/vi/${event.externalId}/mqdefault.jpg`;
  }
  if (event.kind === "reddit_post") {
    const link = event.redditEnrichment?.linkUrl ?? null;
    if (link && isImageLikeUrl(link)) return link;
    return readMediaUrlFromMetadata(event.metadata);
  }
  if (event.kind === "twitter_post" || event.kind === "telegram_post") {
    return readMediaUrlFromMetadata(event.metadata);
  }
  if (event.kind === "instagram_post") {
    // IG's CDN serves thumbnails with Cross-Origin-Resource-Policy: same-origin,
    // so the raw hotlink (instagramEnrichment.thumbnailUrl) is BLOCKED by the
    // browser cross-origin. Route through the same-origin proxy keyed by the
    // media id (#69) — only when a thumbnail actually exists in the cache (the
    // enrichment URL is present) and we have the post id to key on.
    if (event.instagramEnrichment?.thumbnailUrl == null || !event.externalId) return null;
    const base = `/api/instagram/thumbnail/${encodeURIComponent(event.externalId)}`;
    // Cache-buster: version the stable proxy URL by the latest poll timestamp.
    // A re-poll (Refresh-Now or a scheduled tick) writes a new snapshot → new
    // polledAt → new URL → the browser refetches the fresh cover; between polls
    // it serves from the 1h cache. The proxy ignores the query param.
    const polledAt = event.instagramEnrichment.stats?.polledAt;
    return polledAt ? `${base}?v=${new Date(polledAt).getTime()}` : base;
  }
  return null;
}

/** YouTube videos + Instagram posts reserve a fixed thumb slot even when
 *  the image is missing (KindIcon fallback fills it). YouTube uses 16:9,
 *  Instagram 4:5 (the IG card overrides the aspect-ratio token). Other
 *  kinds only render the thumb when an image is actually derivable. */
export function isMediaShape(kind: CardEventKind): boolean {
  return kind === "youtube_video" || kind === "instagram_post";
}

/** Month-Day formatter — "May 21" style. Locale-aware (Intl). */
export function formatOccurredAt(occurredAt: Date | string): string {
  const d = typeof occurredAt === "string" ? new Date(occurredAt) : occurredAt;
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Inbox-row predicate — event with no attached games AND not
 *  dismissed AND not off-topic. Drives the inbox-chip + per-card
 *  attach-picker affordance. */
export function isInboxRow(event: Pick<CardEventLite, "gameIds" | "metadata">): boolean {
  if (event.gameIds.length > 0) return false;
  const md = event.metadata as
    | { inbox?: { dismissed?: boolean }; triage?: { offTopic?: boolean } }
    | null
    | undefined;
  if (md?.inbox?.dismissed === true) return false;
  if (md?.triage?.offTopic === true) return false;
  return true;
}

/** Off-topic predicate — triage.offTopic flag set via bulkEdit. */
export function isStandalone(event: Pick<CardEventLite, "metadata">): boolean {
  const md = event.metadata as { triage?: { offTopic?: boolean } } | null | undefined;
  return md?.triage?.offTopic === true;
}

/** Format a count with K/M suffixes for compact stat rows. */
export function formatStat(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Deterministic per-game color from id hash → CSS hsl. Same id always
 *  produces the same hue. GameDto has no color field; we derive it
 *  client-side so the per-game chip color is consistent across the app. */
export function gameColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  const hue = ((h % 360) + 360) % 360;
  return `hsl(${hue} 62% 52%)`;
}
