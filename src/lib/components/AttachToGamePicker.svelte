<script lang="ts">
  // AttachToGamePicker — inline picker for the per-row "Attach to game"
  // affordance on FeedRow. Three workflows:
  //
  //   1. Pick a game → PATCH /api/events/:id/attach with {gameIds: [X]}
  //      (single-select UI surface; the route accepts the canonical
  //      multi-select shape).
  //   2. "Move to inbox" → PATCH /api/events/:id/attach with {gameIds: []}
  //   3. "Mark not game-related" → PATCH /api/events/:id/dismiss-inbox
  //
  // Closed state: a button labeled "Attach to game" (no game) or the matched
  // game's title (game attached).
  //
  // Open state: anchored dropdown listing the user's games + a divider +
  // "Move to inbox" + "Mark not game-related" options. Esc closes the
  // dropdown.
  //
  // Mobile open-state is the inline anchored dropdown (NOT a bottom-sheet
  // <dialog>). Bottom-sheet variant is filed for future polish if UAT
  // surfaces clipping at 360px on users with >10 games.
  //
  // When the user has ZERO games, render an inline link
  // "No games yet — + Add a game" via m.feed_attach_no_games_inline()
  // (the 0-games + source-registration onboarding case).
  //
  // Accessibility: the trigger is a <button>; the dropdown has role="menu"
  // with role="menuitem" children. Esc closes; clicking outside closes.

  import { m } from "$lib/paraglide/messages.js";
  import InlineError from "./InlineError.svelte";

  type EventForPicker = {
    id: string;
    // The picker reads gameIds[] from the EventDto. Single-select UX
    // surfaces the FIRST attached game as the trigger label (matchedGame
    // derivation below).
    gameIds: string[];
  };
  type GameOption = {
    id: string;
    title: string;
  };

  let {
    event,
    games,
    onChanged,
    compact = false,
  }: {
    event: EventForPicker;
    games: GameOption[];
    onChanged?: () => void;
    // Compact-mode trigger for the /feed inbox card surface. Reduces
    // visual weight (smaller font, lighter background, shrunken padding)
    // and swaps the trigger label to m.feed_card_attach_compact_label()
    // (`"Attach"`). The expanded dropdown menu is unchanged — only the
    // trigger button shrinks. The /events/[id]/edit form usage stays on
    // the default (full-size) picker.
    compact?: boolean;
  } = $props();

  let open = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  // Pick the first attached game for the trigger label. Multi-game events
  // render the first.
  const matchedGame = $derived.by(() => {
    if (event.gameIds.length === 0) return null;
    const firstId = event.gameIds[0]!;
    return games.find((g) => g.id === firstId) ?? null;
  });
  // Compact-mode trigger always shows the short label regardless of
  // attached state — the inbox-card use case never has an attached game
  // (the picker is hidden via isInboxRow gate when gameIds.length > 0),
  // so the matched-game branch is unreachable in compact mode. The
  // defensive `matchedGame` check below preserves round-trip safety if a
  // future caller passes compact=true with a non-empty gameIds[].
  const triggerLabel = $derived.by(() => {
    if (compact) return m.feed_card_attach_compact_label();
    return matchedGame ? matchedGame.title : m.feed_attach_to_game();
  });

  function toggle(): void {
    if (busy) return;
    open = !open;
    error = null;
  }
  function close(): void {
    open = false;
  }
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape" && open) {
      e.stopPropagation();
      close();
    }
  }

  async function attach(gameId: string | null): Promise<void> {
    if (busy) return;
    busy = true;
    error = null;
    try {
      // Send the canonical {gameIds: string[]} shape. Empty array ===
      // "move to inbox".
      const gameIds = gameId === null ? [] : [gameId];
      const res = await fetch(`/api/events/${event.id}/attach`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gameIds }),
      });
      if (!res.ok) {
        if (res.status === 404) error = m.feed_attach_error_game_not_found();
        else if (res.status === 422) {
          const body = (await res.json().catch(() => ({}))) as {
            metadata?: { game?: { title?: string } };
          };
          const title = body.metadata?.game?.title ?? "";
          error = m.feed_attach_error_already_attached({ title });
        } else error = m.error_server_generic();
        return;
      }
      open = false;
      onChanged?.();
    } catch {
      error = m.error_network();
    } finally {
      busy = false;
    }
  }

  async function dismiss(): Promise<void> {
    if (busy) return;
    busy = true;
    error = null;
    try {
      const res = await fetch(`/api/events/${event.id}/dismiss-inbox`, {
        method: "PATCH",
      });
      if (!res.ok) {
        if (res.status === 422) error = m.feed_dismiss_error_not_in_inbox();
        else error = m.error_server_generic();
        return;
      }
      open = false;
      onChanged?.();
    } catch {
      error = m.error_network();
    } finally {
      busy = false;
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="picker">
  <button
    type="button"
    class="trigger"
    class:compact
    onclick={toggle}
    disabled={busy}
    aria-haspopup="menu"
    aria-expanded={open}
  >
    <span class="trigger-label">{triggerLabel}</span>
    <span class="chev" aria-hidden="true">▾</span>
  </button>

  {#if open}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="menu" role="menu" tabindex="-1">
      {#if games.length === 0}
        <div class="empty-games">
          <a href="/games?new=1">{m.feed_attach_no_games_inline()}</a>
        </div>
      {:else}
        {#each games.slice(0, 10) as g (g.id)}
          <button
            type="button"
            class="opt"
            role="menuitem"
            onclick={() => attach(g.id)}
            disabled={busy}
          >
            {g.title}
          </button>
        {/each}
        {#if games.length > 10}
          <div class="more-hint">+ {games.length - 10} more — narrow with filters</div>
        {/if}
      {/if}
      <div class="divider" role="separator"></div>
      <button
        type="button"
        class="opt"
        role="menuitem"
        onclick={() => attach(null)}
        disabled={busy || event.gameIds.length === 0}
      >
        {m.feed_move_to_inbox()}
      </button>
      <button
        type="button"
        class="opt"
        role="menuitem"
        onclick={dismiss}
        disabled={busy || event.gameIds.length > 0}
      >
        {m.feed_dismiss_from_inbox()}
      </button>
    </div>
  {/if}

  {#if error}
    <InlineError message={error} />
  {/if}
</div>

<style>
  /* v2 popover picker — --surface-2 panel + --shadow-elev + --r-md.
   * Compact-mode trigger shrinks padding for inbox card surfaces. */
  .picker {
    position: relative;
    display: inline-flex;
    flex-direction: column;
    gap: var(--s-1);
  }
  .trigger {
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
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    white-space: nowrap;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .trigger:hover:not(:disabled) {
    background: var(--accent-soft);
    border-color: var(--accent-strong);
  }
  .trigger:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  /* Compact-mode trigger shrinks the visual weight of the inline picker
   * on inbox cards. User quote: "это кнопка ее сделать меньше, это по
   * сути просто быстрый способ разбирать инбокс". */
  .trigger.compact {
    min-height: 0;
    padding: var(--s-1) var(--s-2);
    background: transparent;
    border-color: transparent;
    color: var(--text-3);
    font-size: var(--t-12);
    font-weight: var(--w-rg);
  }
  .trigger.compact:hover:not(:disabled) {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: transparent;
  }
  .chev {
    color: var(--text-3);
  }
  .menu {
    position: absolute;
    top: calc(100% + var(--s-1));
    left: 0;
    z-index: 20;
    min-width: 240px;
    max-height: 360px;
    overflow-y: auto;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-elev);
    padding: var(--s-2);
    display: flex;
    flex-direction: column;
  }
  .opt {
    min-height: var(--hit);
    padding: var(--s-2) var(--s-3);
    text-align: left;
    background: transparent;
    color: var(--text);
    border: none;
    border-radius: var(--r-sm);
    font-family: var(--f-sans);
    font-size: var(--t-13);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease);
  }
  .opt:hover:not(:disabled) {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .opt:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .divider {
    height: 1px;
    background: var(--border-hairline);
    margin: var(--s-1) 0;
  }
  .empty-games {
    padding: var(--s-2) var(--s-3);
    font-size: var(--t-13);
    color: var(--text-2);
  }
  .empty-games a {
    color: var(--accent);
    text-decoration: none;
  }
  .empty-games a:hover {
    color: var(--accent-strong);
    text-decoration: underline;
  }
  .more-hint {
    padding: var(--s-1) var(--s-3);
    font-size: var(--t-12);
    color: var(--text-3);
  }
  @media (prefers-reduced-motion: reduce) {
    .trigger,
    .opt {
      transition: none;
    }
  }
</style>
