<script lang="ts">
  // TwitterFeedCard — per-platform variant for kind=twitter_post (D-06: an
  // ADAPTIVE media/text card forked from TelegramFeedCard).
  //
  // Composed from $lib/components/feed/parts/BaseFeedCard.svelte so the markup
  // shell + click handling + menu + footer is identical to the default FeedCard.
  // This file enforces the Twitter read paths per AGENTS.md no-denorm AND the
  // D-06 adaptive layout:
  //
  //   - sourceLabel: the Twitter @handle/displayName from data_sources via the
  //     `source` prop (FK lookup at /feed loader time). NEVER from event metadata
  //     — the account owner can rename the @handle after the tweet was logged;
  //     reading from the owning row is the only way to stay fresh. Falls back to
  //     "" when the source row is gone (honest state).
  //   - thumbnail: twitterEnrichment.thumbnailUrl — the RAW pbs.twimg.com cover
  //     (photo or video poster) HOTLINKED directly (11-SPIKE.md Q6 — pbs.twimg.com
  //     is historically permissive, no Cross-Origin-Resource-Policy: same-origin,
  //     so NO same-origin proxy, unlike TikTok/IG). BaseFeedCard carries
  //     referrerpolicy=no-referrer + loading=lazy and swaps to the
  //     .card-thumb.empty KindIcon placeholder on <img> onerror (an expired CDN
  //     cover OR — should the Q6 UAT find it CORP-blocked — the latched fallback).
  //   - stats: twitterEnrichment.stats.{viewCount,likeCount,commentCount,
  //     shareCount} — the tweet's own polling data (owned by
  //     twitter_post_snapshots), not denormalized. Metrics-by-presence (D-05):
  //     render a metric ONLY when non-null — a protected/limited tweet may hide
  //     impressions. shareCount is the DERIVED retweet+quote sum (D-05).
  //
  //   - ADAPTIVE D-06 layout: a MEDIA tweet (twitterEnrichment.thumbnailUrl
  //     present) renders the cover CENTER-CROPPED to a uniform 4:5 portrait slot
  //     (the [data-kind="twitter_post"] .card-thumb aspect-ratio override +
  //     object-fit: cover) + the tweet text; a TEXT-ONLY tweet (thumbnailUrl null)
  //     is text-forward — we pass thumbnailUrl={null} so the empty thumbnail slot
  //     never renders and the title/notes are the focal point. twitter_post is NOT
  //     a media-shape kind (isMediaShape returns false), so BaseFeedCard only
  //     reserves the thumb slot when thumbnailUrl is non-null — passing null
  //     collapses it (the Telegram-card pattern).
  //
  // Registered via ./index.ts as `cardComponent` so /feed/+page.svelte's
  // `getCardComponent("twitter_post")` returns this component.

  import BaseFeedCard from "$lib/components/feed/parts/BaseFeedCard.svelte";
  import StatChips from "$lib/components/feed/parts/StatChips.svelte";
  import { deriveMediaTypeOverlay } from "$lib/components/feed/parts/media-type-overlay.js";
  import {
    formatStat,
    twitterHandleLabel,
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

  // Handle/display name from the FK source-of-truth (data_sources via `source`
  // prop), falling back to the @handle the URL carries (twitterHandleLabel reads
  // event metadata only as the URL-intrinsic last resort, never a display value).
  const sourceLabel = $derived.by(
    (): string => source?.channelTitle ?? source?.displayName ?? twitterHandleLabel(event.metadata),
  );

  // D-06 adaptive: a tweet with NO media (thumbnailUrl null) is text-only → render
  // text-forward (no thumbnail slot). A tweet WITH media (photo/video poster) shows
  // the hotlinked pbs.twimg.com cover on top, center-cropped to 4:5.
  const rawThumb = $derived(event.twitterEnrichment?.thumbnailUrl ?? null);
  const isTextOnly = $derived(rawThumb === null);

  // Hotlink expiry OR — should the Q6 UAT find pbs.twimg.com CORP-blocked — the
  // onerror latch → null thumbnail → BaseFeedCard renders the .card-thumb.empty
  // KindIcon placeholder. `thumbErrored` latches on the <img> onerror so a
  // transient placeholder doesn't flicker back.
  let thumbErrored = $state(false);
  const thumbnailUrl = $derived.by(() => (isTextOnly || thumbErrored ? null : rawThumb));

  const stats = $derived(event.twitterEnrichment?.stats ?? null);

  // Media-type pill (video). A photo / text-only tweet maps to null → no pill. The
  // kind→pill decision lives in ONE shared place (deriveMediaTypeOverlay) used by
  // the feed cards AND the event detail. BaseFeedCard renders the icon+text pill
  // over a present <img> only.
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
  {#if stats && (stats.viewCount !== null || stats.likeCount !== null || stats.commentCount !== null || stats.shareCount !== null)}
    <!-- Twitter exposes FOUR metrics incl the DERIVED shares (retweet+quote, D-05),
         each presence-gated like the others (a protected tweet may hide views). -->
    <div class="card-stats stats-line">
      <StatChips
        chips={[
          { metric: "views", value: stats.viewCount === null ? null : formatStat(stats.viewCount) },
          { metric: "likes", value: stats.likeCount === null ? null : formatStat(stats.likeCount) },
          {
            metric: "comments",
            value: stats.commentCount === null ? null : formatStat(stats.commentCount),
          },
          {
            metric: "shares",
            value: stats.shareCount === null ? null : formatStat(stats.shareCount),
          },
        ]}
      />
    </div>
  {/if}
{/snippet}

<style>
  /* THE one new aspect ratio: override .card-thumb's 16/9 to 4/5 for Twitter
   * cards ONLY (a MEDIA tweet). Scoped to the BaseFeedCard article's data-kind so
   * every other token (background, border, radius, overflow, object-fit: cover,
   * object-position: center) is reused unchanged — that reuse is what center-crops
   * the native cover into the 4:5 portrait slot for feed-rhythm uniformity. A
   * text-only tweet passes thumbnailUrl={null}, so this slot never renders. */
  :global([data-kind="twitter_post"] .card-thumb) {
    aspect-ratio: 4 / 5;
  }
</style>
