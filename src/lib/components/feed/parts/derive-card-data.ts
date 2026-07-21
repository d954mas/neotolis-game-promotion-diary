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

import { telegramHandleFromUrl } from "$lib/util/telegram-handle.js";

export type CardEventKind =
  | "youtube_video"
  | "reddit_post"
  | "twitter_post"
  | "telegram_post"
  | "discord_drop"
  | "instagram_post"
  | "tiktok_post"
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
  /** Author @handle SNAPSHOT for source-less manual social pastes (NULL
   *  otherwise). FALLBACK-only: the shared card uses it ONLY when the event has
   *  no linked source (sourceId null) AND no source-resolved label — a live
   *  data_sources name always wins. NOT a no-denorm violation: a source-less
   *  paste has no owning row for the author (see events schema header). */
  authorHandle?: string | null;
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
  /** Reddit public-data decoration attached by
   *  sources/reddit/server/feed-enrichment.ts (mirrors instagramEnrichment). D-09
   *  metric set: likes (score) + comments (num_comments) ONLY — Reddit exposes no
   *  view count and no share/crosspost count (12-SPIKE Q4), so NO viewCount /
   *  shareCount fields. Each stat is INDEPENDENTLY nullable (metrics-by-presence).
   *  thumbnailUrl is the raw i.redd.it cover HOTLINKED directly (12-SPIKE Pitfall 5
   *  — NO proxy; onerror fallback in the card), FREQUENTLY NULL (ScrapeCreators
   *  omits `thumbnail`; only image/gallery posts derive one). mediaType
   *  ("self" | "link" | "image" | "gallery") drives the adaptive card variant. */
  redditEnrichment?: {
    stats: {
      likeCount: number | null;
      commentCount: number | null;
      polledAt: Date | string;
    } | null;
    thumbnailUrl: string | null;
    mediaType: string | null;
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
  /** Telegram public-data decoration attached by
   *  sources/telegram/server/feed-enrichment.ts (mirrors instagramEnrichment).
   *  Telegram exposes TWO metrics (D-04 + E1): a nullable view count AND a
   *  nullable reaction total, never likes / comments. metrics-by-presence
   *  (D-05): a very-new / views-hidden / no-reactions post carries null,
   *  NEVER coerced to 0. thumbnailUrl is the fresh t.me hotlink (D-06),
   *  mediaKind ("photo" | "video" | "album" | null) drives the adaptive
   *  media-vs-text card layout — null = text-only post. reactionsTop is the
   *  top-5 most-popular reactions (E1) the card renders as an emoji+count list;
   *  null/[] → no reactions row. */
  telegramEnrichment?: {
    stats: {
      viewCount: number | null;
      reactionsTotal: number | null;
      polledAt: Date | string;
    } | null;
    thumbnailUrl: string | null;
    mediaKind: string | null;
    reactionsTop:
      | { emoji: string | null; kind: "standard" | "custom" | "paid"; count: number }[]
      | null;
  };
  /** TikTok public-data decoration attached by
   *  sources/tiktok/server/feed-enrichment.ts (mirrors instagramEnrichment with
   *  the PLAT-02 shareCount delta). Each stat is INDEPENDENTLY nullable —
   *  metrics-by-presence (D-05): a photo-mode post has no views (null), NEVER
   *  coerced to 0; shareCount is TikTok's first-class share metric. thumbnailUrl
   *  is the raw TikTok CDN hotlink (D-07, signed + expiring — onerror fallback in
   *  the card); mediaType ("short" | "carousel") drives the media-type overlay. */
  tiktokEnrichment?: {
    stats: {
      viewCount: number | null;
      likeCount: number | null;
      commentCount: number | null;
      shareCount: number | null;
      polledAt: Date | string;
    } | null;
    thumbnailUrl: string | null;
    mediaType: string | null;
  };
  /** Twitter/X public-data decoration attached by
   *  sources/twitter/server/feed-enrichment.ts (mirrors tiktokEnrichment — the
   *  same FOUR metrics incl shares). Each stat is INDEPENDENTLY nullable —
   *  metrics-by-presence (D-05): a protected/limited tweet may hide impressions
   *  (null), NEVER coerced to 0; shareCount is the DERIVED retweet+quote sum.
   *  thumbnailUrl is the RAW pbs.twimg.com cover HOTLINKED directly (11-SPIKE.md
   *  Q6 — NO proxy, unlike TikTok/IG; onerror fallback in the card); mediaType
   *  ("video" | "image" | "text") drives the adaptive media-vs-text card layout
   *  (null/"text" = text-only tweet) + the media-type overlay. */
  twitterEnrichment?: {
    stats: {
      viewCount: number | null;
      likeCount: number | null;
      commentCount: number | null;
      shareCount: number | null;
      polledAt: Date | string;
    } | null;
    thumbnailUrl: string | null;
    mediaType: string | null;
  };
  /** YouTube public-data decoration attached by
   *  sources/youtube/server/feed-enrichment.ts. Carries the Shorts
   *  classification (youtube_videos.media_type): 'short' drives the "Short"
   *  media-type pill; 'video' / NULL / missing → "Video" (a YouTube video is a
   *  video at worst — Shorts detection heals NULLs lazily). Stats + channelTitle
   *  remain on the top-level dto fields (legacy youtube enrichment shape). */
  youtubeEnrichment?: {
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

/** Read the TikTok account handle/display name from FK-joined data_sources,
 *  NEVER from event metadata (no-denorm rule — the TikTok @handle is owned by
 *  data_sources / tiktok_accounts and the account owner can rename it). Falls
 *  back to displayName (user's own label) then the raw handleUrl. Mirrors
 *  instagramHandleLabel / youtubeChannelLabel. */
export function tiktokHandleLabel(source: CardSourceLite | null): string {
  return source?.channelTitle ?? source?.displayName ?? source?.handleUrl ?? "";
}

/** Read the Telegram channel display name / @handle from FK-joined
 *  data_sources, NEVER from event metadata (no-denorm rule — the @handle is
 *  owned by data_sources and the channel owner can rename it). Falls back to
 *  displayName (user's own label) then the raw handleUrl. Mirrors
 *  instagramHandleLabel / youtubeChannelLabel. (The metadata-reading
 *  telegramChannelLabel below is the URL-intrinsic numeric/slug key, a
 *  different concern — this is the renameable display surface.) */
export function telegramChannelHandleLabel(source: CardSourceLite | null): string {
  if (source?.channelTitle) return source.channelTitle;
  if (source?.displayName) return source.displayName;
  // Fallback for a not-yet-polled channel (no telegram_channels entity title
  // resolved yet): show the @handle from the t.me URL, never the raw URL.
  // Shared with SourceRow + the /sources/[id] heading via telegramHandleFromUrl.
  return telegramHandleFromUrl(source?.handleUrl) ?? source?.handleUrl ?? "";
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

/** Resolve the .src account label rendered in the card meta row.
 *
 *  The per-platform wrapper already computed `sourceLabel` from its
 *  source-of-truth read path (the LIVE data_sources name via the `source`
 *  prop). When that resolves to a non-empty value it ALWAYS wins — a linked
 *  source's live name is never overridden.
 *
 *  Only when the wrapper produced an EMPTY label AND the event has no linked
 *  source (sourceId null — a manually-pasted social post from an account that
 *  isn't a registered source) do we fall back to the author @handle SNAPSHOT
 *  persisted on the event at paste time. This is NOT a no-denorm violation: a
 *  source-less paste has no owning row for the author, so the snapshot is a
 *  free-standing value like the event's own title/url, and it is never read
 *  when a source IS linked (the live name takes the branch above). The handle
 *  is stored bare (e.g. "neonicle_dev") and rendered "@neonicle_dev". */
export function resolveSourceLabel(
  sourceLabel: string,
  event: Pick<CardEventLite, "sourceId" | "authorHandle">,
): string {
  if (sourceLabel.length > 0) return sourceLabel;
  if (event.sourceId === null && event.authorHandle) return `@${event.authorHandle}`;
  return sourceLabel;
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
    // Reddit HOTLINKS the raw i.redd.it cover (12-SPIKE Pitfall 5 — NO proxy, unlike
    // TikTok/IG). Read the enrichment thumbnail (the source-of-truth the chart marker
    // + feed card read), NOT event.metadata. FREQUENTLY null (thumbnail absent from
    // ScrapeCreators; only image/gallery posts derive one) → no image, text card.
    return event.redditEnrichment?.thumbnailUrl ?? null;
  }
  if (event.kind === "twitter_post") {
    // Twitter HOTLINKS the raw pbs.twimg.com cover (no proxy — unlike TikTok's ORB-
    // blocked CDN). Read the enrichment thumbnail (the source-of-truth the chart marker
    // + feed card read), NOT event.metadata — else the event-detail modal renders blank.
    return event.twitterEnrichment?.thumbnailUrl ?? null;
  }
  if (event.kind === "telegram_post") {
    // Same as twitter: the cover lives on the enrichment object (the t.me hotlink),
    // not event.metadata. Reading metadata blanked the detail-modal thumbnail.
    return event.telegramEnrichment?.thumbnailUrl ?? null;
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
  if (event.kind === "tiktok_post") {
    // 10-SPIKE.md Q3 RESOLVED (Plan 05 UAT): the TikTok cover on tiktokcdn-us.com
    // is hotlink-BLOCKED in a real browser (net::ERR_BLOCKED_BY_ORB), exactly like
    // IG's CORP block — a raw <img> hotlink fails even though the server fetches it
    // 200. Route through the same-origin proxy keyed by the aweme id (mirrors IG's
    // #69), only when a thumbnail actually exists in the cache (the enrichment URL
    // is present) and we have the post id to key on.
    if (event.tiktokEnrichment?.thumbnailUrl == null || !event.externalId) return null;
    const base = `/api/tiktok/thumbnail/${encodeURIComponent(event.externalId)}`;
    // Cache-buster: version the stable proxy URL by the latest poll timestamp. A
    // re-poll (Refresh-Now or a scheduled tick) writes a new snapshot → new
    // polledAt → new URL → the browser refetches the fresh cover; between polls it
    // serves from the 1h cache. The proxy ignores the query param.
    const polledAt = event.tiktokEnrichment.stats?.polledAt;
    return polledAt ? `${base}?v=${new Date(polledAt).getTime()}` : base;
  }
  return null;
}

/** YouTube videos + Instagram posts reserve a fixed thumb slot even when
 *  the image is missing (KindIcon fallback fills it). YouTube uses 16:9,
 *  Instagram 4:5 (the IG card overrides the aspect-ratio token). Other
 *  kinds only render the thumb when an image is actually derivable. */
export function isMediaShape(kind: CardEventKind): boolean {
  return kind === "youtube_video" || kind === "instagram_post" || kind === "tiktok_post";
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
