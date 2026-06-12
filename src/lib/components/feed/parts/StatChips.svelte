<script lang="ts" module>
  // StatChips — the shared metric stat-chip row used by the per-platform feed
  // cards (Youtube / Instagram / Telegram / TikTok). Each chip is the same
  // <span class="stat"> shell: a per-metric SVG glyph (colored via the semantic
  // metricColor map) + a pre-formatted .num. The 4 cards used to inline-copy
  // this markup; this component is the one source of truth for the glyph + color
  // + chip shape. The .card-stats / .stat / .stat-icon / .num layout styles are
  // GLOBAL in BaseFeedCard (the chips render inside its statsSlot), so this
  // component only emits the class names.
  //
  // Presence-gating: a chip with a null value is OMITTED (metrics-by-presence
  // D-05 — a metric a platform doesn't expose is never rendered as 0). Callers
  // may pass the full ordered list and let the component drop nulls, or
  // pre-filter; both produce the same row.
  export interface StatChip {
    /** Semantic metric key — resolves the glyph AND metricColor(metric). One of
     *  views / likes / comments / shares (the icon catalog below). */
    metric: "views" | "likes" | "comments" | "shares";
    /** Pre-formatted display value (e.g. formatStat output). null → chip omitted. */
    value: string | null;
  }
</script>

<script lang="ts">
  import { metricColor } from "$lib/util/metric-colors.js";

  let { chips }: { chips: StatChip[] } = $props();

  const present = $derived(
    chips.filter((c): c is StatChip & { value: string } => c.value !== null),
  );
</script>

{#each present as chip (chip.metric)}
  <span class="stat" data-metric={chip.metric}>
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
      style={`color:${metricColor(chip.metric)}`}
    >
      {#if chip.metric === "views"}
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
      {:else if chip.metric === "likes"}
        <path
          d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"
        />
      {:else if chip.metric === "comments"}
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      {:else if chip.metric === "shares"}
        <!-- PLAT-02 share/arrow glyph (TikTok is the first platform to surface a
             real share count; teal via metricColor("shares")). -->
        <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
        <path d="M16 6l-4-4-4 4" />
        <path d="M12 2v13" />
      {/if}
    </svg>
    <span class="num">{chip.value}</span>
  </span>
{/each}
