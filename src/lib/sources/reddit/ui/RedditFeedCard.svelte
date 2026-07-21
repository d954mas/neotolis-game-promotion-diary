<script lang="ts">
  // RedditFeedCard — per-platform variant for kind=reddit_post (D-06: an ADAPTIVE
  // self / link / image / gallery card forked from TwitterFeedCard).
  //
  // Composed from $lib/components/feed/parts/BaseFeedCard.svelte so the markup shell
  // + click handling + menu + footer is identical to the default FeedCard. This file
  // enforces the Reddit read paths per AGENTS.md no-denorm AND the adaptive layout:
  //
  //   - sourceLabel: the subreddit slug (r/<sub>) — intrinsic to the Reddit URL and
  //     rename-proof (Reddit forbids subreddit rename), the ONLY safe denormalization
  //     — or the account handle/displayName from data_sources via the `source` prop
  //     (FK lookup at /feed loader time). Falls back to the URL-intrinsic slug from
  //     event metadata, never a renameable display value.
  //   - thumbnail: redditEnrichment.thumbnailUrl — the raw i.redd.it cover HOTLINKED
  //     directly (12-SPIKE Pitfall 5 — NO same-origin proxy; image/gallery variant
  //     un-sampled by the spike, owed at the Plan 12-06 UAT via the browser hotlink
  //     test). FREQUENTLY NULL (ScrapeCreators omits `thumbnail`; only image/gallery
  //     posts derive one). BaseFeedCard carries referrerpolicy=no-referrer +
  //     loading=lazy and swaps to the .card-thumb.empty KindIcon placeholder on <img>
  //     onerror (an expired CDN cover OR a blocked hotlink — the latched fallback).
  //   - stats: redditEnrichment.stats.{likeCount,commentCount} — the post's own polling
  //     data (owned by reddit_post_snapshots), not denormalized. Metrics-by-presence
  //     (D-09): render a metric ONLY when non-null. Reddit exposes exactly TWO metrics
  //     — NO views chip, NO shares chip (Reddit surfaces neither, 12-SPIKE Q4).
  //
  //   - ADAPTIVE D-06 layout: an IMAGE / GALLERY post (redditEnrichment.thumbnailUrl
  //     present) renders the hotlinked cover + the post title; a SELF (text) or LINK
  //     post (thumbnailUrl null) is text-forward — we pass thumbnailUrl={null} so the
  //     empty thumbnail slot never renders and the title/notes are the focal point.
  //     reddit_post is NOT a media-shape kind, so BaseFeedCard only reserves the thumb
  //     slot when thumbnailUrl is non-null — passing null collapses it.
  //
  // Registered via ./index.ts as `cardComponent` so /feed/+page.svelte's
  // `getCardComponent("reddit_post")` returns this component.

  import BaseFeedCard from "$lib/components/feed/parts/BaseFeedCard.svelte";
  import StatChips from "$lib/components/feed/parts/StatChips.svelte";
  import { deriveMediaTypeOverlay } from "$lib/components/feed/parts/media-type-overlay.js";
  import {
    formatStat,
    redditSubredditLabel,
    type CardEventLite,
    type CardSourceLite,
  } from "$lib/components/feed/parts/derive-card-data.js";

  type GameLite = { id: string; title: string };

  let {
    event,
    source,
    games,
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
    source?: CardSourceLite | null;
    game?: GameLite | null;
    games: GameLite[];
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

  // Subreddit slug / handle from the FK source-of-truth (data_sources via `source`
  // prop), falling back to the r/<sub> slug the URL carries (redditSubredditLabel
  // reads event metadata only as the URL-intrinsic, rename-proof last resort).
  const sourceLabel = $derived.by(
    (): string =>
      source?.channelTitle ?? source?.displayName ?? redditSubredditLabel(event.metadata),
  );

  // D-06 adaptive: a self/link post (thumbnailUrl null) is text-only → render
  // text-forward (no thumbnail slot). An image/gallery post shows the hotlinked
  // i.redd.it cover on top.
  const rawThumb = $derived(event.redditEnrichment?.thumbnailUrl ?? null);
  const isTextOnly = $derived(rawThumb === null);

  // Hotlink expiry OR a blocked i.redd.it fetch → the onerror latch → null thumbnail →
  // BaseFeedCard renders the .card-thumb.empty KindIcon placeholder. `thumbErrored`
  // latches on the <img> onerror so a transient placeholder doesn't flicker back.
  let thumbErrored = $state(false);
  const thumbnailUrl = $derived.by(() => (isTextOnly || thumbErrored ? null : rawThumb));

  const stats = $derived(event.redditEnrichment?.stats ?? null);

  // Media-type pill (gallery → "Carousel"). A self / link / single-image post maps to
  // null → no pill. The kind→pill decision lives in ONE shared place
  // (deriveMediaTypeOverlay) used by the feed cards AND the event detail. BaseFeedCard
  // renders the icon+text pill over a present <img> only.
  const overlay = $derived.by(() => deriveMediaTypeOverlay(event));
</script>

<BaseFeedCard
  {event}
  {sourceLabel}
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
  thumbnailOverlay={overlay}
  onThumbnailError={() => (thumbErrored = true)}
/>

{#snippet statsSnippet()}
  {#if stats && (stats.likeCount !== null || stats.commentCount !== null)}
    <!-- Reddit exposes exactly TWO metrics: likes (= score / net ups) + comments,
         each presence-gated. NO views chip, NO shares chip (Reddit surfaces neither,
         12-SPIKE Q4 / D-09). -->
    <div class="card-stats stats-line">
      <StatChips
        chips={[
          { metric: "likes", value: stats.likeCount === null ? null : formatStat(stats.likeCount) },
          {
            metric: "comments",
            value: stats.commentCount === null ? null : formatStat(stats.commentCount),
          },
        ]}
      />
    </div>
  {/if}
{/snippet}
