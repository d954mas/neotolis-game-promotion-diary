// Telegram ui/card-props.ts — per-source toCardProps mapper.
//
// Pure function — no Svelte component imports — safe to call from
// +page.server.ts loaders. (SvelteKit pre-render crashes when a server
// module transitively imports a .svelte file outside a Svelte context.)
//
// The shape produced matches src/lib/sources/card-props.ts (CardProps).
// The universal <EventCard.svelte> shell consumes this shape; the
// per-source override (TelegramFeedCard) is the actual /feed surface.
//
// Metrics-by-presence (D-05): the SINGLE views chip is pushed ONLY when
// viewCount is non-null — a very-new / views-hidden post carries null
// views, which is omitted (never rendered as 0). Telegram is views-only
// (D-04) — NO likes / comments / shares chips. The Telegram enrichment
// lives on the decorated dto under `telegramEnrichment` (set by
// ./server/feed-enrichment.ts).
import type { CardProps } from "$lib/sources/card-props.js";
import { m } from "$lib/paraglide/messages.js";

interface TelegramEventLite {
  id: string;
  title: string;
  telegramEnrichment?: {
    stats: {
      viewCount: number | null;
      polledAt: Date;
    } | null;
    thumbnailUrl: string | null;
    mediaKind: string | null;
  };
}

export function toCardProps(event: TelegramEventLite): CardProps {
  const stats = event.telegramEnrichment?.stats ?? null;
  const metrics: CardProps["metrics"] = [];
  // Telegram exposes ONLY a view count (D-04). A null view count (very new
  // post / views hidden) is omitted — never a 0-for-absent (D-05).
  if (stats && stats.viewCount !== null) {
    metrics.push({ label: m.card_youtube_metric_views(), value: formatStat(stats.viewCount) });
  }
  return {
    thumbnail: event.telegramEnrichment?.thumbnailUrl ?? null,
    title: event.title,
    subtitle: null,
    badge: null,
    metrics,
    href: `/events/${event.id}`,
  };
}

function formatStat(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
