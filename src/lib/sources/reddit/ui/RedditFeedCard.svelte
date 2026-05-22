<script lang="ts">
  // RedditFeedCard — per-platform variant for kind=reddit_post.
  //
  // Composed from $lib/components/feed/parts/BaseFeedCard.svelte so the
  // markup shell + click handling + menu + footer is identical to the
  // default FeedCard. This file enforces the Reddit-specific read paths
  // per AGENTS.md no-denormalization rule — reads ONLY from owning rows
  // (data_sources via the FK on event.sourceId), NEVER from event
  // metadata snapshots:
  //
  //   - sourceLabel: source.displayName ?? source.handleUrl ?? "".
  //     For sub-polled posts the source row is the registered subreddit
  //     (source_kind=reddit_subreddit, handle_url=r/<slug>). For
  //     author-polled posts the source row is the tracked Reddit account
  //     (source_kind=reddit_account). Either way, the canonical display
  //     name is owned by data_sources — one UPDATE there reflects across
  //     every event. Pasted events from unregistered subs/users show no
  //     attribution (honest state — we can't claim a name we don't own).
  //   - bylineLabel: derived from source.handleUrl when source_kind is
  //     reddit_account. (Sub-polled events don't have author attribution
  //     until the post-single fetch creates a per-account source row;
  //     in the meantime byline is empty — same honest state.)
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
    /** Source-of-truth row for sourceLabel (subreddit / account). */
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

  // r/<subreddit>. Strict no-denorm: read ONLY from source-of-truth row.
  // For sub-polled events source_id → data_sources(reddit_subreddit) →
  // displayName carries the subreddit slug. For author-polled events
  // source is the reddit_account row. Paste-flow events from
  // unregistered subs/accounts show no attribution until either:
  //  - the user registers the source in /sources, OR
  //  - a future paste-flow enrichment creates a service-level cache row.
  // Honest state for unregistered sources, mirroring YoutubeFeedCard.
  const sourceLabel = $derived.by(
    (): string => source?.displayName ?? source?.handleUrl ?? "",
  );

  // /u/<author> — same source-of-truth principle. We currently have no
  // reddit_posts cache table that owns per-post author identity; the
  // metadata.author snapshot is a denormalization we deliberately stop
  // reading. Until a per-post or per-author source row exists for the
  // event, byline stays empty (honest state).
  const bylineLabel = $derived.by((): string | null => null);

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
