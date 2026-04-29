<script lang="ts">
  // FiltersSheet — mobile-only <dialog>-based bottom-sheet filter UX
  // (UI-SPEC §"Component inventory" + §"/feed filter row — chips → sheet
  // pattern"; Plan 02.1-19 reshape over Plan 02.1-15).
  // Triggered by the FilterChips "Filters (N)" button.
  //
  // Native <dialog> + showModal() gives focus-trap + Esc-to-close out of
  // the box. Mirrors the ConfirmDialog pattern.
  //
  // Plan 02.1-19 changes (round-2 UAT):
  //   - Game checkbox-list + Attached radio MERGE into one "Show" 3-radio
  //     (Any / Inbox only / Attached to games). Picking "Attached to games"
  //     reveals the games multi-select; the conflict between
  //     "Attached=Inbox AND Game=X" is impossible by construction (UI guard).
  //   - onApply payload: replaces { game?, attached? } with
  //     { show: { kind: 'any' | 'inbox' | 'specific'; gameIds? } }.
  //
  // Plan 02.1-15 carry-over:
  //   - source / kind become checkbox LISTS (multi-select per Gap 4).
  //   - source + game lists carry a typeahead `<input type="search">` so a
  //     long source/game list stays scannable.
  //   - from / to date inputs are owned by <DateRangeControl> above the
  //     chip strip on /feed (Gap 10).

  import { m } from "$lib/paraglide/messages.js";

  type ShowFilter =
    | { kind: "any" }
    | { kind: "inbox" }
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
  };
  type SourceOption = { id: string; displayName: string | null; handleUrl: string };
  type GameOption = { id: string; title: string };

  let {
    filters,
    sources,
    games,
    focusAxis,
    onApply,
    onClose,
  }: {
    filters: ActiveFilters;
    sources: SourceOption[];
    games: GameOption[];
    focusAxis?: "kind" | "source" | "show" | "authorIsMe";
    onApply: (next: {
      source?: string[];
      kind?: string[];
      show: ShowFilter;
      authorIsMe?: boolean;
    }) => void;
    onClose: () => void;
  } = $props();

  let dialogEl: HTMLDialogElement | null = $state(null);

  // Track checkbox-list selections via Set<string> — toggle reassigns the
  // state ref (immutable update) so $derived(filteredSources) and the
  // checkbox `checked` bindings recompute.
  let sourceSelected = $state<Set<string>>(new Set(filters.source ?? []));
  let kindSelected = $state<Set<string>>(new Set(filters.kind ?? []));
  let showSelection = $state<"any" | "inbox" | "specific">(filters.show.kind);
  let gameSelected = $state<Set<string>>(
    filters.show.kind === "specific" ? new Set(filters.show.gameIds) : new Set(),
  );
  let sourceTypeahead = $state("");
  let gameTypeahead = $state("");

  let authorIsMe = $state<"any" | "true" | "false">(
    filters.authorIsMe === true ? "true" : filters.authorIsMe === false ? "false" : "any",
  );

  const KIND_OPTIONS = [
    "youtube_video",
    "reddit_post",
    "twitter_post",
    "telegram_post",
    "discord_drop",
    "conference",
    "talk",
    "press",
    "post",
    "other",
  ] as const;

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
      case "post":
        return m.event_kind_label_post();
      default:
        return m.event_kind_label_other();
    }
  }

  const filteredSources = $derived(
    sources.filter(
      (s) =>
        sourceTypeahead === "" ||
        (s.displayName ?? s.handleUrl)
          .toLowerCase()
          .includes(sourceTypeahead.toLowerCase()),
    ),
  );
  const filteredGames = $derived(
    games.filter(
      (g) =>
        gameTypeahead === "" ||
        g.title.toLowerCase().includes(gameTypeahead.toLowerCase()),
    ),
  );

  $effect(() => {
    if (dialogEl && !dialogEl.open) {
      dialogEl.showModal();
      // Plan 02.1-19: focus-jump support — when chip click opens the sheet
      // with a specific axis hint, scroll its fieldset into view + focus
      // the first interactive control. Lightweight UX nice-to-have.
      if (focusAxis) {
        queueMicrotask(() => {
          const el = dialogEl?.querySelector<HTMLElement>(
            `[data-axis="${focusAxis}"]`,
          );
          if (el) {
            el.scrollIntoView({ block: "nearest" });
            const firstControl = el.querySelector<HTMLElement>(
              "input, button, select, textarea",
            );
            firstControl?.focus();
          }
        });
      }
    }
  });

  function onDialogCancel(e: Event): void {
    e.preventDefault();
    onClose();
  }

  function toggle(set: Set<string>, value: string): Set<string> {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  }

  function applyAll(): void {
    const showResult: ShowFilter =
      showSelection === "any"
        ? { kind: "any" }
        : showSelection === "inbox"
          ? { kind: "inbox" }
          : { kind: "specific", gameIds: Array.from(gameSelected) };
    onApply({
      source: Array.from(sourceSelected),
      kind: Array.from(kindSelected),
      show: showResult,
      authorIsMe: authorIsMe === "any" ? undefined : authorIsMe === "true",
    });
  }

  function clearAll(): void {
    onApply({ show: { kind: "any" } });
  }
</script>

<dialog
  bind:this={dialogEl}
  class="sheet"
  oncancel={onDialogCancel}
  aria-labelledby="filters-sheet-heading"
>
  <h2 id="filters-sheet-heading" class="heading">Filters</h2>

  <div class="grid">
    <fieldset class="field" data-axis="source">
      <legend class="label">Source</legend>
      <input
        type="search"
        class="input"
        placeholder="Filter sources…"
        bind:value={sourceTypeahead}
      />
      <div class="checklist">
        {#each filteredSources as s (s.id)}
          <label class="check">
            <input
              type="checkbox"
              checked={sourceSelected.has(s.id)}
              onchange={() => (sourceSelected = toggle(sourceSelected, s.id))}
            />
            {s.displayName ?? s.handleUrl}
          </label>
        {/each}
      </div>
    </fieldset>

    <fieldset class="field" data-axis="kind">
      <legend class="label">Kind</legend>
      <div class="checklist">
        {#each KIND_OPTIONS as k (k)}
          <label class="check">
            <input
              type="checkbox"
              checked={kindSelected.has(k)}
              onchange={() => (kindSelected = toggle(kindSelected, k))}
            />
            {kindLabel(k)}
          </label>
        {/each}
      </div>
    </fieldset>

    <!-- Plan 02.1-19: Game checkbox-list + Attached radio MERGED into a
         single Show 3-radio with a conditional games multi-select. The
         conflict between "Inbox AND specific games" is impossible by
         construction. -->
    <fieldset class="field" data-axis="show">
      <legend class="label">{m.feed_filter_show_axis_label()}</legend>
      <label class="toggle">
        <input type="radio" name="show" value="any" bind:group={showSelection} />
        {m.feed_filter_show_any()}
      </label>
      <label class="toggle">
        <input type="radio" name="show" value="inbox" bind:group={showSelection} />
        {m.feed_filter_show_inbox()}
      </label>
      <label class="toggle">
        <input type="radio" name="show" value="specific" bind:group={showSelection} />
        {m.feed_filter_show_specific()}
      </label>

      {#if showSelection === "specific"}
        <input
          type="search"
          class="input"
          placeholder="Filter games…"
          bind:value={gameTypeahead}
        />
        <div class="checklist">
          {#each filteredGames as g (g.id)}
            <label class="check">
              <input
                type="checkbox"
                checked={gameSelected.has(g.id)}
                onchange={() => (gameSelected = toggle(gameSelected, g.id))}
              />
              {g.title}
            </label>
          {/each}
        </div>
      {/if}
    </fieldset>

    <fieldset class="field" data-axis="authorIsMe">
      <legend class="label">Author</legend>
      <label class="toggle">
        <input type="radio" name="author" value="any" bind:group={authorIsMe} /> Any
      </label>
      <label class="toggle">
        <input type="radio" name="author" value="true" bind:group={authorIsMe} />
        {m.feed_filter_author_me()}
      </label>
      <label class="toggle">
        <input type="radio" name="author" value="false" bind:group={authorIsMe} />
        {m.feed_filter_author_others()}
      </label>
    </fieldset>
  </div>

  <div class="actions">
    <button type="button" class="cancel" onclick={onClose}>
      {m.common_cancel()}
    </button>
    <button type="button" class="secondary" onclick={clearAll}>
      {m.feed_filters_clear_all()}
    </button>
    <button type="button" class="primary" onclick={applyAll}>
      {m.feed_filters_apply()}
    </button>
  </div>
</dialog>

<style>
  .sheet {
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: var(--space-lg);
    width: min(560px, calc(100vw - 2 * var(--space-md)));
    max-height: 90vh;
    overflow-y: auto;
  }
  .sheet::backdrop {
    background: rgb(0 0 0 / 50%);
  }
  .heading {
    margin: 0 0 var(--space-md) 0;
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-semibold);
  }
  .grid {
    display: grid;
    gap: var(--space-md);
    grid-template-columns: 1fr;
  }
  @media (min-width: 480px) {
    .grid {
      grid-template-columns: 1fr 1fr;
    }
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    border: none;
    padding: 0;
    margin: 0;
    min-width: 0;
  }
  .label {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
    font-weight: var(--font-weight-semibold);
  }
  .input {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-bg);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--font-size-body);
  }
  .checklist {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    max-height: 220px;
    overflow-y: auto;
    padding: var(--space-xs);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: var(--color-bg);
  }
  .check {
    display: inline-flex;
    align-items: center;
    gap: var(--space-xs);
    font-size: var(--font-size-label);
    min-height: 32px;
    cursor: pointer;
  }
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--space-xs);
    font-size: var(--font-size-label);
    min-height: 44px;
  }
  .actions {
    display: flex;
    gap: var(--space-sm);
    justify-content: flex-end;
    margin-top: var(--space-lg);
    flex-wrap: wrap;
  }
  .cancel,
  .secondary,
  .primary {
    min-height: 44px;
    padding: 0 var(--space-md);
    border-radius: 4px;
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-semibold);
    cursor: pointer;
  }
  .cancel,
  .secondary {
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
  }
  .primary {
    background: var(--color-accent);
    color: var(--color-accent-text);
    border: none;
  }
</style>
