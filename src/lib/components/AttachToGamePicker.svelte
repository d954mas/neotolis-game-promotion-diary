<script lang="ts">
  // AttachToGamePicker — inline picker for the per-row "Attach to game"
  // affordance on FeedRow (UI-SPEC §"Component inventory" + §"/feed row
  // interaction contract" point 4). Three workflows:
  //
  //   1. Pick a game → PATCH /api/events/:id/attach with {gameIds: [X]}
  //      (round-3 picker is single-select; Plan 02.1-32 multi-select swap
  //      is staged behind the back-compat alias which the route accepts).
  //   2. "Move to inbox" → PATCH /api/events/:id/attach with {gameIds: []}
  //   3. "Mark not game-related" → PATCH /api/events/:id/dismiss-inbox
  //
  // Plan 02.1-28: switches from {gameId} to {gameIds} on the wire while
  // preserving the single-select UX for round-3 UAT. The full multi-
  // select rebuild lands in Plan 02.1-32 (separate plan; declares
  // depends_on: ["02.1-28"]).
  //
  // Closed state: a button labeled "Attach to game" (no game) or the matched
  // game's title (game attached).
  //
  // Open state: anchored dropdown listing the user's games + a divider +
  // "Move to inbox" + "Mark not game-related" options. Esc closes the
  // dropdown (UI-SPEC §"/feed row interaction contract" point 4).
  //
  // CONTEXT D-08: mobile open-state is the inline anchored dropdown
  // (NOT a bottom-sheet <dialog>). Bottom-sheet variant is filed for Phase 6
  // polish if UAT surfaces clipping at 360px on users with >10 games.
  //
  // CONTEXT D-14: when the user has ZERO games, render an inline link
  // "No games yet — + Add a game" via m.feed_attach_no_games_inline()
  // (the 0-games + source-registration onboarding case).
  //
  // Accessibility (UI-SPEC §"Accessibility Floor delta"): the trigger is a
  // <button>; the dropdown has role="menu" with role="menuitem" children.
  // Esc closes; clicking outside closes.

  import { m } from "$lib/paraglide/messages.js";
  import InlineError from "./InlineError.svelte";

  type EventForPicker = {
    id: string;
    // Plan 02.1-28 (M:N migration): the picker now reads gameIds[] from
    // the EventDto. Round-3 single-select UX surfaces the FIRST attached
    // game as the trigger label (matchedGame derivation below); Plan
    // 02.1-32 swaps for full multi-select.
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
    // Plan 02.1-32 (UAT-NOTES.md §4.24.F): compact-mode trigger for the
    // /feed inbox card surface. Reduces visual weight (smaller font,
    // lighter background, shrunken padding) and swaps the trigger label
    // to m.feed_card_attach_compact_label() (`"Attach"`). The expanded
    // dropdown menu is unchanged — only the trigger button shrinks.
    // The /events/[id]/edit form usage stays on the default (full-size)
    // picker.
    compact?: boolean;
  } = $props();

  let open = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  // Plan 02.1-28: pick the first attached game for the round-3 trigger
  // label. Multi-game events render the first; Plan 02.1-32's multi-select
  // surface will replace this with a full chip cluster.
  const matchedGame = $derived.by(() => {
    if (event.gameIds.length === 0) return null;
    const firstId = event.gameIds[0]!;
    return games.find((g) => g.id === firstId) ?? null;
  });
  // Plan 02.1-32 (UAT-NOTES.md §4.24.F): compact-mode trigger always shows
  // the short label regardless of attached state — the inbox-card use case
  // never has an attached game (the picker is hidden via isInboxRow gate
  // when gameIds.length > 0), so the matched-game branch is unreachable
  // in compact mode. The defensive `matchedGame` check below preserves
  // round-trip safety if a future caller passes compact=true with a
  // non-empty gameIds[].
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
      // Plan 02.1-28: send the canonical {gameIds: string[]} shape.
      // Empty array === "move to inbox" (replaces the legacy {gameId: null}).
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
  .picker {
    position: relative;
    display: inline-flex;
    flex-direction: column;
    gap: var(--space-xs);
  }
  .trigger {
    min-height: 44px;
    padding: 0 var(--space-md);
    background: var(--color-surface);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-semibold);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: var(--space-xs);
    white-space: nowrap;
  }
  .trigger:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  /* Plan 02.1-32 (UAT-NOTES.md §4.24.F): compact-mode trigger shrinks the
   * visual weight of the inline picker on inbox cards. User quote:
   * "это кнопка ее сделать меньше, это по сути просто быстрый способ
   * разбирать инбокс". Smaller font, lighter (transparent) background,
   * tighter padding, muted color — the picker reads as a quick-action
   * affordance instead of competing with the card's primary content. */
  .trigger.compact {
    min-height: 0;
    padding: var(--space-xs) var(--space-sm);
    background: transparent;
    color: var(--color-text-muted);
    font-size: var(--font-size-small, var(--font-size-label));
    font-weight: var(--font-weight-regular, normal);
  }
  .chev {
    color: var(--color-text-muted);
  }
  .menu {
    position: absolute;
    top: calc(100% + var(--space-xs));
    left: 0;
    z-index: 20;
    min-width: 220px;
    max-height: 360px;
    overflow-y: auto;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    box-shadow: 0 4px 12px rgb(0 0 0 / 15%);
    padding: var(--space-xs);
    display: flex;
    flex-direction: column;
  }
  .opt {
    min-height: 44px;
    padding: 0 var(--space-md);
    text-align: left;
    background: transparent;
    color: var(--color-text);
    border: none;
    border-radius: 2px;
    font-size: var(--font-size-body);
    cursor: pointer;
  }
  .opt:hover:not(:disabled) {
    background: var(--color-bg);
  }
  .opt:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .divider {
    height: 1px;
    background: var(--color-border);
    margin: var(--space-xs) 0;
  }
  .empty-games {
    padding: var(--space-sm) var(--space-md);
    font-size: var(--font-size-label);
  }
  .empty-games a {
    color: var(--color-accent);
    text-decoration: none;
  }
  .empty-games a:hover {
    text-decoration: underline;
  }
  .more-hint {
    padding: var(--space-xs) var(--space-md);
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
  }
</style>
