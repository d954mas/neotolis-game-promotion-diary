<script lang="ts">
  // FeedDateGroupHeader — date label above each /feed card group. Mirrors
  // Google Photos / Apple Photos timeline UI.
  //
  // Reuses formatFeedDate so the label format matches what <FeedCard> used
  // to render inline (Today HH:MM / Yesterday / Mon D / Mon D, YYYY).
  // The HH:MM suffix on Today reads oddly as a date header — we truncate
  // "Today, HH:MM" to "Today" for the header context.

  import { formatFeedDate } from "$lib/util/format-feed-date.js";

  let { occurredAt }: { occurredAt: Date | string } = $props();

  const label = $derived.by(() => {
    const raw = formatFeedDate(occurredAt);
    // Trim "Today, HH:MM" → "Today" — the header is per-day, time-of-day
    // can surface on the card if needed.
    return raw.startsWith("Today") ? "Today" : raw;
  });

  const occurredIso = $derived(
    typeof occurredAt === "string" ? occurredAt : occurredAt.toISOString(),
  );
</script>

<h2 class="date-header">
  <time datetime={occurredIso} title={occurredIso}>{label}</time>
</h2>

<style>
  /* Instagram / Google Sheets sticky date-section pattern. User quote
   * (ru): "хотелось чтобы дата была всегда виджимая наверху, пока я
   *  скролю эту дату. Так в гугл таблицах или инстаграмме сделоано"
   *
   * The header anchors at the BOTTOM of the chrome + PageHeader stack:
   *
   *   top: calc(--chrome-height + --page-header-height - --sticky-overlap)
   *
   * --chrome-height is published by the +layout.svelte ResizeObserver on
   * `.sticky-chrome`. --page-header-height is published by
   * PageHeader.svelte's ResizeObserver on its rendered <header>. Both use
   * raw fractional getBoundingClientRect().height; --sticky-overlap (1px)
   * absorbs DPR rounding at the chrome+PageHeader → date-header boundary.
   *
   * Fallbacks: 116px (chrome) + 56px (PageHeader: ~24px h1 + 2 × space-sm
   * padding + line-height) cover SSR / pre-effect first paint / no-JS.
   * Used on /feed and /games/[id] (both render FeedDateGroupHeader and a
   * sticky PageHeader above it).
   *
   * z-index: 1 keeps the date header above neighbouring FeedCards within
   * the grid, but well below PageHeader (z:5) and the chrome (z:10) — when
   * the user scrolls past the chrome+PageHeader, the previous group's
   * date header passes UNDER PageHeader and the next group's header
   * replaces it. That's the Instagram / Google Sheets behaviour.
   *
   * background: --color-bg matches the page-grid background so scrolled
   * FeedCards passing under the sticky header don't bleed through. */
  .date-header {
    margin: 0;
    padding: var(--space-sm) 0 var(--space-xs);
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-semibold);
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    position: sticky;
    top: calc(
      var(--chrome-height, 116px) + var(--page-header-height, 56px) - var(--sticky-overlap, 1px)
    );
    background: var(--color-bg);
    z-index: 1;
    /* Span all grid columns so the header separates card groups visually. */
    grid-column: 1 / -1;
  }
</style>
