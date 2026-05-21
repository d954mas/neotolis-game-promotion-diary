<script lang="ts">
  // BulkActionBar — sticky bottom action bar shown when at least one event
  // is checked in /feed or /feed?view=trash. Mass-select architecture per
  // CONTEXT D-12 (bulk endpoints) + D-19 (trash mode) + D-21 (delete-forever).
  //
  // Renders ONLY when `selectedCount > 0`. The truthy guard at the top of
  // the template (`{#if selectedCount > 0}`) is the visibility contract —
  // the parent (/feed/+page.svelte) wires selection state via the
  // feed-ui store; this component is pure-presentational over that count.
  //
  // View modes (CONTEXT D-19):
  //   - view="feed":  count + Games picker open + Delete + Clear-selection
  //   - view="trash": count + Restore + Delete-forever + Clear-selection
  //
  // ARIA: role="region" + aria-label so screen readers announce the bar as
  // a landmark when it appears. The label is i18n-keyed so locale-add
  // doesn't break a11y tooling (CONTEXT D-17/D-18 locale-add invariant).
  //
  // Tenant scoping is the parent's contract — the bar only emits
  // callbacks; it never touches event IDs directly. Selection lives in the
  // ephemeral feed-ui store (per-session Set<string> at the page level).

  import { m } from "$lib/paraglide/messages.js";

  let {
    selectedCount,
    view,
    onOpenGamesPicker,
    onDelete,
    onRestore,
    onDeleteForever,
    onClearSelection,
  }: {
    selectedCount: number;
    view: "feed" | "trash";
    onOpenGamesPicker: () => void;
    onDelete: () => void;
    onRestore?: () => void;
    onDeleteForever?: () => void;
    onClearSelection: () => void;
  } = $props();
</script>

{#if selectedCount > 0}
  <div class="bulk-action-bar" role="region" aria-label={m.feed_bulk_action_aria_region()}>
    <span class="count">
      {m.feed_bulk_action_bar_count_selected({ count: String(selectedCount) })}
    </span>
    <div class="actions">
      {#if view === "feed"}
        <button type="button" class="action" onclick={onOpenGamesPicker}>
          {m.feed_bulk_action_bar_games()}
        </button>
        <button type="button" class="action danger" onclick={onDelete}>
          {m.feed_bulk_action_bar_delete()}
        </button>
      {:else}
        <button type="button" class="action" onclick={onRestore}>
          {m.feed_bulk_action_bar_restore()}
        </button>
        <button type="button" class="action danger" onclick={onDeleteForever}>
          {m.feed_bulk_action_bar_delete_forever()}
        </button>
      {/if}
    </div>
    <button
      type="button"
      class="clear"
      aria-label={m.feed_bulk_action_bar_clear_selection()}
      onclick={onClearSelection}
    >
      ×
    </button>
  </div>
{/if}

<style>
  /* Floating sticky pill at the bottom of the viewport. Centered
   * horizontally; sits above content via z-index. Width caps at viewport
   * minus a comfortable side gutter so it never bleeds off the edge on
   * narrow screens. */
  .bulk-action-bar {
    position: fixed;
    bottom: var(--s-4);
    left: 50%;
    transform: translateX(-50%);
    z-index: 50;
    display: inline-flex;
    align-items: center;
    gap: var(--s-3);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    padding: var(--s-2) var(--s-3) var(--s-2) var(--s-4);
    box-shadow: var(--shadow-elev);
    max-width: calc(100vw - var(--s-6));
  }
  .count {
    font-size: var(--t-13);
    color: var(--text);
    font-weight: var(--w-sb);
    white-space: nowrap;
  }
  .actions {
    display: inline-flex;
    gap: var(--s-2);
  }
  .action {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: var(--r-pill);
    padding: var(--s-1) var(--s-3);
    font-size: var(--t-13);
    cursor: pointer;
    min-height: var(--hit);
    transition: background var(--m-fast) var(--m-ease);
  }
  .action:hover {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: var(--accent-strong);
  }
  .action.danger:hover {
    background: var(--danger);
    color: var(--accent-text);
    border-color: var(--danger);
  }
  .clear {
    background: transparent;
    border: none;
    color: var(--text-3);
    cursor: pointer;
    font-size: var(--t-17);
    padding: 0 var(--s-1);
    line-height: 1;
  }
  .clear:hover {
    color: var(--text);
  }
  @media (prefers-reduced-motion: reduce) {
    .action {
      transition: none;
    }
  }
</style>
