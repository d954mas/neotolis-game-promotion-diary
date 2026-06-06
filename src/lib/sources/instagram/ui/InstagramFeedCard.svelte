<script lang="ts">
  // InstagramFeedCard — per-platform variant for kind=instagram_post.
  //
  // Composed from $lib/components/feed/parts/BaseFeedCard.svelte so the
  // markup shell + click handling + menu + footer is identical to the
  // default FeedCard. This file enforces the Instagram-specific read paths
  // per AGENTS.md no-denormalization rule:
  //
  //   - sourceLabel: the IG handle/displayName from data_sources via the
  //     `source` prop (FK lookup at /feed loader time). NEVER from event
  //     metadata — the account owner can rename the handle after the post
  //     was logged; reading from the owning row is the only way to stay
  //     fresh. Mirror youtubeChannelLabel's fallback (channelTitle →
  //     displayName → handleUrl). Falls back to "" when the source row is
  //     gone (honest state — we can't claim a name we don't own).
  //   - thumbnail: instagramEnrichment.thumbnailUrl — the fresh CDN hotlink
  //     (D-08), refreshed every poll by the snapshot writer. Hotlinked
  //     (referrerpolicy=no-referrer, loading=lazy) per CONTEXT D-08. The
  //     CDN URL expires; onerror swaps to the .card-thumb.empty placeholder
  //     (no broken image, no error text).
  //   - stats: instagramEnrichment.stats.{viewCount,likeCount,commentCount}
  //     — the post's own polling data (owned by instagram_post_snapshots),
  //     not denormalized. Metrics-by-presence (D-05): render a metric ONLY
  //     when non-null — reels carry views (play_count), photos/carousels do
  //     not. Never a 0-or-dash for an absent metric; shares never rendered.
  //
  // The 4:5 thumbnail is the IG card's PRIMARY visual focal point (UI-SPEC):
  // .card-thumb's 16/9 aspect-ratio is overridden to 4/5 for IG cards only
  // (scoped to [data-kind="instagram_post"]); every other .card-thumb token
  // (background, border, radius, overflow, object-fit: cover) is reused.
  //
  // Registered via ./index.ts as `cardComponent` so /feed/+page.svelte's
  // `getCardComponent("instagram_post")` returns this component.

  import { metricColor } from "$lib/util/metric-colors.js";
  import BaseFeedCard from "$lib/components/feed/parts/BaseFeedCard.svelte";
  import { deriveMediaTypeOverlay } from "$lib/components/feed/parts/media-type-overlay.js";
  import {
    deriveThumbnailUrl,
    formatStat,
    instagramHandleLabel,
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

  const sourceLabel = $derived.by((): string => instagramHandleLabel(source ?? null));

  // CDN-hotlink expiry → null thumbnail → BaseFeedCard renders the
  // .card-thumb.empty KindIcon placeholder (D-08). `thumbErrored` latches
  // on the <img> onerror so a transient placeholder doesn't flicker back.
  let thumbErrored = $state(false);
  const thumbnailUrl = $derived.by(() =>
    thumbErrored ? null : deriveThumbnailUrl(event as CardEventLite),
  );

  const stats = $derived(event.instagramEnrichment?.stats ?? null);

  // Media-type pill (reel / carousel / video). A bare photo maps to null → no
  // pill. The kind→pill decision lives in ONE shared place
  // (deriveMediaTypeOverlay) used by the feed cards AND the event detail.
  // BaseFeedCard renders the icon+text pill (ONE shared treatment) over the
  // thumbnail image only — gated on a present <img> — so the empty placeholder
  // stays clean.
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
  {#if stats && (stats.viewCount !== null || stats.likeCount !== null || stats.commentCount !== null)}
    <div class="card-stats stats-line">
      {#if stats.viewCount !== null}
        <span class="stat">
          <svg
            class="stat-icon"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
            style={`color:${metricColor("views")}`}
          >
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <span class="num">{formatStat(stats.viewCount)}</span>
        </span>
      {/if}
      {#if stats.likeCount !== null}
        <span class="stat">
          <svg
            class="stat-icon"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
            style={`color:${metricColor("likes")}`}
          >
            <path
              d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"
            />
          </svg>
          <span class="num">{formatStat(stats.likeCount)}</span>
        </span>
      {/if}
      {#if stats.commentCount !== null}
        <span class="stat">
          <svg
            class="stat-icon"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
            style={`color:${metricColor("comments")}`}
          >
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <span class="num">{formatStat(stats.commentCount)}</span>
        </span>
      {/if}
    </div>
  {/if}
{/snippet}

<style>
  /* THE one new aspect ratio (UI-SPEC): override .card-thumb's 16/9 to 4/5
   * for IG cards ONLY. Scoped to the BaseFeedCard article's data-kind so
   * every other token (background, border, radius, overflow, object-fit:
   * cover) is reused unchanged. The 4:5 portrait slot is the IG card's
   * primary visual focal point. */
  :global([data-kind="instagram_post"] .card-thumb) {
    aspect-ratio: 4 / 5;
  }
</style>
