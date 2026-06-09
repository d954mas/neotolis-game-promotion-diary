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
// Metrics-by-presence (D-05): each chip is pushed ONLY when its count is
// non-null — a very-new / views-hidden / no-reactions post omits the chip
// (never rendered as 0). Telegram exposes TWO metrics (D-04 + E1): views and a
// reaction total — NO likes / comments / shares. The rich top-5 reactions LIST
// (emoji + per-reaction count) is rendered by the per-source TelegramFeedCard;
// this universal-shell mapper carries the aggregate reaction TOTAL as a chip
// (the EventCard shell has no concept of an emoji list). The Telegram
// enrichment lives on the decorated dto under `telegramEnrichment` (set by
// ./server/feed-enrichment.ts).
import type { CardProps } from "$lib/sources/card-props.js";
import { m } from "$lib/paraglide/messages.js";

interface TelegramEventLite {
  id: string;
  title: string;
  telegramEnrichment?: {
    stats: {
      viewCount: number | null;
      reactionsTotal: number | null;
      polledAt: Date;
    } | null;
    thumbnailUrl: string | null;
    mediaKind: string | null;
    reactionsTop?:
      | { emoji: string | null; kind: "standard" | "custom" | "paid"; count: number }[]
      | null;
  };
}

export function toCardProps(event: TelegramEventLite): CardProps {
  const stats = event.telegramEnrichment?.stats ?? null;
  const metrics: CardProps["metrics"] = [];
  // Views chip — null (very new / views hidden) omitted, never 0-for-absent (D-05).
  if (stats && stats.viewCount !== null) {
    metrics.push({ label: m.card_youtube_metric_views(), value: formatStat(stats.viewCount) });
  }
  // Reactions total chip (E1) — null (no reactions block) omitted (D-05). The
  // universal shell shows the aggregate; the per-source card shows the top-5 list.
  if (stats && stats.reactionsTotal !== null) {
    metrics.push({ label: m.chart_metric_reactions(), value: formatStat(stats.reactionsTotal) });
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
