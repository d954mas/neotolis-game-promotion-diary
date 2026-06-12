// YouTube ui/card-props.ts — per-source toCardProps mapper.
//
// Pure function — no Svelte component imports — safe to call from
// +page.server.ts loaders. (SvelteKit pre-render crashes when a server
// module transitively imports a .svelte file outside a Svelte context.)
//
// The shape produced matches src/lib/sources/card-props.ts (CardProps).
// The universal <EventCard.svelte> shell consumes this shape; the
// per-source override escape hatch is available but currently unused.
import type { CardProps } from "$lib/sources/card-props.js";
import { m } from "$lib/paraglide/messages.js";
// Shared K/M stat formatter (loader-safe: derive-card-data imports only the pure
// telegram-handle util). One spelling across every feed card mapper.
import { formatStat } from "$lib/components/feed/parts/derive-card-data.js";

interface YoutubeEventLite {
  id: string;
  externalId: string | null;
  title: string;
  authorIsMe: boolean;
  stats?: { viewCount: number; likeCount: number; commentCount: number } | null;
}

// Card content is end-user-visible; per-platform adapters localize via
// shared Paraglide keys (card_<platform>_*) so future locales just
// translate the keys without touching adapter code.
export function toCardProps(event: YoutubeEventLite): CardProps {
  return {
    thumbnail: event.externalId
      ? `https://img.youtube.com/vi/${event.externalId}/mqdefault.jpg`
      : null,
    title: event.title,
    subtitle: event.authorIsMe ? m.card_youtube_subtitle_mine() : null,
    badge: event.authorIsMe ? m.card_youtube_badge_mine() : null,
    metrics: event.stats
      ? [
          { label: m.card_youtube_metric_views(), value: formatStat(event.stats.viewCount) },
          { label: m.card_youtube_metric_likes(), value: formatStat(event.stats.likeCount) },
          {
            label: m.card_youtube_metric_comments(),
            value: formatStat(event.stats.commentCount),
          },
        ]
      : [],
    href: `/events/${event.id}`,
  };
}
