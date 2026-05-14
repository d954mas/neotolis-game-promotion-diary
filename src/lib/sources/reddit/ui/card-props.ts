// Reddit ui/card-props.ts — per-source toCardProps mapper.
//
// Pure function — no Svelte component imports — safe to call from
// +page.server.ts loaders. (SvelteKit pre-render crashes when a server
// module transitively imports a .svelte file outside a Svelte context.)
//
// Maps a reddit_post EventDto (decorated by feed-enrichment.ts with the
// `redditEnrichment` field) to the universal CardProps shape consumed by
// EventCard.svelte.
//
// Per D-RDT-SOURCE-DISPLAY:
//   - Author chip: `/u/<author>` (🧑 icon — rendered by FeedCard alongside
//     the source row context).
//   - Subreddit chip: `/r/<subreddit>` (🏛 icon).
//   - Stats line: `↑<score> 💬<num_comments> (<upvote_ratio>%)`.
//   - Underperforming-median badge (D-RDT-BASELINES-DISPLAY) when the
//     latest score < median_score_24h AND sample_size >= 5.
//
// The universal CardProps shape carries: thumbnail / title / subtitle /
// badge / metrics[] / href. We map Reddit's emoji-flavoured display via
// the metrics[] array (labels are Paraglide keys so future locales just
// translate). The author + sub chips render in the FeedCard via the
// event's metadata.author / metadata.subreddit fields (FeedCard reads
// these directly — same pattern as YouTube's channelTitle).

import type { CardProps } from "$lib/sources/card-props.js";
import { m } from "$lib/paraglide/messages.js";

interface RedditEventLite {
  id: string;
  externalId: string | null;
  title: string;
  authorIsMe: boolean;
  /** Decoration written by ./server/feed-enrichment.ts enrichRedditFeedDtos.
   *  Optional — if missing, the card renders without stats (e.g. on the
   *  brief window between INSERT and the first worker drain). */
  redditEnrichment?: {
    stats: {
      score: number;
      numComments: number;
      upvoteRatio: number;
      awardsTotal: number;
    } | null;
    subredditSubscribers: number | null;
    authorKarma: number | null;
    baseline: {
      medianScore24h: number | null;
      p75Score24h: number | null;
      sampleSize: number;
    } | null;
  };
}

/** Map a reddit_post event DTO to the FeedCard render shape.
 *  Card content is end-user-visible; per-platform adapters localize via
 *  shared Paraglide keys (card_reddit_*) so future locales just
 *  translate the keys without touching adapter code. */
export function toCardProps(event: RedditEventLite): CardProps {
  const stats = event.redditEnrichment?.stats ?? null;
  const baseline = event.redditEnrichment?.baseline ?? null;

  // Underperforming-median badge (D-RDT-BASELINES-DISPLAY). Only fires
  // when we have BOTH a snapshot AND a baseline with the threshold
  // sample size. "Mine" badge takes precedence (matches the YouTube
  // priority — owner identity is the load-bearing chip).
  const isUnderperforming =
    stats !== null &&
    baseline !== null &&
    baseline.medianScore24h !== null &&
    baseline.sampleSize >= 5 &&
    stats.score < baseline.medianScore24h;

  return {
    // Reddit doesn't have a per-post thumbnail surface as cleanly as
    // YouTube's `i.ytimg.com/vi/{id}/...` pattern. Posts may carry a
    // preview image in metadata.preview_url, but the canonical card
    // surface in v0.1 is text-first; thumbnail stays null.
    thumbnail: null,
    title: event.title,
    subtitle: event.authorIsMe ? m.card_reddit_subtitle_mine() : null,
    badge: event.authorIsMe
      ? m.card_reddit_badge_mine()
      : isUnderperforming
        ? "⚠ Underperforming median"
        : null,
    metrics: stats
      ? [
          { label: m.card_reddit_metric_score(), value: formatStat(stats.score) },
          {
            label: m.card_reddit_metric_comments(),
            value: formatStat(stats.numComments),
          },
          {
            label: m.card_reddit_metric_upvote_ratio(),
            value: `${Math.round(stats.upvoteRatio * 100)}%`,
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
