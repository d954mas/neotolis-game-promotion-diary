<script lang="ts">
  // FilterChips — horizontally-scrollable chip strip rendering active /feed
  // filters (UI-SPEC §"Component inventory" + §"/feed filter row — chips →
  // sheet pattern").
  //
  // Layout contract (UI-SPEC):
  //   - min-width 600px: render one <button aria-pressed="true"> per active
  //     filter axis with text from the corresponding m.feed_filter_*() key,
  //     plus a 44×44 dismiss × button per chip with
  //     aria-label={m.feed_filter_chip_dismiss_aria({filter: axisLabel})}.
  //     A "Clear all filters" link at the right end if any filter is active.
  //   - max-width 599px: render only <button>Filters (N)</button> that opens
  //     <FiltersSheet>.
  //
  // FLAG (UI-SPEC): chip wrap permitted at 600–800px when many filters
  // active (`flex-wrap: wrap`).

  import { m } from "$lib/paraglide/messages.js";

  type ActiveFilters = {
    source?: string;
    kind?: string;
    game?: string;
    attached?: boolean;
    authorIsMe?: boolean;
    from?: string;
    to?: string;
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
    onDismiss: (axis: string) => void;
    onOpenSheet: () => void;
    onClearAll: () => void;
  } = $props();

  const sourceLabel = $derived.by(() => {
    if (!filters.source) return null;
    const s = sources.find((x) => x.id === filters.source);
    return s ? (s.displayName ?? s.handleUrl) : filters.source;
  });
  const gameLabel = $derived.by(() => {
    if (!filters.game) return null;
    const g = games.find((x) => x.id === filters.game);
    return g ? g.title : filters.game;
  });
  const kindLabel = $derived.by(() => {
    if (!filters.kind) return null;
    switch (filters.kind) {
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
      default:
        return filters.kind;
    }
  });

  type Chip = { axis: string; label: string; ariaName: string };
  const chips = $derived.by((): Chip[] => {
    const out: Chip[] = [];
    if (sourceLabel !== null) {
      out.push({
        axis: "source",
        label: m.feed_filter_source({ name: sourceLabel }),
        ariaName: m.feed_filter_source({ name: sourceLabel }),
      });
    }
    if (kindLabel !== null) {
      out.push({
        axis: "kind",
        label: m.feed_filter_kind({ kind: kindLabel }),
        ariaName: m.feed_filter_kind({ kind: kindLabel }),
      });
    }
    if (gameLabel !== null) {
      out.push({
        axis: "game",
        label: m.feed_filter_game({ title: gameLabel }),
        ariaName: m.feed_filter_game({ title: gameLabel }),
      });
    }
    if (filters.attached === true) {
      out.push({
        axis: "attached",
        label: m.feed_filter_attached_true(),
        ariaName: m.feed_filter_attached_true(),
      });
    } else if (filters.attached === false) {
      out.push({
        axis: "attached",
        label: m.feed_filter_attached_false(),
        ariaName: m.feed_filter_attached_false(),
      });
    }
    if (filters.authorIsMe === true) {
      out.push({
        axis: "authorIsMe",
        label: m.feed_filter_author_me(),
        ariaName: m.feed_filter_author_me(),
      });
    } else if (filters.authorIsMe === false) {
      out.push({
        axis: "authorIsMe",
        label: m.feed_filter_author_others(),
        ariaName: m.feed_filter_author_others(),
      });
    }
    if (filters.from !== undefined || filters.to !== undefined) {
      const range = m.feed_filter_date_range({
        from: filters.from ?? "—",
        to: filters.to ?? "—",
      });
      out.push({ axis: "from", label: range, ariaName: range });
    }
    return out;
  });

  const activeCount = $derived(chips.length);
</script>

{#if activeCount > 0}
  <div class="filter-row">
    <!-- Inline chip strip — visible at >= 600px via CSS media query. -->
    <div class="chips" aria-label="Active filters">
      {#each chips as chip (chip.axis)}
        <span class="chip">
          <button type="button" class="chip-label" aria-pressed="true">
            {chip.label}
          </button>
          <button
            type="button"
            class="chip-dismiss"
            aria-label={m.feed_filter_chip_dismiss_aria({ filter: chip.ariaName })}
            onclick={() => onDismiss(chip.axis === "from" ? "from" : chip.axis)}
          >
            ×
          </button>
        </span>
      {/each}
      <button type="button" class="clear-all" onclick={onClearAll}>
        {m.feed_filters_clear_all()}
      </button>
    </div>

    <!-- Sheet trigger — visible at < 600px via CSS media query. -->
    <button type="button" class="sheet-trigger" onclick={onOpenSheet}>
      Filters ({activeCount})
    </button>
  </div>
{/if}

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
  /* Chips inline at >= 600px; sheet trigger hides. */
  @media (min-width: 600px) {
    .chips {
      display: flex;
    }
    .sheet-trigger {
      display: none;
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
