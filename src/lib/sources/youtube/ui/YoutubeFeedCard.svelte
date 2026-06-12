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
  import StatChips from "$lib/components/feed/parts/StatChips.svelte";
  import { deriveMediaTypeOverlay } from "$lib/components/feed/parts/media-type-overlay.js";
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
  // feed thumbnail alone doesn't tell a Short from a full video. The kind→pill
  // decision lives in ONE shared place (deriveMediaTypeOverlay), used by the
  // feed cards AND the event detail.
  //
  // TODO: Shorts detection (aspect/duration heuristic) → "short". When the
  // poller starts capturing aspect ratio / duration on youtube_video
  // snapshots, branch in deriveMediaTypeOverlay to map verticals to a "short"
  // pill; the glyph catalog in media-type-overlay.ts already carries the
  // short-form ("short") marker to reuse. No other file needs to change.
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
/>

{#snippet statsSnippet()}
  {#if event.stats}
    <div class="card-stats stats-line">
      <StatChips
        chips={[
          { metric: "views", value: formatStat(event.stats.viewCount) },
          { metric: "likes", value: formatStat(event.stats.likeCount) },
          { metric: "comments", value: formatStat(event.stats.commentCount) },
        ]}
      />
    </div>
  {/if}
{/snippet}
