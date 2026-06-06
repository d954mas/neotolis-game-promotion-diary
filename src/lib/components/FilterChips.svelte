<script lang="ts">
  // FilterChips — per-axis chip strip rendering active /feed filters.
  // One chip per active axis, not one per value.
  //
  // Layout contract:
  //   - One chip per active axis (kind / source / show / authorIsMe),
  //     with value labels comma-joined inside the chip text. No '+N
  //     more' truncation — long chips wrap text inside
  //     (word-break: break-word; min-width: 0). flex-wrap moves whole
  //     chips to a new row when natural width exceeds the strip.
  //   - Click chip body → opens FiltersSheet with focusAxis hint so the
  //     sheet scrolls/focuses the corresponding fieldset.
  //   - Click × → clears the entire axis (drops all values for that
  //     axis, NOT a single value).
  //   - Date-range chip is NOT emitted — the visible from/to inputs
  //     above the chip strip ARE the indicator.

  import { m } from "$lib/paraglide/messages.js";
  import { auditActionLabel } from "$lib/audit-labels.js";
  import { eventKindLabel } from "$lib/sources/kind-display.js";

  type ShowFilter =
    | { kind: "any" }
    | { kind: "inbox" }
    | { kind: "standalone" }
    | { kind: "specific"; gameIds: string[] };

  type ActiveFilters = {
    source: string[];
    kind: string[];
    show: ShowFilter;
    authorIsMe?: boolean;
    from?: string;
    to?: string;
    defaultDateRange: boolean;
    all: boolean;
    // action stays in the type so /audit can populate it. Chip emission
    // is gated on `schema`, not on the presence of this field.
    action?: string[];
  };
  type SourceOption = { id: string; displayName: string | null; handleUrl: string };
  type GameOption = { id: string; title: string };

  // The FilterChips axis union mirrors FiltersSheet's FilterAxis type.
  // 'date' is intentionally NOT included — the visible from/to inputs
  // in <DateRangeControl> are the date indicator.
  type ChipAxis = "kind" | "source" | "show" | "authorIsMe" | "action";
  type FilterAxis = ChipAxis | "date";

  let {
    filters,
    sources,
    games,
    schema,
    onDismiss,
    onOpenSheet,
    onClearAll,
  }: {
    filters: ActiveFilters;
    sources: SourceOption[];
    games: GameOption[];
    // REQUIRED — same shape as FiltersSheet's schema. Chips are only
    // emitted for axes present in schema. /feed passes
    // ['kind','source','show','authorIsMe','date']; /audit passes
    // ['action','date']. (The 'date' entry has no chip — the date
    // inputs ARE the indicator — but it stays in the schema to keep
    // the array a single source of truth across both components.)
    schema: ReadonlyArray<FilterAxis>;
    onDismiss: (axis: ChipAxis) => void;
    onOpenSheet: (focusAxis?: ChipAxis) => void;
    onClearAll: () => void;
  } = $props();

  // Kind label resolves through the central kind-display config
  // (eventKindLabel). Single source of truth across FeedCard / FilterChips /
  // FiltersSheet / EventDetailHeader.

  // auditActionLabel comes from the shared $lib/audit-labels.js helper.
  // Single source of truth across AuditRow / FilterChips /
  // FiltersSheet; TypeScript Record<AuditAction, ...> guarantees
  // completeness at compile time.

  type Chip = { axis: ChipAxis; label: string; ariaName: string; key: string };
  const chips = $derived.by((): Chip[] => {
    const out: Chip[] = [];

    // Each axis emits a chip only when the consumer's schema includes
    // it. /audit passes schema=['action','date'] so /feed-only axes
    // (kind/source/show/authorIsMe) don't leak into the audit chip
    // strip even if filters carries default values for them.

    // Kind axis — one chip with comma-joined value labels.
    if (schema.includes("kind") && filters.kind.length > 0) {
      const labels = filters.kind.map(eventKindLabel).join(", ");
      const label = `${m.feed_chip_axis_kind()}: ${labels}`;
      out.push({ axis: "kind", label, ariaName: label, key: "axis:kind" });
    }

    // Source axis — one chip with comma-joined display names.
    if (schema.includes("source") && filters.source.length > 0) {
      const labels = filters.source
        .map((id) => {
          const s = sources.find((x) => x.id === id);
          return s ? (s.displayName ?? s.handleUrl) : id;
        })
        .join(", ");
      const label = `${m.feed_chip_axis_source()}: ${labels}`;
      out.push({ axis: "source", label, ariaName: label, key: "axis:source" });
    }

    // Show axis (merged from old game + attached).
    if (schema.includes("show")) {
      if (filters.show.kind === "inbox") {
        const label = `${m.feed_chip_axis_show()}: ${m.feed_filter_show_inbox()}`;
        out.push({ axis: "show", label, ariaName: label, key: "axis:show:inbox" });
      } else if (filters.show.kind === "standalone") {
        // Standalone triage state chip.
        const label = `${m.feed_chip_axis_show()}: ${m.feed_filter_show_standalone()}`;
        out.push({ axis: "show", label, ariaName: label, key: "axis:show:standalone" });
      } else if (filters.show.kind === "specific" && filters.show.gameIds.length > 0) {
        const labels = filters.show.gameIds
          .map((id) => {
            const g = games.find((x) => x.id === id);
            return g ? g.title : id;
          })
          .join(", ");
        const label = `${m.feed_chip_axis_show()}: ${labels}`;
        out.push({ axis: "show", label, ariaName: label, key: "axis:show:specific" });
      }
      // show.kind === "any": no chip (default).
    }

    // Author axis — single value, kept as-is.
    if (schema.includes("authorIsMe")) {
      if (filters.authorIsMe === true) {
        const label = m.feed_filter_author_me();
        out.push({ axis: "authorIsMe", label, ariaName: label, key: "authorIsMe:true" });
      } else if (filters.authorIsMe === false) {
        const label = m.feed_filter_author_others();
        out.push({ axis: "authorIsMe", label, ariaName: label, key: "authorIsMe:false" });
      }
    }

    // Action axis (used by /audit). One chip with comma-joined translated
    // labels. /feed never passes 'action' in its schema so this branch is
    // dormant on /feed.
    if (schema.includes("action") && (filters.action?.length ?? 0) > 0) {
      const labels = filters.action!.map(auditActionLabel).join(", ");
      const label = `${m.feed_chip_axis_action()}: ${labels}`;
      out.push({ axis: "action", label, ariaName: label, key: "axis:action" });
    }

    // NO date-range chip emission. The visible from/to inputs in
    // <DateRangeControl> ARE the indicator. 'date' may appear in schema
    // (it does on /audit and /feed) but the chip strip stays silent on
    // it.
    return out;
  });

  const activeCount = $derived(chips.length);
</script>

<div class="filter-row">
  {#if activeCount > 0}
    <!-- Inline chip strip — visible at >= 600px via CSS media query. -->
    <div class="chips" aria-label="Active filters">
      {#each chips as chip (chip.key)}
        <!-- data-active="1" drives the active-state CSS treatment (LB-10).
             Every chip rendered in the strip is active by definition (the
             strip only renders when activeCount > 0 and each chip
             represents an active axis); the attribute is the
             declarative-CSS handle for the wash. -->
        <span class="chip" data-active="1">
          <button
            type="button"
            class="chip-label"
            aria-pressed="true"
            onclick={() => onOpenSheet(chip.axis)}
          >
            {chip.label}
          </button>
          <button
            type="button"
            class="chip-dismiss"
            aria-label={m.feed_filter_chip_dismiss_aria({ filter: chip.ariaName })}
            onclick={() => onDismiss(chip.axis)}
          >
            ×
          </button>
        </span>
      {/each}
      <button type="button" class="clear-all" onclick={onClearAll}>
        {m.feed_filters_clear_all()}
      </button>
    </div>
  {/if}

  <!-- Sheet trigger — always visible so users can discover and add filters. -->
  <button type="button" class="sheet-trigger" onclick={() => onOpenSheet()}>
    Filters{activeCount > 0 ? ` (${activeCount})` : ""}
  </button>
</div>

<style>
  /* v2 chip strip — per-axis chips with --r-pill + data-active="1" active
   * state. Per-axis grouping (Phase 02.1-19) preserved in the script; this
   * stylesheet is the visual contract. */
  .filter-row {
    display: flex;
    gap: var(--s-2);
  }
  .chips {
    display: none;
    flex-wrap: wrap;
    gap: var(--s-1);
    align-items: center;
    flex: 1 1 auto;
    min-width: 0;
  }
  .sheet-trigger {
    display: inline-flex;
    align-items: center;
    min-height: var(--hit);
    padding: var(--s-1) var(--s-4);
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    font-weight: var(--w-md);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .sheet-trigger:hover {
    background: var(--accent-soft);
    border-color: var(--accent-strong);
  }
  /* Chips inline at >= 600px. Sheet trigger stays visible at all widths so
   * users can always open the full filter sheet (date range, etc.) — chips
   * alone only let users dismiss already-applied filters. */
  @media (min-width: 600px) {
    .chips {
      display: flex;
    }
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    padding: var(--s-0) var(--s-1) var(--s-0) var(--s-3);
    color: var(--text-2);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    line-height: 1;
    /* Chip text wraps inside the chip when natural width exceeds the
     * strip. No '+N more' truncation. */
    max-width: 100%;
    min-width: 0;
    word-break: break-word;
    transition:
      background var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  /* LB-10 data-active="1" — every rendered chip is active by definition.
   * Wash with --accent-soft + --accent text + --accent-strong border. */
  .chip[data-active="1"] {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: var(--accent-strong);
  }
  .chip-label {
    background: transparent;
    color: inherit;
    border: none;
    padding: var(--s-1) var(--s-1);
    font-family: var(--f-sans);
    font-size: var(--t-12);
    font-weight: var(--w-md);
    cursor: pointer;
    white-space: normal;
    text-align: left;
  }
  .chip-dismiss {
    min-width: var(--hit);
    min-height: var(--hit);
    background: transparent;
    color: inherit;
    border: none;
    cursor: pointer;
    font-size: var(--t-14);
    line-height: 1;
    border-radius: var(--r-pill);
    flex-shrink: 0;
    transition: color var(--m-fast) var(--m-ease);
  }
  .chip-dismiss:hover {
    color: var(--danger);
  }
  .clear-all {
    background: transparent;
    color: var(--text-3);
    border: none;
    text-decoration: underline;
    font-family: var(--f-sans);
    font-size: var(--t-13);
    cursor: pointer;
    padding: var(--s-1) var(--s-2);
    transition: color var(--m-fast) var(--m-ease);
  }
  .clear-all:hover {
    color: var(--text);
  }
  @media (prefers-reduced-motion: reduce) {
    .sheet-trigger,
    .chip,
    .chip-dismiss,
    .clear-all {
      transition: none;
    }
  }
</style>
