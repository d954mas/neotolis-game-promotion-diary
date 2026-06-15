<script lang="ts">
  // EventDetailGames — games section with attached chips + "Edit games"
  // button, extracted from EventDetailContent for maintainability.

  import { m } from "$lib/paraglide/messages.js";
  import { gameColor } from "$lib/util/game-color.js";
  import type { EventDto, GameDto } from "$lib/server/dto.js";

  let {
    event,
    games,
    view = "feed",
    onOpenGamesPickerForCard,
  }: {
    event: EventDto;
    games: GameDto[];
    view?: "feed" | "trash";
    onOpenGamesPickerForCard?: (id: string) => void;
  } = $props();

  const inTrash = $derived(view === "trash");

  // Off-topic flag — written by GamesPicker into metadata.triage.offTopic.
  const isOffTopic = $derived.by((): boolean => {
    const md = (event.metadata ?? {}) as { triage?: { offTopic?: boolean } };
    return md.triage?.offTopic === true;
  });

  // Iterate the canonical `games` list (server-ordered desc createdAt)
  // instead of event.gameIds — junction-row order is non-deterministic.
  const attachedGameSet = $derived(new Set(event.gameIds));
  const attachedGames = $derived(games.filter((g) => attachedGameSet.has(g.id)));
</script>

<div class="detail-section">
  <div class="detail-section-head">
    <span class="detail-section-label">{m.event_detail_section_games()}</span>
    {#if !inTrash && onOpenGamesPickerForCard}
      <button
        type="button"
        class="detail-section-edit"
        onclick={() => onOpenGamesPickerForCard?.(event.id)}
        >+ {m.feed_card_menu_edit_games()}</button
      >
    {/if}
  </div>
  <div class="detail-game-row">
    {#if attachedGames.length === 0 && !isOffTopic}
      <span class="inbox-chip">{m.inbox_badge()}</span>
    {/if}
    {#each attachedGames as g (g.id)}
      <span class="game-chip" style="--card-accent: {gameColor(g.id)};">{g.title}</span>
    {/each}
    {#if isOffTopic}
      <span class="off-topic-chip">{m.add_event_modal_off_topic()}</span>
    {/if}
  </div>
</div>

<style>
  .detail-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-top: 6px;
  }
  .detail-section-head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .detail-section-label {
    font-size: 10.5px;
    font-weight: var(--w-sb);
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }
  .detail-section-edit {
    padding: 3px 10px;
    background: transparent;
    border: 1px dashed color-mix(in oklab, var(--accent) 60%, var(--border));
    border-radius: var(--r-pill);
    color: var(--accent);
    font-size: var(--t-12);
    font-weight: var(--w-sb);
    cursor: pointer;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease);
  }
  .detail-section-edit:hover {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent-strong);
  }
  .detail-game-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .detail-game-row .game-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px 3px 14px;
    background: color-mix(in oklab, var(--card-accent, var(--border-2)) 14%, var(--surface));
    border: 1px solid color-mix(in oklab, var(--card-accent, var(--border-2)) 45%, var(--border));
    box-shadow: inset 3px 0 0 var(--card-accent, var(--border-2));
    border-radius: var(--r-pill);
    color: var(--text);
    font-size: var(--t-12);
    font-weight: var(--w-md);
    white-space: nowrap;
  }
  .detail-game-row .off-topic-chip {
    display: inline-flex;
    align-items: center;
    padding: 3px 10px;
    background: transparent;
    border: 1px dashed var(--border-2);
    border-radius: var(--r-pill);
    color: var(--text-2);
    font-size: var(--t-12);
    font-weight: var(--w-md);
  }
  .detail-game-row .inbox-chip {
    display: inline-flex;
    align-items: center;
    padding: 3px 10px;
    background: color-mix(in oklab, var(--warn) 14%, var(--surface));
    border: 1px solid color-mix(in oklab, var(--warn) 45%, var(--border));
    border-radius: var(--r-pill);
    color: var(--text-2);
    font-size: var(--t-12);
    font-weight: var(--w-md);
  }
  .inbox-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px 3px 12px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    color: var(--text-2);
    font-size: var(--t-12);
    font-weight: var(--w-md);
  }

  @media (prefers-reduced-motion: reduce) {
    .detail-section-edit {
      transition: none;
    }
  }
</style>
