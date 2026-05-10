// YouTube ui/card-props.ts — Phase 03.0.1 D-03 props mapper.
//
// Per-source toCardProps mapper. Pure function — no Svelte component
// imports — safe to call from +page.server.ts loaders (RESEARCH.md
// Pitfall 7: SvelteKit pre-render crashes when a server module
// transitively imports a .svelte file outside a Svelte context).
//
// The shape produced matches src/lib/sources/card-props.ts (CardProps).
// The universal <EventCard.svelte> shell consumes this shape; per-source
// override (D-04 escape hatch) is available but not used in 03.0.1.
import type { CardProps } from "$lib/sources/card-props.js";
import { m } from "$lib/paraglide/messages.js";

interface YoutubeEventLite {
  id: string;
  externalId: string | null;
  title: string;
  authorIsMe: boolean;
  stats?: { viewCount: number; likeCount: number; commentCount: number } | null;
}

// Phase 03.0.1 (post-review P2-6) — Paraglide localization. Pre-fix
// hardcoded English strings ('My video', 'Mine', 'Views', etc.) bypassed
// the message catalog. Card content is end-user-visible; per-platform
// adapters localize via shared Paraglide keys (card_<platform>_*) so
// future locales just translate the keys without touching adapter code.
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

function formatStat(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
