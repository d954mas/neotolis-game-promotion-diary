<script lang="ts">
  // TelegramFeedCard — per-platform variant for kind=telegram_post.
  //
  // Composed from $lib/components/feed/parts/BaseFeedCard.svelte so the
  // markup shell + click handling + menu + footer is identical to the
  // default FeedCard. This file enforces the Telegram-specific read paths
  // per AGENTS.md no-denormalization rule AND the D-06 adaptive layout:
  //
  //   - sourceLabel: the channel display name / @handle from data_sources
  //     via the `source` prop (FK lookup at /feed loader time). NEVER from
  //     event metadata — the channel owner can rename the @handle after the
  //     post was logged; reading from the owning row is the only way to stay
  //     fresh. Mirrors instagramHandleLabel (channelTitle → displayName →
  //     handleUrl). Falls back to "" when the source row is gone (honest
  //     state — we can't claim a name we don't own).
  //   - thumbnail: telegramEnrichment.thumbnailUrl — the fresh t.me hotlink
  //     (D-06), refreshed every poll by the snapshot writer. Hotlinked
  //     (referrerpolicy=no-referrer, loading=lazy via BaseFeedCard). The
  //     CDN URL may expire OR the telesco.pe CDN may serve
  //     Cross-Origin-Resource-Policy: same-origin (like IG's CDN, #69) — in
  //     EITHER case onerror latches thumbErrored → null → BaseFeedCard
  //     renders the empty KindIcon placeholder (zero-storage v1 degradation;
  //     a same-origin thumbnail proxy is the deferred upgrade).
  //   - stats: telegramEnrichment.stats.viewCount — the post's own polling
  //     data (owned by telegram_post_snapshots), not denormalized. Telegram
  //     exposes TWO metrics (D-04 + E1): a views chip, rendered ONLY when
  //     non-null (D-05), PLUS a top-5 reactions LIST (emoji + per-reaction
  //     count) from telegramEnrichment.reactionsTop. A null-views post renders
  //     NO views chip, a null/empty reactionsTop renders NO reactions row — both
  //     still appear in the feed (mirror the null→no-chip rule).
  //
  //   - ADAPTIVE D-06 layout: a post WITH media (mediaKind = photo / video /
  //     album) renders thumbnail-on-top + text-below (the default BaseFeedCard
  //     layout). A TEXT-ONLY post (mediaKind = null) is text-forward — we pass
  //     thumbnailUrl={null} so the empty thumbnail slot never renders and the
  //     title/notes are the focal point. telegram_post is NOT a media-shape
  //     kind (isMediaShape returns false), so BaseFeedCard only reserves the
  //     thumb slot when thumbnailUrl is non-null — passing null collapses it.
  //
  // Registered via ./index.ts as `cardComponent` so /feed/+page.svelte's
  // `getCardComponent("telegram_post")` returns this component.

  import { metricColor } from "$lib/util/metric-colors.js";
  import BaseFeedCard from "$lib/components/feed/parts/BaseFeedCard.svelte";
  import { deriveMediaTypeOverlay } from "$lib/components/feed/parts/media-type-overlay.js";
  import {
    formatStat,
    telegramChannelHandleLabel,
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

  // Channel name from the FK source-of-truth (data_sources via `source` prop),
  // NEVER event metadata (no-denorm: the @handle is renameable).
  const sourceLabel = $derived.by((): string => telegramChannelHandleLabel(source ?? null));

  // D-06 adaptive: a post with NO media (mediaKind null) is text-only → render
  // text-forward (no thumbnail slot). A post WITH media (photo/video/album)
  // shows the hotlink thumbnail on top.
  const isTextOnly = $derived((event.telegramEnrichment?.mediaKind ?? null) === null);

  // Hotlink expiry OR CORP:same-origin (telesco.pe CDN, like IG #69) → null
  // thumbnail → BaseFeedCard renders the .card-thumb.empty KindIcon placeholder
  // (D-06). `thumbErrored` latches on the <img> onerror so a transient
  // placeholder doesn't flicker back.
  let thumbErrored = $state(false);
  const thumbnailUrl = $derived.by(() =>
    isTextOnly || thumbErrored ? null : (event.telegramEnrichment?.thumbnailUrl ?? null),
  );

  const stats = $derived(event.telegramEnrichment?.stats ?? null);

  // E1: top-5 reactions list (emoji + count). null/[] → no reactions row
  // (mirror the null-views → no-chip rule). The per-kind glyph: a standard
  // reaction carries its unicode emoji char; a paid (Telegram-Stars) reaction
  // renders a ⭐ glyph; a custom/premium sticker (no unicode char available)
  // renders a generic 💬-style fallback so the count still reads in context.
  const reactions = $derived(event.telegramEnrichment?.reactionsTop ?? null);
  function reactionGlyph(r: {
    emoji: string | null;
    kind: "standard" | "custom" | "paid";
  }): string {
    if (r.emoji) return r.emoji;
    if (r.kind === "paid") return "⭐";
    return "💬"; // custom/premium sticker — no unicode char on the listing
  }

  // Media-type pill (video / carousel). A photo / text-only post maps to null →
  // no pill. The kind→pill decision lives in ONE shared place
  // (deriveMediaTypeOverlay) used by the feed cards AND the event detail.
  // BaseFeedCard renders the icon+text pill over a present <img> only.
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
  {#if (stats && stats.viewCount !== null) || (reactions && reactions.length > 0)}
    <!-- Views chip + top-5 reactions share ONE wrapping row (user 2026-06-09):
         the views count and the reaction list sit on the same line and wrap
         only when the card is too narrow to hold them. -->
    <div class="card-stats stats-line tg-stats-row">
      {#if stats && stats.viewCount !== null}
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
      {#if reactions && reactions.length > 0}
        <!-- E1: top-5 reactions — one chip per reaction (glyph + count). -->
        {#each reactions as r (r.kind + (r.emoji ?? "") + r.count)}
          <span class="reaction" title={r.kind === "paid" ? "Telegram Stars" : undefined}>
            <span class="reaction-glyph" aria-hidden="true">{reactionGlyph(r)}</span>
            <span class="num">{formatStat(r.count)}</span>
          </span>
        {/each}
      {/if}
    </div>
  {/if}
{/snippet}

<style>
  /* Views chip + top-5 reactions on ONE wrapping row (E1, user 2026-06-09).
     .stats-line is BaseFeedCard's stat row; we make it wrap and give the views
     chip + each reaction comfortable spacing so they read on a single line and
     wrap only on a narrow card. */
  .tg-stats-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    column-gap: 0.6rem;
    row-gap: 0.2rem;
  }
  .reaction {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    font-size: 0.8125rem;
    color: var(--color-text-muted, #9aa0aa);
  }
  .reaction-glyph {
    font-size: 0.9375rem;
    line-height: 1;
  }
  .reaction .num {
    font-variant-numeric: tabular-nums;
  }
</style>
