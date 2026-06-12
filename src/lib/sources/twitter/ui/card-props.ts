// Twitter/X ui/card-props.ts — per-source toCardProps mapper (fork of tiktok/
// ui/card-props.ts with the D-05 DERIVED shares chip).
//
// Pure function — no Svelte component imports — safe to call from
// +page.server.ts loaders. (SvelteKit pre-render crashes when a server module
// transitively imports a .svelte file outside a Svelte context.)
//
// The shape produced matches src/lib/sources/card-props.ts (CardProps). The
// universal <EventCard.svelte> shell consumes this shape; the per-source
// override (TwitterFeedCard) is the actual /feed surface.
//
// Metrics-by-presence (D-05): a metric is pushed ONLY when its value is
// non-null — a protected/limited tweet may hide impressions (null → omitted,
// never 0). Twitter exposes FOUR metrics (views/likes/comments/SHARES) vs
// Telegram's two and TikTok's four; shares is the DERIVED retweet+quote sum
// (D-05), pushed when shareCount !== null. The Twitter enrichment lives on the
// decorated dto under `twitterEnrichment` (set by ./server/feed-enrichment.ts).
import type { CardProps } from "$lib/sources/card-props.js";
import { m } from "$lib/paraglide/messages.js";
// Shared K/M stat formatter (loader-safe: derive-card-data imports only the pure
// telegram-handle util). One spelling across every feed card mapper.
import { formatStat } from "$lib/components/feed/parts/derive-card-data.js";

interface TwitterEventLite {
  id: string;
  title: string;
  twitterEnrichment?: {
    stats: {
      viewCount: number | null;
      likeCount: number | null;
      commentCount: number | null;
      shareCount: number | null;
    } | null;
    thumbnailUrl: string | null;
    mediaType: string | null;
  };
}

export function toCardProps(event: TwitterEventLite): CardProps {
  const stats = event.twitterEnrichment?.stats ?? null;
  const metrics: CardProps["metrics"] = [];
  if (stats) {
    // Views chip — a protected/limited tweet may omit impressions (null →
    // omitted, never 0). Likes/comments render whenever present.
    if (stats.viewCount !== null) {
      metrics.push({ label: m.card_youtube_metric_views(), value: formatStat(stats.viewCount) });
    }
    if (stats.likeCount !== null) {
      metrics.push({ label: m.card_youtube_metric_likes(), value: formatStat(stats.likeCount) });
    }
    if (stats.commentCount !== null) {
      metrics.push({
        label: m.card_youtube_metric_comments(),
        value: formatStat(stats.commentCount),
      });
    }
    // D-05 — the DERIVED shares chip (retweet+quote). Presence-gated like the
    // others — a tweet with no redistribution carries null → omitted, never 0.
    if (stats.shareCount !== null) {
      metrics.push({ label: m.card_twitter_metric_shares(), value: formatStat(stats.shareCount) });
    }
  }
  return {
    // Null for a text-only tweet → the card renders text-only (D-06 adaptive).
    thumbnail: event.twitterEnrichment?.thumbnailUrl ?? null,
    title: event.title,
    subtitle: null,
    badge: null,
    metrics,
    href: `/events/${event.id}`,
  };
}
