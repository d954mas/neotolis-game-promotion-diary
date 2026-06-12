// TikTok ui/card-props.ts — per-source toCardProps mapper (fork of instagram/
// ui/card-props.ts with the PLAT-02 shares chip — the delta vs IG).
//
// Pure function — no Svelte component imports — safe to call from
// +page.server.ts loaders. (SvelteKit pre-render crashes when a server module
// transitively imports a .svelte file outside a Svelte context.)
//
// The shape produced matches src/lib/sources/card-props.ts (CardProps). The
// universal <EventCard.svelte> shell consumes this shape; the per-source
// override (TikTokFeedCard) is the actual /feed surface.
//
// Metrics-by-presence (D-05): a metric is pushed ONLY when its value is
// non-null — photo-mode posts carry no views (null → omitted, never 0). The
// DELTA vs IG is the SHARES chip: TikTok is the first platform to expose a real
// share count (PLAT-02), pushed when shareCount !== null. The TikTok enrichment
// lives on the decorated dto under `tiktokEnrichment` (set by
// ./server/feed-enrichment.ts).
import type { CardProps } from "$lib/sources/card-props.js";
import { m } from "$lib/paraglide/messages.js";
// Shared K/M stat formatter (loader-safe: derive-card-data imports only the pure
// telegram-handle util). One spelling across YoutubeFeedCard / RedditFeedCard /
// the IG + TikTok card mappers.
import { formatStat } from "$lib/components/feed/parts/derive-card-data.js";

interface TikTokEventLite {
  id: string;
  title: string;
  tiktokEnrichment?: {
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

export function toCardProps(event: TikTokEventLite): CardProps {
  const stats = event.tiktokEnrichment?.stats ?? null;
  const metrics: CardProps["metrics"] = [];
  if (stats) {
    // Videos expose play_count → views chip; photo-mode posts may not (null →
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
    // PLAT-02 DELTA vs IG: the shares chip. Presence-gated like the others — a
    // photo-mode post with no shares carries null → omitted, never rendered as 0.
    if (stats.shareCount !== null) {
      metrics.push({ label: m.card_tiktok_metric_shares(), value: formatStat(stats.shareCount) });
    }
  }
  return {
    thumbnail: event.tiktokEnrichment?.thumbnailUrl ?? null,
    title: event.title,
    subtitle: null,
    badge: null,
    metrics,
    href: `/events/${event.id}`,
  };
}
