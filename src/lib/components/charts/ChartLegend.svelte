<script lang="ts">
  // ChartLegend — the CUSTOM, on-brand per-listing legend for the two wishlist
  // charts on /games/[gameId] (04-09). Replaces the default ECharts native
  // legend (off-brand + buggy) with ONE pill-chip control mounted once at the
  // page, above both charts.
  //
  // Why custom (UAT round-1 fix):
  //   (1) "визуал сильно отличается от всего сайта" — the native ECharts legend
  //       doesn't match the site's `.chip` vocabulary (ActiveFiltersStrip /
  //       DateRangeRow). This renders the same surface-2 pill + hairline border
  //       + per-item accent, so the legend reads as part of the design system.
  //   (2) the re-enable bug — toggling a listing OFF then ON via the ECharts
  //       legend left the line hidden (an ECharts select-changed round-trip
  //       problem). This legend owns NOTHING: it just calls `onToggle`, the page
  //       updates its `visible` map, and BOTH charts filter their series by it.
  //       A click toggles plain state — re-enabling is just flipping the bool.
  //
  // Each chip = a color SWATCH (exactly the listing's line/bar color, from the
  // shared stable `listingColor` so swatch ≡ line ≡ bar) + the listing label.
  // OFF state dims the chip and hollows the swatch so it reads as "hidden but
  // returnable". `aria-pressed` reflects on/off for AX; the wrapping group has
  // an aria-label and flex-wraps under 600px (VIZ-04).

  import { m } from "$lib/paraglide/messages.js";
  import { listingColor, type ListingLite } from "./wishlist-chart-shared.js";

  let {
    listings,
    visible,
    onToggle,
  }: {
    /** Active listings (id + label) — drives one chip each, in array order. */
    listings: { id: string; label: string }[];
    /** Shared legend selection (page-owned): listingId → shown. Absent/true = shown. */
    visible: Record<string, boolean>;
    /** Flip a listing's visibility; the page mirrors it so both charts react. */
    onToggle: (listingId: string, shown: boolean) => void;
  } = $props();

  // `listingColor` is keyed by index in the FULL listings array, so pass the
  // same `listings` it receives — the swatch is identical to the series color.
  const colorListings = $derived(listings.map((l) => ({ id: l.id })) as ListingLite[]);

  function isShown(id: string): boolean {
    return visible[id] !== false;
  }
</script>

{#if listings.length > 0}
  <div class="chart-legend" role="group" aria-label={m.viz_legend_aria()}>
    {#each listings as l (l.id)}
      {@const shown = isShown(l.id)}
      <button
        type="button"
        class="chip legend-chip"
        data-shown={shown ? "1" : "0"}
        aria-pressed={shown}
        style="--swatch: {listingColor(colorListings, l.id)};"
        onclick={() => onToggle(l.id, !shown)}
      >
        <span class="swatch" aria-hidden="true"></span>
        <span class="legend-label">{l.label}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  /* Wrapping group — flex-wrap so chips reflow under 600px (VIZ-04). Spacing
   * mirrors ActiveFiltersStrip's strip vocabulary. */
  .chart-legend {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2);
    min-width: 0;
  }

  /* Base chip — the same surface-2 pill + hairline border + text color as
   * ActiveFiltersStrip's `.chip.active-chip` (30px, --r-pill). */
  .chip.legend-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    height: 30px;
    padding: 0 var(--s-3);
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: var(--r-pill);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    font-weight: var(--w-md);
    white-space: nowrap;
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease),
      opacity var(--m-fast) var(--m-ease);
  }
  .chip.legend-chip:hover {
    border-color: var(--accent);
  }
  .chip.legend-chip:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  /* Color swatch — exactly the listing's line/bar color via the --swatch custom
   * prop set inline from the shared stable mapping. ON = filled dot; OFF =
   * hollow ring so the chip reads as "hidden but returnable". */
  .swatch {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--swatch);
    border: 2px solid var(--swatch);
    box-sizing: border-box;
    transition:
      background var(--m-fast) var(--m-ease),
      opacity var(--m-fast) var(--m-ease);
  }

  .legend-label {
    line-height: 1;
  }

  /* OFF state — dim the whole chip + muted text + hollow swatch. The chip stays
   * fully clickable (it's how you turn the listing back ON). */
  .chip.legend-chip[data-shown="0"] {
    opacity: 0.55;
    color: var(--text-3);
    background: var(--surface);
  }
  .chip.legend-chip[data-shown="0"] .swatch {
    background: transparent;
  }
  .chip.legend-chip[data-shown="0"]:hover {
    opacity: 0.8;
  }

  @media (prefers-reduced-motion: reduce) {
    .chip.legend-chip,
    .swatch {
      transition: none;
    }
  }
</style>
