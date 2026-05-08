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

interface YoutubeEventLite {
  id: string;
  externalId: string | null;
  title: string;
  authorIsMe: boolean;
  stats?: { viewCount: number; likeCount: number; commentCount: number } | null;
}

export function toCardProps(event: YoutubeEventLite): CardProps {
  return {
    thumbnail: event.externalId
      ? `https://img.youtube.com/vi/${event.externalId}/mqdefault.jpg`
      : null,
    title: event.title,
    subtitle: event.authorIsMe ? "My video" : null,
    badge: event.authorIsMe ? "Mine" : null,
    metrics: event.stats
      ? [
          { label: "Views", value: formatStat(event.stats.viewCount) },
          { label: "Likes", value: formatStat(event.stats.likeCount) },
          { label: "Comments", value: formatStat(event.stats.commentCount) },
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
