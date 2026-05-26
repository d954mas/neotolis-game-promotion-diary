<script lang="ts">
  // GamesPicker — tri-state per-game picker dialog.
  //
  // Same component for single-card edit (one event) and bulk edit
  // (selectedIds.size events). Caller computes initial per-game states
  // outside this component:
  //
  //   - single mode: gameStates[gid] = "on" | "off" (no mixed possible)
  //   - bulk mode:   gameStates[gid] = "on" | "off" | "mixed" per
  //                  RESEARCH §"GamesPicker bulk-edit mixed state
  //                  derivation" — "on" if all selected events have the
  //                  game attached, "off" if none have it, "mixed"
  //                  otherwise.
  //
  // Apply contract (D-12): emits `{gameStates, offTopicState}`. The bulk
  // PATCH endpoint at `/api/events/bulk` interprets:
  //   - "on":    add game to events that don't have it
  //   - "off":   remove game from events that have it
  //   - "mixed": leave untouched (user didn't change this row)
  //
  // The off-topic flag follows the same tri-state semantics — it lives in
  // `metadata.triage.offTopic` (boolean) on each event and is rendered as
  // a separator row below the per-game checkboxes.
  //
  // <dialog> + .showModal() is the native modal pattern. `oncancel` fires
  // on Esc; we preventDefault then route through `onClose` so caller has
  // single close path. Backdrop click also closes via the e.target ===
  // dialogEl check (the dialog itself is the event target when its
  // backdrop is clicked).

  import { m } from "$lib/paraglide/messages.js";
  import TriStateCheckbox from "./TriStateCheckbox.svelte";
  import { gameColor } from "$lib/util/game-color.js";

  type GameOption = { id: string; title: string };

  let {
    open,
    games,
    initialGameStates,
    initialOffTopicState,
    mode,
    selectedCount,
    onApply,
    onClose,
  }: {
    open: boolean;
    games: GameOption[];
    initialGameStates: Record<string, "on" | "off" | "mixed">;
    initialOffTopicState: "on" | "off" | "mixed";
    mode: "single" | "bulk";
    selectedCount: number;
    onApply: (next: {
      gameStates: Record<string, "on" | "off" | "mixed">;
      offTopicState: "on" | "off" | "mixed";
    }) => void;
    onClose: () => void;
  } = $props();

  let dialogEl: HTMLDialogElement;
  // Local working copy of the per-game tri-state map. Initial-copy is
  // re-seeded every time `open` flips true so reopening after a previous
  // Cancel restores the freshly-derived initial state.
  let gameStates = $state<Record<string, "on" | "off" | "mixed">>({ ...initialGameStates });
  let offTopicState = $state<"on" | "off" | "mixed">(initialOffTopicState);

  $effect(() => {
    if (!dialogEl) return;
    if (open) {
      gameStates = { ...initialGameStates };
      offTopicState = initialOffTopicState;
      if (!dialogEl.open) dialogEl.showModal();
    } else if (dialogEl.open) {
      dialogEl.close();
    }
  });

  function apply(): void {
    onApply({ gameStates, offTopicState });
  }

  // Off-topic + games are INDEPENDENT axes (matches prototype semantics
  // and the GAME-axis multi-select OR-union refactor). Toggling one no
  // longer forces the other; events freely carry both states.
  function setGameState(gid: string, next: "on" | "off"): void {
    gameStates = { ...gameStates, [gid]: next };
  }

  function setOffTopicState(next: "on" | "off"): void {
    offTopicState = next;
  }
</script>

<!-- The <dialog> backdrop is rendered by the browser; we intercept its
     click to close. e.target === dialogEl means the click landed on the
     dialog box itself (i.e., the backdrop, since the inner DOM sits in
     the dialog's "open box" pseudo-region). oncancel fires when the user
     hits Esc — preventDefault keeps the dialog mounted long enough for
     our onClose hook to clear state in the parent. -->
<dialog
  bind:this={dialogEl}
  class="games-picker"
  oncancel={(e) => {
    e.preventDefault();
    onClose();
  }}
  onclick={(e) => {
    if (e.target === dialogEl) onClose();
  }}
>
  <header class="header">
    <h2>
      {mode === "bulk"
        ? m.games_picker_bulk_title({ count: String(selectedCount) })
        : m.games_picker_title()}
    </h2>
    <button type="button" class="close" aria-label={m.games_picker_close_aria()} onclick={onClose}>
      ×
    </button>
  </header>

  <div class="body">
    {#each games as g (g.id)}
      <div class="row" data-state={gameStates[g.id] ?? "off"}>
        <TriStateCheckbox
          state={gameStates[g.id] ?? "off"}
          onchange={(next) => setGameState(g.id, next)}
        />
        <span class="picker-game-dot" aria-hidden="true" style="background: {gameColor(g.id)};"
        ></span>
        <span class="picker-label">{g.title}</span>
      </div>
    {/each}
    <div class="row separator" data-state={offTopicState}>
      <TriStateCheckbox state={offTopicState} onchange={setOffTopicState} />
      <span class="picker-game-dot dashed" aria-hidden="true"></span>
      <span class="picker-label">{m.games_picker_off_topic_label()}</span>
      <span class="picker-hint">{m.games_picker_off_topic_hint()}</span>
    </div>
  </div>

  <footer class="footer">
    <button type="button" class="ghost" onclick={onClose}>
      {m.games_picker_cancel()}
    </button>
    <button type="button" class="primary" onclick={apply}>
      {m.games_picker_apply()}
    </button>
  </footer>
</dialog>

<style>
  /* Prototype 1:1 — mirrors .picker / .picker-head / .picker-options /
   * .picker-opt / .picker-game-dot / .picker-actions from
   * docs/design/v2/ui-kit/index.html (lines 1505-1594). The native
   * <dialog> mechanics (showModal / ::backdrop / focus trap / Esc) are
   * kept for the LB-7 body-scroll-lock rule (html:has(dialog[open]))
   * — the prototype's "anchored popover above the BulkActionBar"
   * pattern is the same dialog spatially, just without the rule. */
  .games-picker {
    width: min(320px, 100vw - 32px);
    max-height: calc(100vh - 64px);
    padding: var(--s-3) var(--s-2);
    border: 1px solid var(--border-2);
    border-radius: var(--r-md);
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-elev);
  }
  .games-picker::backdrop {
    background: rgba(0, 0, 0, 0.4);
  }
  /* Header — denser than the previous treatment (~--t-13 instead of
   * --t-15) so the picker reads as a quick popover, not a heavy modal. */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 8px 6px;
  }
  .header h2 {
    font-size: var(--t-13);
    font-weight: var(--w-sb);
    color: var(--text);
    margin: 0;
  }
  .close {
    background: transparent;
    border: 0;
    color: var(--text-3);
    width: 22px;
    height: 22px;
    border-radius: 50%;
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
  }
  .close:hover {
    background: var(--surface-2);
    color: var(--text);
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 60vh;
    overflow-y: auto;
  }
  /* Each picker row — same vocabulary as .picker-opt in the prototype:
   * a horizontal flex of [check][game-dot][label] (+ hint on off-topic).
   * Hover adds a soft surface fill; on/mixed states tint via accent-soft. */
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 10px;
    border-radius: var(--r-sm);
    color: var(--text);
    font-size: var(--t-13);
    text-align: left;
  }
  .row:hover {
    background: var(--surface-2);
  }
  .row[data-state="on"] {
    background: var(--accent-soft);
  }
  .row[data-state="on"]:hover {
    background: color-mix(in oklab, var(--accent-soft) 70%, var(--surface-2));
  }
  .row.separator {
    border-top: 1px solid var(--border-hairline);
    margin-top: 4px;
    padding-top: 12px;
  }
  /* Game-color dot — 12×12 solid square for real games, dashed outline
   * for the off-topic flag (prototype docs/design/v2/ui-kit/index.html
   * lines 1568-1576). */
  .picker-game-dot {
    width: 12px;
    height: 12px;
    border-radius: 3px;
    background: var(--text-3);
    flex-shrink: 0;
  }
  .picker-game-dot.dashed {
    background: transparent;
    border: 1.5px dashed var(--text-3);
  }
  .picker-label {
    flex: 1;
    color: var(--text);
  }
  .picker-hint {
    font-size: 11px;
    color: var(--text-3);
  }
  .footer {
    display: flex;
    justify-content: flex-end;
    gap: var(--s-2);
    padding: var(--s-2) 4px 0;
    border-top: 1px solid var(--border-hairline);
    margin-top: 4px;
  }
  .ghost {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 0 var(--s-3);
    min-height: var(--hit);
    font-size: var(--t-13);
    font-weight: var(--w-md);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .ghost:hover {
    background: var(--surface-3);
    border-color: var(--border-2);
  }
  .primary {
    background: var(--accent);
    color: var(--accent-text);
    border: 1px solid var(--accent);
    border-radius: var(--r-sm);
    padding: 0 var(--s-3);
    min-height: var(--hit);
    font-size: var(--t-13);
    font-weight: var(--w-sb);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
    box-shadow:
      0 1px 0 rgba(255, 255, 255, 0.18) inset,
      0 1px 2px rgba(0, 0, 0, 0.25);
  }
  .primary:hover {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
  }
  @media (prefers-reduced-motion: reduce) {
    .ghost,
    .primary {
      transition: none;
    }
  }
</style>
