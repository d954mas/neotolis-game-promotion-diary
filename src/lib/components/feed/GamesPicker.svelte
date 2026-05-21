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

  // Mutex with off-topic: a row attached to ≥1 game CANNOT also be
  // marked off-topic (server enforces `standalone_conflicts_with_game`).
  // Reflect that in the UI:
  //   - Turning a game ON force-clears off-topic (off-topic → off)
  //   - Turning off-topic ON force-clears all games (all → off)
  function setGameState(gid: string, next: "on" | "off"): void {
    gameStates = { ...gameStates, [gid]: next };
    if (next === "on" && offTopicState !== "off") {
      offTopicState = "off";
    }
  }

  function setOffTopicState(next: "on" | "off"): void {
    offTopicState = next;
    if (next === "on") {
      const cleared: Record<string, "on" | "off" | "mixed"> = {};
      for (const k of Object.keys(gameStates)) cleared[k] = "off";
      gameStates = cleared;
    }
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
    <button
      type="button"
      class="close"
      aria-label={m.games_picker_close_aria()}
      onclick={onClose}
    >
      ×
    </button>
  </header>

  <div class="body">
    {#each games as g (g.id)}
      <div class="row">
        <TriStateCheckbox
          state={gameStates[g.id] ?? "off"}
          onchange={(next) => setGameState(g.id, next)}
          label={g.title}
        />
      </div>
    {/each}
    <div class="row separator">
      <TriStateCheckbox
        state={offTopicState}
        onchange={setOffTopicState}
        label={m.games_picker_off_topic_label()}
      />
      <span class="hint">{m.games_picker_off_topic_hint()}</span>
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
  /* Reset the browser-default dialog box treatment so v2 tokens drive
   * appearance. The native dialog element handles focus trap + Esc; we
   * only restyle the box and the ::backdrop. */
  .games-picker {
    width: min(420px, 100vw - 32px);
    max-height: calc(100vh - 64px);
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--surface-2);
    color: var(--text);
    box-shadow: var(--shadow-elev);
  }
  .games-picker::backdrop {
    background: var(--overlay-dark);
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--s-3) var(--s-4);
    border-bottom: 1px solid var(--border-hairline);
  }
  .header h2 {
    font-size: var(--t-15);
    font-weight: var(--w-sb);
    margin: 0;
  }
  .close {
    background: transparent;
    border: none;
    color: var(--text-3);
    cursor: pointer;
    font-size: var(--t-17);
    line-height: 1;
  }
  .close:hover {
    color: var(--text);
  }
  .body {
    padding: var(--s-3) var(--s-4);
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    max-height: 60vh;
    overflow-y: auto;
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    padding: var(--s-1) 0;
  }
  .row.separator {
    border-top: 1px solid var(--border-hairline);
    padding-top: var(--s-3);
    margin-top: var(--s-2);
  }
  .hint {
    font-size: var(--t-12);
    color: var(--text-3);
  }
  .footer {
    display: flex;
    justify-content: flex-end;
    gap: var(--s-2);
    padding: var(--s-3) var(--s-4);
    border-top: 1px solid var(--border-hairline);
  }
  .ghost {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: var(--r-sm);
    padding: var(--s-2) var(--s-3);
    cursor: pointer;
    min-height: var(--hit);
    transition: background var(--m-fast) var(--m-ease);
  }
  .ghost:hover {
    background: var(--surface);
  }
  .primary {
    background: var(--accent);
    color: var(--accent-text);
    border: 1px solid var(--accent);
    border-radius: var(--r-sm);
    padding: var(--s-2) var(--s-3);
    cursor: pointer;
    min-height: var(--hit);
    transition: background var(--m-fast) var(--m-ease);
  }
  .primary:hover {
    background: var(--accent-strong);
  }
  @media (prefers-reduced-motion: reduce) {
    .ghost,
    .primary {
      transition: none;
    }
  }
</style>
