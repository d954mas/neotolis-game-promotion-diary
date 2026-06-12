<script lang="ts">
  // TikTokFeedCard — per-platform variant for kind=tiktok_post (D-07: a thin
  // fork of InstagramFeedCard).
  //
  // Composed from $lib/components/feed/parts/BaseFeedCard.svelte so the markup
  // shell + click handling + menu + footer is identical to the default FeedCard.
  // This file enforces the TikTok-specific read paths per AGENTS.md no-denorm:
  //
  //   - sourceLabel: the TikTok handle/displayName from data_sources via the
  //     `source` prop (FK lookup at /feed loader time). NEVER from event metadata
  //     — the account owner can rename the handle after the post was logged;
  //     reading from the owning row is the only way to stay fresh. Falls back to
  //     "" when the source row is gone (honest state).
  //   - thumbnail: deriveThumbnailUrl rewrites tiktokEnrichment.thumbnailUrl to the
  //     same-origin proxy /api/tiktok/thumbnail/<awemeId> (10-SPIKE.md Q3 RESOLVED
  //     at Plan 05 UAT: the TikTok CDN cover — tiktokcdn-us.com, signed + expiring,
  //     .awebp — is hotlink-BLOCKED in a real browser, net::ERR_BLOCKED_BY_ORB, so
  //     a raw <img> fails; the proxy re-serves the bytes same-origin, mirroring IG's
  //     #69). BaseFeedCard still carries referrerpolicy=no-referrer + loading=lazy
  //     and swaps to the .card-thumb.empty KindIcon placeholder on <img> onerror
  //     (an expired signed cover → proxy 502 → onerror).
  //   - stats: tiktokEnrichment.stats.{viewCount,likeCount,commentCount,
  //     shareCount} — the post's own polling data (owned by
  //     tiktok_post_snapshots), not denormalized. Metrics-by-presence (D-05):
  //     render a metric ONLY when non-null — a photo-mode post has no views.
  //     THE DELTA vs IG is the SHARES chip (PLAT-02): TikTok is the first
  //     platform to carry a real share count, rendered when shareCount !== null.
  //
  // The 9:16 thumbnail is CENTER-CROPPED to a uniform 4:5 portrait slot for feed-
  // rhythm uniformity (the user explicitly wants this): .card-thumb's 16/9
  // aspect-ratio is overridden to 4/5 for TikTok cards only (scoped to
  // [data-kind="tiktok_post"]); object-fit: cover + object-position: center
  // (BaseFeedCard's .card-thumb tokens) does the center-crop.
  //
  // Registered via ./index.ts as `cardComponent` so /feed/+page.svelte's
  // `getCardComponent("tiktok_post")` returns this component.

  import BaseFeedCard from "$lib/components/feed/parts/BaseFeedCard.svelte";
  import StatChips from "$lib/components/feed/parts/StatChips.svelte";
  import { deriveMediaTypeOverlay } from "$lib/components/feed/parts/media-type-overlay.js";
  import {
    deriveThumbnailUrl,
    formatStat,
    tiktokHandleLabel,
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

  const sourceLabel = $derived.by((): string => tiktokHandleLabel(source ?? null));

  // CDN-hotlink expiry → null thumbnail → BaseFeedCard renders the
  // .card-thumb.empty KindIcon placeholder. `thumbErrored` latches on the <img>
  // onerror so a transient placeholder doesn't flicker back.
  let thumbErrored = $state(false);
  const thumbnailUrl = $derived.by(() =>
    thumbErrored ? null : deriveThumbnailUrl(event as CardEventLite),
  );

  const stats = $derived(event.tiktokEnrichment?.stats ?? null);

  // Media-type pill (short / carousel). The kind→pill decision lives in ONE
  // shared place (deriveMediaTypeOverlay) used by the feed cards AND the event
  // detail. BaseFeedCard renders the icon+text pill over the thumbnail image
  // only — gated on a present <img> — so the empty placeholder stays clean.
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
    <!-- The DELTA vs IG is the SHARES chip (PLAT-02): TikTok is the first platform
         to surface a real share count, presence-gated like the others. -->
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
  /* THE one new aspect ratio: override .card-thumb's 16/9 to 4/5 for TikTok
   * cards ONLY. Scoped to the BaseFeedCard article's data-kind so every other
   * token (background, border, radius, overflow, object-fit: cover,
   * object-position: center) is reused unchanged — that reuse is what
   * center-crops the native 9:16 cover into the 4:5 portrait slot. */
  :global([data-kind="tiktok_post"] .card-thumb) {
    aspect-ratio: 4 / 5;
  }
</style>
