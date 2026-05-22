<script lang="ts">
  // RedditFeedCard — per-platform variant for kind=reddit_post.
  //
  // Composed from $lib/components/feed/parts/BaseFeedCard.svelte so the
  // markup shell + click handling + menu + footer is identical to the
  // default FeedCard. This file enforces the Reddit-specific read paths:
  //
  //   - sourceLabel: `r/{event.metadata.subreddit}`. SAFE to read from
  //     event metadata per AGENTS.md — subreddit slug is intrinsic to
  //     the Reddit URL and Reddit forbids subreddit rename. The value
  //     cannot drift from the post.
  //   - bylineLabel: `/u/{event.metadata.author}`. Author handle is the
  //     user's identifier at post-time; the post URL doesn't carry it
  //     but the metadata snapshot is intrinsic to who posted (Reddit
  //     usernames are permanent).
  //   - stats: event.redditEnrichment.stats (score / numComments /
  //     upvoteRatio). Populated by ./server/feed-enrichment.ts via JOIN
  //     with reddit_post_snapshots — the post's own polling data,
  //     owned here, not denormalized from another table.
  //   - thumbnail: redditEnrichment.linkUrl when isImageLikeUrl() (Reddit
  //     CDN host or known image extension); else metadata.media.url
  //     when present. Default-FeedCard would render the same — kept
  //     here so the Reddit card stays a complete read-path island.
  //
  // Underperforming-baseline badge surfaces when the current score is
  // BELOW the 24h median across the user's history AND we have at
  // least 5 baseline samples. UAT-validated thresholds.
  //
  // Registered via ./index.ts as `cardComponent` so /feed/+page.svelte's
  // `getCardComponent("reddit_post")` returns this component.

  import { m } from "$lib/paraglide/messages.js";
  import BaseFeedCard from "$lib/components/feed/parts/BaseFeedCard.svelte";
  import {
    deriveThumbnailUrl,
    redditAuthorByline,
    redditSubredditLabel,
    type CardEventLite,
    type CardSourceLite,
  } from "$lib/components/feed/parts/derive-card-data.js";

  type GameLite = { id: string; title: string };

  let {
    event,
    source,
    games,
    onChanged,
    selected = false,
    anySelected = false,
    view = "feed",
    onToggleSelect,
    onOpenDetail,
    onOpenGamesPickerForCard,
    onDelete,
    onRestore,
    onDeleteForever,
    currentUserName,
  }: {
    event: CardEventLite;
    /** Source prop accepted for prop-shape parity with the default
     *  FeedCard / YoutubeFeedCard. Reddit sourceLabel is derived from
     *  event metadata (intrinsic-to-URL), so `source` is unused here. */
    source?: CardSourceLite | null;
    game?: GameLite | null;
    games: GameLite[];
    onChanged?: () => void;
    selected?: boolean;
    anySelected?: boolean;
    view?: "feed" | "trash";
    onToggleSelect?: (id: string, force?: boolean) => void;
    onOpenDetail?: (id: string) => void;
    onOpenGamesPickerForCard?: (id: string) => void;
    onDelete?: (id: string) => Promise<void> | void;
    onRestore?: (id: string) => Promise<void> | void;
    onDeleteForever?: (id: string) => Promise<void> | void;
    currentUserName?: string;
  } = $props();

  // r/<subreddit>. Reddit's subreddit slug is part of the canonical
  // URL and forbidden to rename — safe to read from event metadata.
  const sourceLabel = $derived.by((): string => {
    const fromMetadata = redditSubredditLabel(event.metadata);
    if (fromMetadata.length > 0) return fromMetadata;
    // Fallback: data_sources.displayName when subreddit absent
    // (community-tracking source registered without a specific post).
    return source?.displayName ?? source?.handleUrl ?? "";
  });

  // /u/<author>. Reddit usernames are permanent; the metadata snapshot
  // captures who posted at post-time.
  const bylineLabel = $derived.by(() => redditAuthorByline(event.metadata));

  const thumbnailUrl = $derived.by(() => deriveThumbnailUrl(event));

  // Underperforming-baseline math — fires only when we have BOTH a
  // snapshot AND a baseline with at least 5 historical samples.
  const baselineState = $derived.by(() => {
    const rstats = event.redditEnrichment?.stats ?? null;
    const rbaseline = event.redditEnrichment?.baseline ?? null;
    const underperforming =
      rstats !== null &&
      rbaseline !== null &&
      rbaseline.sampleSize >= 5 &&
      rbaseline.medianScore24h !== null &&
      rstats.score < rbaseline.medianScore24h;
    const baselinePct =
      rstats !== null &&
      rbaseline !== null &&
      rbaseline.medianScore24h !== null &&
      rbaseline.medianScore24h > 0
        ? Math.round((rstats.score / rbaseline.medianScore24h) * 100)
        : null;
    return { rstats, underperforming, baselinePct };
  });
</script>

<BaseFeedCard
  {event}
  {sourceLabel}
  {bylineLabel}
  {thumbnailUrl}
  {games}
  {onChanged}
  {selected}
  {anySelected}
  {view}
  {onToggleSelect}
  {onOpenDetail}
  {onOpenGamesPickerForCard}
  {onDelete}
  {onRestore}
  {onDeleteForever}
  {currentUserName}
  statsSlot={statsSnippet}
  extraSlot={extraSnippet}
/>

{#snippet statsSnippet()}
  {#if baselineState.rstats}
    <div class="card-stats stats-line">
      <span class="stat"
        >{m.feed_card_reddit_stats({
          score: baselineState.rstats.score,
          comments: baselineState.rstats.numComments,
          ratio: Math.round(baselineState.rstats.upvoteRatio * 100),
        })}</span
      >
    </div>
  {/if}
{/snippet}

{#snippet extraSnippet()}
  {#if baselineState.underperforming && baselineState.baselinePct !== null}
    <div class="reddit-baseline-badge">
      <span class="badge badge-warning"
        >{m.feed_card_reddit_baseline_underperforming({
          pct: baselineState.baselinePct,
        })}</span
      >
    </div>
  {/if}
{/snippet}
