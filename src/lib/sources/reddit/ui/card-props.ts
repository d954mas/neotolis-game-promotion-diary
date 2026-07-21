// Reddit ui/card-props.ts — per-source toCardProps mapper (fork of twitter/
// ui/card-props.ts, trimmed to the D-09 like/comment metric set).
//
// Pure function — no Svelte component imports — safe to call from
// +page.server.ts loaders. (SvelteKit pre-render crashes when a server module
// transitively imports a .svelte file outside a Svelte context.)
//
// The shape produced matches src/lib/sources/card-props.ts (CardProps). The
// universal <EventCard.svelte> shell consumes this shape; the per-source
// override (RedditFeedCard) is the actual /feed surface.
//
// Metrics-by-presence (D-09): a metric is pushed ONLY when its value is non-null
// — a metric-less post carries null → omitted, never 0. Reddit exposes exactly TWO
// metrics (likes = score, comments = num_comments); it has NO view count and NO
// share/crosspost count (12-SPIKE Q4), so — unlike Twitter/TikTok — there is NO
// views chip and NO shares chip. The Reddit enrichment lives on the decorated dto
// under `redditEnrichment` (set by ./server/feed-enrichment.ts).
import type { CardProps } from "$lib/sources/card-props.js";
import { m } from "$lib/paraglide/messages.js";
// Shared K/M stat formatter (loader-safe: derive-card-data imports only the pure
// telegram-handle util). One spelling across every feed card mapper.
import { formatStat } from "$lib/components/feed/parts/derive-card-data.js";

interface RedditEventLite {
  id: string;
  title: string;
  redditEnrichment?: {
    stats: {
      likeCount: number | null;
      commentCount: number | null;
    } | null;
    thumbnailUrl: string | null;
    mediaType: string | null;
  };
}

export function toCardProps(event: RedditEventLite): CardProps {
  const stats = event.redditEnrichment?.stats ?? null;
  const metrics: CardProps["metrics"] = [];
  if (stats) {
    // Score (= Reddit net ups, the `likeCount` field) and comments render whenever
    // present. Reddit-namespaced labels (card_reddit_metric_*) — NOT the YouTube keys —
    // so a YouTube copy change never leaks into the Reddit card. NO views chip and NO
    // shares chip (D-09 — Reddit exposes neither).
    if (stats.likeCount !== null) {
      metrics.push({ label: m.card_reddit_metric_score(), value: formatStat(stats.likeCount) });
    }
    if (stats.commentCount !== null) {
      metrics.push({
        label: m.card_reddit_metric_comments(),
        value: formatStat(stats.commentCount),
      });
    }
  }
  return {
    // Null for a self/link post (no image) → the card renders text-only (adaptive).
    thumbnail: event.redditEnrichment?.thumbnailUrl ?? null,
    title: event.title,
    subtitle: null,
    badge: null,
    metrics,
    href: `/events/${event.id}`,
  };
}
