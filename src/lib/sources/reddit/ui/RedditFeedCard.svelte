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

  // r/<subreddit>. Read from reddit_posts.subreddit via redditEnrichment
  // (set by feed-enrichment JOIN). reddit_posts is the source-of-truth
  // cache row populated by handlePostSingle on every paste / poll;
  // events.metadata.subreddit is a denormalization that we deliberately
  // stop reading. Fallback to data_sources for sub-polled events whose
  // source.displayName carries the slug.
  const sourceLabel = $derived.by((): string => {
    const sub = event.redditEnrichment?.subreddit ?? null;
    if (sub) return `r/${sub}`;
    return source?.displayName ?? source?.handleUrl ?? "";
  });

  // /u/<author>. Same source-of-truth principle — read from
  // reddit_posts.author through enrichment. NULL when the Reddit user
  // has deleted their account (Reddit redacts the field).
  const bylineLabel = $derived.by((): string | null => {
    const a = event.redditEnrichment?.author ?? null;
    return a ? `/u/${a}` : null;
  });

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
  {#if event.redditEnrichment?.deletionDetectedAt}
    <div class="reddit-deleted-banner" role="status">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
        <path d="M10 11v6" /><path d="M14 11v6" />
      </svg>
      <span>Deleted on Reddit</span>
    </div>
  {/if}
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

<style>
  /* Deleted-on-Reddit banner — dashed danger border + danger-tinted
   * fill. Sits between thumbnail and stats via the BaseFeedCard
   * extraSlot. */
  :global(.reddit-deleted-banner) {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: color-mix(in oklab, var(--danger) 14%, var(--surface));
    border: 1px dashed color-mix(in oklab, var(--danger) 60%, var(--border));
    border-radius: var(--r-pill);
    color: var(--danger);
    font-size: var(--t-12);
    font-weight: var(--w-sb);
  }
</style>
