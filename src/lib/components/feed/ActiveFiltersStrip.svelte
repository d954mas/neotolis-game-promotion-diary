<script lang="ts">
  // ActiveFiltersStrip — Wave 2a (Plan 03.4-07 Task 3).
  //
  // Port of docs/design/v2/ui-kit/app.jsx lines 200-256 + index.html
  // `.active-filters` / `.chip.active-chip` CSS rules (lines 276-323).
  //
  // Renders the chip strip showing which filters are currently active
  // when the <PageHead>'s Filters panel is COLLAPSED (LB-10 toggle).
  // Each chip dismisses one specific filter via its onRemove callback;
  // "Clear all" dismisses everything in one click.
  //
  // Visual contract vs. the prototype:
  //   - Strip: hairline bottom border + small vertical padding. Renders
  //     a row of pill chips with a × close icon at the right edge.
  //   - Base chip: 30px height, surface-2 fill, hairline border, text
  //     color. The × is a 20×20 circular subtle button that brightens
  //     to text-color on hover.
  //   - Variant `data-variant="show"`: accent-soft fill (matches the
  //     Inbox active treatment in the filter row).
  //   - Variant `data-variant="game"`: inset 3px left stripe in the
  //     game color (echoes the card's color-coded edge).
  //   - Variant `data-variant="kind"`: same inset stripe in the kind
  //     hue + the kind icon.
  //   - "Clear all" is a text-link CTA at the right edge.
  //
  // Placement decision (RESEARCH Open Question 4): this strip lives
  // BELOW PageHead, not inside the sticky chrome — keeps the
  // FeedDateGroupHeader sticky math stable (LB-3).

  import { m } from "$lib/paraglide/messages.js";
  import KindIcon from "$lib/components/KindIcon.svelte";
  import type { EventKind } from "$lib/sources/adapter.js";

  // Kind → CSS-var bridge so KIND chips carry their per-kind accent
  // through --card-accent (consumed by .chip.active-chip[data-variant=kind]
  // below + KindIcon.svelte color inheritance).
  const KIND_ACCENT_VAR: Record<EventKind, string> = {
    youtube_video: "var(--k-youtube)",
    reddit_post: "var(--k-reddit)",
    twitter_post: "var(--k-twitter)",
    telegram_post: "var(--k-telegram)",
    discord_drop: "var(--k-discord)",
    conference: "var(--k-conference)",
    talk: "var(--k-talk)",
    press: "var(--k-press)",
    post: "var(--k-post)",
    other: "var(--k-other)",
  };

  export type AxisChip = {
    // Discriminates the chip's color treatment (kind / game / author /
    // show / source — each may get an accent in a later sub-task).
    axis: "show" | "game" | "kind" | "source" | "author";
    label: string;
    onRemove: () => void;
    // Optional kind for KIND chips — drives the leading icon + accent.
    kind?: EventKind;
    // Optional CSS color string for GAME chips — drives --card-accent.
    color?: string;
  };

  let {
    axes,
    onClearAll,
  }: {
    axes: AxisChip[];
    onClearAll: () => void;
  } = $props();

  let visible = $derived(axes.length > 0);
</script>

{#if visible}
  <div class="active-filters" role="status" aria-label="Active filters">
    {#each axes as chip (chip.axis + ":" + chip.label)}
      <button
        type="button"
        class="chip active-chip"
        data-variant={chip.axis}
        style={chip.kind
          ? `--card-accent: ${KIND_ACCENT_VAR[chip.kind]};`
          : chip.color
            ? `--card-accent: ${chip.color};`
            : null}
        onclick={chip.onRemove}
        aria-label={m.feed_active_filters_remove_aria({ label: chip.label })}
      >
        {#if chip.kind}
          <span class="kind-icon" aria-hidden="true">
            <KindIcon kind={chip.kind} size={14} />
          </span>
        {/if}
        <span>{chip.label}</span>
        <span class="x" aria-hidden="true">×</span>
      </button>
    {/each}
    <button type="button" class="btn-link" onclick={onClearAll}>
      {m.feed_active_filters_clear_all()}
    </button>
  </div>
{/if}

<style>
  /* index.html .active-filters lines 278-283 — small vertical padding,
   * hairline bottom border. */
  .active-filters {
    display: flex;
    gap: var(--s-2);
    flex-wrap: wrap;
    align-items: center;
    padding: var(--s-3) 0;
    border-bottom: 1px solid var(--border-hairline);
    margin-bottom: var(--s-2);
    min-width: 0;
  }

  /* index.html .chip.active-chip lines 284-323. Base treatment is a
   * neutral surface-2 pill with a hairline border; the × sits inside
   * a 20px circular hover target. */
  .chip.active-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 6px 0 12px;
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
      color var(--m-fast) var(--m-ease);
  }

  .chip.active-chip .kind-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--card-accent, var(--accent));
    flex-shrink: 0;
    margin-right: 2px;
  }
  .chip.active-chip .kind-icon :global(svg) {
    color: inherit;
    width: 14px;
    height: 14px;
  }

  .chip.active-chip .x {
    width: 20px;
    height: 20px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    color: var(--text-3);
    font-size: 14px;
    line-height: 1;
    transition:
      background var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease);
  }
  .chip.active-chip:hover .x {
    background: rgba(0, 0, 0, 0.18);
    color: var(--text);
  }

  /* Show / author chip — accent treatment (Inbox = workflow-critical). */
  .chip.active-chip[data-variant="show"],
  .chip.active-chip[data-variant="author"] {
    background: var(--accent-soft);
    border-color: color-mix(in oklab, var(--accent) 45%, var(--border));
    color: var(--accent-strong);
  }

  /* Game chip — tinted bg + border + inset stripe, all in --card-accent.
   * Mirrors prototype docs/design/v2/ui-kit/index.html lines 310-315. */
  .chip.active-chip[data-variant="game"] {
    background: color-mix(in oklab, var(--card-accent, var(--text-3)) 18%, var(--surface));
    border-color: color-mix(in oklab, var(--card-accent, var(--text-3)) 45%, var(--border));
    box-shadow: inset 3px 0 0 var(--card-accent, transparent);
    padding-left: 14px;
  }

  /* Kind chip — tinted bg + border + inset stripe + colored icon. Mirrors
   * prototype lines 317-323. */
  .chip.active-chip[data-variant="kind"] {
    background: color-mix(in oklab, var(--card-accent) 14%, var(--surface));
    box-shadow: inset 3px 0 0 var(--card-accent, transparent);
    padding-left: 14px;
    border-color: color-mix(in oklab, var(--card-accent, var(--accent)) 40%, var(--border));
  }

  /* Source chip — neutral surface (no special accent in prototype). */

  /* "Clear all" — subtle text-link CTA (index.html lines 459-463). */
  .btn-link {
    background: transparent;
    border: 0;
    padding: 0 var(--s-2);
    color: var(--text-3);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
    transition: color var(--m-fast) var(--m-ease);
  }
  .btn-link:hover {
    color: var(--text);
  }

  @media (prefers-reduced-motion: reduce) {
    .chip.active-chip,
    .chip.active-chip .x,
    .btn-link {
      transition: none;
    }
  }
</style>
