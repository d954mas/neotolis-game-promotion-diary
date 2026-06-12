// Instagram ui/card-props.ts — per-source toCardProps mapper.
//
// Pure function — no Svelte component imports — safe to call from
// +page.server.ts loaders. (SvelteKit pre-render crashes when a server
// module transitively imports a .svelte file outside a Svelte context.)
//
// The shape produced matches src/lib/sources/card-props.ts (CardProps).
// The universal <EventCard.svelte> shell consumes this shape; the
// per-source override (InstagramFeedCard) is the actual /feed surface.
//
// Metrics-by-presence (D-05): a metric is pushed ONLY when its value is
// non-null — reels carry views (play_count), photos/carousels do not; a
// null metric is omitted, never rendered as 0. `shares` is never produced
// (D-04). The IG enrichment lives on the decorated dto under
// `instagramEnrichment` (set by ./server/feed-enrichment.ts).
import type { CardProps } from "$lib/sources/card-props.js";
import { m } from "$lib/paraglide/messages.js";
// Shared K/M stat formatter (loader-safe: derive-card-data imports only the pure
// telegram-handle util). One spelling across every feed card mapper.
import { formatStat } from "$lib/components/feed/parts/derive-card-data.js";

interface InstagramEventLite {
  id: string;
  title: string;
  instagramEnrichment?: {
    stats: {
      viewCount: number | null;
      likeCount: number | null;
      commentCount: number | null;
    } | null;
    thumbnailUrl: string | null;
    mediaType: string | null;
  };
}

export function toCardProps(event: InstagramEventLite): CardProps {
  const stats = event.instagramEnrichment?.stats ?? null;
  const metrics: CardProps["metrics"] = [];
  if (stats) {
    // Reels expose play_count → views chip; photos/carousels do not (null →
    // omitted). Likes/comments render whenever present. No 0-for-absent.
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
  }
  return {
    thumbnail: event.instagramEnrichment?.thumbnailUrl ?? null,
    title: event.title,
    subtitle: null,
    badge: null,
    metrics,
    href: `/events/${event.id}`,
  };
}
