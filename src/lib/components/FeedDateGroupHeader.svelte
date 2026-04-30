<script lang="ts">
  // FeedDateGroupHeader — date label above each /feed card group (Plan
  // 02.1-19, UAT round-2 gap "date-group header"). Mirrors Google Photos /
  // Apple Photos timeline UI.
  //
  // Reuses formatFeedDate (Plan 02.1-16) so the label format matches what
  // <FeedCard> used to render inline (Today HH:MM / Yesterday / Mon D /
  // Mon D, YYYY). The HH:MM suffix on Today reads slightly oddly as a
  // date header — Plan 02.1-19 truncates "Today, HH:MM" to "Today" for the
  // header context.

  import { formatFeedDate } from "$lib/util/format-feed-date.js";

  let { occurredAt }: { occurredAt: Date | string } = $props();

  const label = $derived.by(() => {
    const raw = formatFeedDate(occurredAt);
    // Trim "Today, HH:MM" → "Today" — the header is per-day, time-of-day
    // is on the card if needed (Phase 4 may surface it; 2.1 does not).
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
  /* Plan 02.1-39 round-6 polish follow-up #6 (2026-04-30): Instagram /
   * Google Sheets sticky date-section pattern. User quote (ru, surfaced
   * during round-6 UAT — NOT a round-5 finding):
   *   "хотелось чтобы дата была всегда виджимая наверху, пока я скролю
   *    эту дату. Так в гугл таблицах или инстаграмме сделоано"
   *
   * The component HAD `position: sticky; top: 0;` since Plan 02.1-19 — but
   * `top: 0` puts the date header under the sticky chrome (.sticky-chrome,
   * z:10, in +layout.svelte) AND PageHeader.sticky (z:5), so it was never
   * visible while scrolling. Now anchored at the BOTTOM of the chrome +
   * PageHeader stack:
   *
   *   top: calc(--chrome-height + --page-header-height - --sticky-overlap)
   *
   * --chrome-height is published by the +layout.svelte ResizeObserver on
   * `.sticky-chrome` (round-6 #5). --page-header-height is published by
   * PageHeader.svelte's ResizeObserver on its rendered <header> (round-6
   * #6, this commit). Both use raw fractional getBoundingClientRect().height;
   * --sticky-overlap (1px) absorbs DPR rounding at the chrome+PageHeader →
   * date-header boundary (one boundary, single-tier defense — same proof
   * as round-6 #3 for the prior single-boundary case).
   *
   * Fallbacks: 116px (chrome) + 56px (PageHeader: ~24px h1 + 2 × space-sm
   * padding + line-height) cover SSR / pre-effect first paint / no-JS.
   * Used on /feed and /games/[id] (both render FeedDateGroupHeader and
   * a sticky PageHeader above it).
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
