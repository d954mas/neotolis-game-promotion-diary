<script lang="ts">
  // YoutubeFeedCard — per-platform variant for kind=youtube_video.
  //
  // Composed from $lib/components/feed/parts/BaseFeedCard.svelte so the
  // markup shell + click handling + menu + footer is identical to the
  // default FeedCard. This file enforces the YouTube-specific read
  // paths:
  //
  //   - sourceLabel: data_sources.channelTitle via the `source` prop
  //     (FK lookup at /feed loader time). NEVER from event.metadata —
  //     the channel name can be renamed by the YouTube account owner
  //     after the event was logged; reading from the owning row is the
  //     only way to stay fresh. event.channelTitle (now populated by
  //     feed-enrichment JOIN on youtube_channels — no-denorm fix V-1,
  //     see docs/denormalization-policy.md) is the fallback for events
  //     whose source row was deleted (sourceId=null) so the card still
  //     shows a label; data_sources.channelTitle remains the canonical
  //     truth when present.
  //   - thumbnail: img.youtube.com/vi/{externalId}/mqdefault.jpg —
  //     externalId IS the video id, intrinsic to the YouTube URL.
  //   - stats: event.stats.{viewCount,likeCount,commentCount} — these
  //     are owned by youtube_video_snapshots (the video's own polling
  //     data), not duplicated from another table.
  //
  // Registered via ./index.ts as `cardComponent` so /feed/+page.svelte's
  // `getCardComponent("youtube_video")` returns this component instead
  // of the default FeedCard.

  import BaseFeedCard from "$lib/components/feed/parts/BaseFeedCard.svelte";
  import { metricColor } from "$lib/util/metric-colors.js";
  import { mediaTypeOverlay } from "$lib/components/feed/parts/media-type-overlay.js";
  import {
    deriveThumbnailUrl,
    formatStat,
    youtubeChannelLabel,
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
    source: CardSourceLite | null;
    /** Legacy single-game prop kept for prop-shape parity with the
     *  default FeedCard call sites. Unused inside the component —
     *  BaseFeedCard reads `games` for chip rendering. */
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

  // YouTube channel name — read via FK from data_sources.channelTitle.
  // When source is null (deleted source / manual paste before backfill)
  // fall back to event.channelTitle, which the /feed loader populates
  // by JOINing youtube_videos → youtube_channels (source of truth post
  // no-denorm fix V-1, see docs/denormalization-policy.md).
  const sourceLabel = $derived.by((): string => {
    const fromSource = youtubeChannelLabel(source);
    if (fromSource.length > 0) return fromSource;
    return event.channelTitle ?? "";
  });

  const thumbnailUrl = $derived.by(() => deriveThumbnailUrl(event));

  // Media-type pill. Every YouTube video shows the "Video" pill for now — the
  // feed thumbnail alone doesn't tell a Short from a full video. This is THE
  // single derivation point for that decision.
  //
  // TODO: Shorts detection (aspect/duration heuristic) → "short". When the
  // poller starts capturing aspect ratio / duration on youtube_video
  // snapshots, branch here to map verticals to a "short" pill; the glyph
  // catalog in media-type-overlay.ts already carries a short-form ("reel")
  // marker to reuse. No other file needs to change.
  const overlay = $derived.by(() => mediaTypeOverlay("video"));
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
/>

{#snippet statsSnippet()}
  {#if event.stats}
    <div class="card-stats stats-line">
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
        <span class="num">{formatStat(event.stats.viewCount)}</span>
      </span>
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
        <span class="num">{formatStat(event.stats.likeCount)}</span>
      </span>
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
        <span class="num">{formatStat(event.stats.commentCount)}</span>
      </span>
    </div>
  {/if}
{/snippet}
