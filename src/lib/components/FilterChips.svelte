<script lang="ts">
  // FilterChips — horizontally-scrollable chip strip rendering active /feed
  // filters (UI-SPEC §"Component inventory" + §"/feed filter row — chips →
  // sheet pattern"; Plan 02.1-15 rewrites the per-axis chip emission to
  // per-VALUE emission for the multi-select axes).
  //
  // Layout contract (UI-SPEC):
  //   - min-width 600px: render one <button aria-pressed="true"> per active
  //     filter VALUE with text from the corresponding m.feed_filter_*() key,
  //     plus a 44×44 dismiss × button per chip with
  //     aria-label={m.feed_filter_chip_dismiss_aria({filter: axisLabel})}.
  //     A "Clear all filters" link at the right end if any filter is active.
  //   - max-width 599px: render only <button>Filters (N)</button> that opens
  //     <FiltersSheet>.
  //
  // Plan 02.1-15: source / kind / game emit ONE chip per VALUE (e.g.
  // source=[A,B,C] → 3 chips). The dismiss × passes the VALUE so the parent
  // page-server URL rebuild removes only that single value (other values in
  // the axis stay).
  //
  // Plan 02.1-15: from / to no longer emit a chip here — the date range
  // chip is owned by <DateRangeControl> (Gap 10). The default-30d chip and
  // user-applied custom-range chip both render here as a single chip with
  // axis === "dateRange"; dismissing it navigates to ?all=1 (opt-out of the
  // default; user-applied custom ranges flow through the same code path).
  //
  // FLAG (UI-SPEC): chip wrap permitted at 600–800px when many filters
  // active (`flex-wrap: wrap`).

  import { m } from "$lib/paraglide/messages.js";

  type ActiveFilters = {
    source: string[];
    kind: string[];
    game: string[];
    attached?: boolean;
    authorIsMe?: boolean;
    from?: string;
    to?: string;
    defaultDateRange: boolean;
    all: boolean;
  };
  type SourceOption = { id: string; displayName: string | null; handleUrl: string };
  type GameOption = { id: string; title: string };

  let {
    filters,
    sources,
    games,
    onDismiss,
    onOpenSheet,
    onClearAll,
  }: {
    filters: ActiveFilters;
    sources: SourceOption[];
    games: GameOption[];
    onDismiss: (axis: string, value?: string) => void;
    onOpenSheet: () => void;
    onClearAll: () => void;
  } = $props();

  function kindLabel(k: string): string {
    switch (k) {
      case "youtube_video":
        return m.event_kind_label_youtube_video();
      case "reddit_post":
        return m.event_kind_label_reddit_post();
      case "twitter_post":
        return m.event_kind_label_twitter_post();
      case "telegram_post":
        return m.event_kind_label_telegram_post();
      case "discord_drop":
        return m.event_kind_label_discord_drop();
      case "conference":
        return m.event_kind_label_conference();
      case "talk":
        return m.event_kind_label_talk();
      case "press":
        return m.event_kind_label_press();
      case "other":
        return m.event_kind_label_other();
      case "post":
        return m.event_kind_label_post();
      default:
        return k;
    }
  }

  type Chip = { axis: string; value?: string; label: string; ariaName: string; key: string };
  const chips = $derived.by((): Chip[] => {
    const out: Chip[] = [];
    // One chip per source value (Gap 4 — multi-select).
    for (const sId of filters.source) {
      const s = sources.find((x) => x.id === sId);
      const name = s ? (s.displayName ?? s.handleUrl) : sId;
      const label = m.feed_filter_source({ name });
      out.push({ axis: "source", value: sId, label, ariaName: label, key: `source:${sId}` });
    }
    // One chip per kind value.
    for (const k of filters.kind) {
      const label = m.feed_filter_kind({ kind: kindLabel(k) });
      out.push({ axis: "kind", value: k, label, ariaName: label, key: `kind:${k}` });
    }
    // One chip per game value.
    for (const gId of filters.game) {
      const g = games.find((x) => x.id === gId);
      const title = g ? g.title : gId;
      const label = m.feed_filter_game({ title });
      out.push({ axis: "game", value: gId, label, ariaName: label, key: `game:${gId}` });
    }
    // Boolean axes — one chip each.
    if (filters.attached === true) {
      const label = m.feed_filter_attached_true();
      out.push({ axis: "attached", label, ariaName: label, key: "attached:true" });
    } else if (filters.attached === false) {
      const label = m.feed_filter_attached_false();
      out.push({ axis: "attached", label, ariaName: label, key: "attached:false" });
    }
    if (filters.authorIsMe === true) {
      const label = m.feed_filter_author_me();
      out.push({ axis: "authorIsMe", label, ariaName: label, key: "authorIsMe:true" });
    } else if (filters.authorIsMe === false) {
      const label = m.feed_filter_author_others();
      out.push({ axis: "authorIsMe", label, ariaName: label, key: "authorIsMe:false" });
    }
    // Date range chip — single chip even for multi-day ranges. Skipped for
    // "all time" (the absence of a constraint should not render a chip;
    // dismissing it would be a no-op).
    if (filters.all) {
      // No chip — "all time" is already the no-constraint state.
    } else if (filters.defaultDateRange) {
      const label = m.feed_date_range_chip_default();
      out.push({ axis: "dateRange", label, ariaName: label, key: "dateRange:default" });
    } else if (filters.from !== undefined || filters.to !== undefined) {
      const range = m.feed_filter_date_range({
        from: filters.from ?? "—",
        to: filters.to ?? "—",
      });
      out.push({ axis: "dateRange", label: range, ariaName: range, key: "dateRange:custom" });
    }
    return out;
  });

  const activeCount = $derived(chips.length);
</script>

<div class="filter-row">
  {#if activeCount > 0}
    <!-- Inline chip strip — visible at >= 600px via CSS media query. -->
    <div class="chips" aria-label="Active filters">
      {#each chips as chip (chip.key)}
        <span class="chip">
          <button type="button" class="chip-label" aria-pressed="true">
            {chip.label}
          </button>
          <button
            type="button"
            class="chip-dismiss"
            aria-label={m.feed_filter_chip_dismiss_aria({ filter: chip.ariaName })}
            onclick={() => onDismiss(chip.axis, chip.value)}
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
  <button type="button" class="sheet-trigger" onclick={onOpenSheet}>
    Filters{activeCount > 0 ? ` (${activeCount})` : ""}
  </button>
</div>

<style>
  .filter-row {
    display: flex;
    gap: var(--space-sm);
  }
  .chips {
    display: none;
    flex-wrap: wrap;
    gap: var(--space-sm);
    align-items: center;
    flex: 1 1 auto;
    min-width: 0;
  }
  .sheet-trigger {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-semibold);
    cursor: pointer;
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
    background: var(--color-surface);
    border: 1px solid var(--color-text);
    border-radius: 999px;
    padding: 0 var(--space-xs) 0 var(--space-sm);
    font-size: var(--font-size-label);
    line-height: 1;
  }
  .chip-label {
    background: transparent;
    color: var(--color-text);
    border: none;
    padding: var(--space-xs) var(--space-xs);
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-semibold);
    cursor: pointer;
  }
  .chip-dismiss {
    min-width: 44px;
    min-height: 44px;
    background: transparent;
    color: var(--color-text-muted);
    border: none;
    cursor: pointer;
    font-size: var(--font-size-body);
    line-height: 1;
    border-radius: 999px;
  }
  .chip-dismiss:hover {
    color: var(--color-text);
  }
  .clear-all {
    background: transparent;
    color: var(--color-text-muted);
    border: none;
    text-decoration: underline;
    font-size: var(--font-size-label);
    cursor: pointer;
    padding: var(--space-xs) var(--space-sm);
  }
  .clear-all:hover {
    color: var(--color-text);
  }
</style>
