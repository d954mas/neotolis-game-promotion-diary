<script lang="ts">
  // EventDayModal — 04-10 replacement for the EventMarkerPanel side
  // drawer/bottom sheet. A CENTERED modal over everything (modeled on
  // EventDetailModal's native <dialog> + .showModal() + the LB-7
  // html:has(dialog[open]) body-scroll-lock), NOT a docked drawer.
  //
  // Lifted to the PAGE (which owns the feed data): the chart only emits the
  // tapped CLUSTER's day(s) via onSelectCluster; this modal renders those days'
  // stats + events (04-12: a cluster chip merges several nearby event-days, so
  // the modal accepts a SET of days, not a single day).
  //
  // Layout top→bottom:
  //   1. Stats header — the total event count across the cluster's days. When
  //      the cluster is exactly ONE day, it also shows that day's wishlist delta
  //      (number + direction arrow, the D-05 day-level delta). For a multi-day
  //      cluster a single delta would be ambiguous (which day?), so only the
  //      count is shown. The delta is a DAY attribute: every event that day
  //      shares it; per-event wishlist deltas are NEVER claimed.
  //   2. The days' events as <FeedCard> rows — same vocabulary as /feed, wired
  //      with the exact props the page's events list uses (event/source/game/
  //      games). Reusing FeedCard (instead of a bespoke row) keeps one card
  //      definition.
  //
  // 04-13: a MULTI-day cluster (e.g. 27 merged with 28 on the axis) groups its
  // events under per-day <FeedDateGroupHeader>s — the SAME date separators the
  // page's events list uses — so 27 and 28 are visually distinct and individually
  // actionable even though they collapsed into one chip. A single-day cluster
  // renders the flat list (no redundant header) and keeps its delta block.
  //
  // Esc / backdrop / close button all call onClose. prefers-reduced-motion
  // gates the backdrop blur transition (via the shared dialog backdrop).

  import FeedCard from "$lib/components/FeedCard.svelte";
  import FeedDateGroupHeader from "$lib/components/FeedDateGroupHeader.svelte";
  import { m } from "$lib/paraglide/messages.js";
  import { groupEventsByDate } from "$lib/util/group-events-by-date.js";
  import type { WishlistDelta } from "$lib/server/dto.js";
  import type { CardEventLite } from "$lib/components/feed/parts/derive-card-data.js";

  type SourceLite = { id: string; displayName: string | null; handleUrl: string };
  type GameLite = { id: string; title: string };

  let {
    open,
    days,
    events,
    delta,
    sourceById,
    gameById,
    games,
    onClose,
  }: {
    open: boolean;
    /** The cluster's selected YYYY-MM-DD day(s), date-ASC (for the header). */
    days: string[];
    /** Those days' events (already filtered by the page). */
    events: CardEventLite[];
    /** The day-level wishlist delta (D-05) for a SINGLE-day cluster, or null
     *  (multi-day cluster, or no snapshot anchors it). */
    delta: WishlistDelta | null;
    sourceById: Map<string, SourceLite>;
    gameById: Map<string, GameLite>;
    games: GameLite[];
    onClose: () => void;
  } = $props();

  // Header day label: one day → that date; a multi-day cluster → "first → last".
  const dayLabel = $derived.by((): string | null => {
    if (days.length === 0) return null;
    if (days.length === 1) return days[0]!;
    return `${days[0]!} → ${days[days.length - 1]!}`;
  });
  // The delta block only makes sense for a single day (which day's delta?).
  const showDelta = $derived(days.length === 1);
  // A multi-day cluster groups events under per-day headers so 27 and 28 stay
  // distinct; a single-day cluster renders the flat list. Reuses the page's
  // groupEventsByDate helper (date-DESC iteration, same as the events feed).
  const isMultiDay = $derived(days.length > 1);
  const dayGroups = $derived(groupEventsByDate(events));

  let dialogEl: HTMLDialogElement | undefined = $state();

  // showModal()/close() driven by `open` (LB-7 scroll-lock for free). Copied
  // from EventDetailModal so the body-scroll-lock + focus-trap is identical.
  $effect(() => {
    if (!dialogEl) return;
    if (open && !dialogEl.open) dialogEl.showModal();
    else if (!open && dialogEl.open) dialogEl.close();
  });

  // Signed display ("+47" / "-12" / "0"); null → "—" (no post-event snapshot).
  function signed(n: number | null): string {
    if (n === null) return "—";
    return n > 0 ? `+${n}` : `${n}`;
  }
  // ↑ / ↓ / → direction arrow by sign.
  function arrow(n: number | null): string {
    if (n === null || n === 0) return "→";
    return n > 0 ? "↑" : "↓";
  }
</script>

<dialog
  bind:this={dialogEl}
  class="event-day-modal"
  data-testid="event-day-modal"
  aria-label={m.viz_day_events_title()}
  oncancel={(e) => {
    e.preventDefault();
    onClose();
  }}
  onclick={(e) => {
    if (e.target === dialogEl) onClose();
  }}
>
  <div class="modal-inner">
    <header class="modal-head">
      <div class="head-titles">
        <h2 class="modal-title">{m.viz_day_events_title()}</h2>
        {#if dayLabel}<span class="modal-day">{dayLabel}</span>{/if}
      </div>
      <button type="button" class="modal-close" onclick={onClose} aria-label="Close">×</button>
    </header>

    <!-- Stats header: the total event count; plus the DAY's delta (number +
         arrow) ONLY for a single-day cluster (a multi-day delta is ambiguous). -->
    <div class="day-stats" data-testid="day-stats">
      {#if showDelta}
        <div class="day-delta">
          <span class="day-delta-7d">
            {m.viz_delta_7d({ value: signed(delta?.delta7d ?? null) })}
            <span class="day-delta-arrow" aria-hidden="true">{arrow(delta?.delta7d ?? null)}</span>
          </span>
          <span class="day-delta-24h">
            {m.viz_delta_24h({ value: signed(delta?.delta24h ?? null) })}
          </span>
        </div>
      {/if}
      <span class="day-event-count">{m.viz_day_modal_event_count({ count: events.length })}</span>
    </div>

    <!-- The day's events as feed cards (same wiring as the page's events list).
         Multi-day cluster → grouped under per-day <FeedDateGroupHeader>s so each
         merged day (27 vs 28) reads as its own actionable section; single-day →
         a flat list (no redundant header). -->
    <div class="event-cards" class:grouped={isMultiDay}>
      {#if isMultiDay}
        {#each dayGroups as group (group.date)}
          <FeedDateGroupHeader occurredAt={group.occurredAt} count={group.rows.length} />
          {#each group.rows as ev (ev.id)}
            <FeedCard
              event={ev}
              source={ev.sourceId ? (sourceById.get(ev.sourceId) ?? null) : null}
              game={ev.gameIds.length > 0 ? (gameById.get(ev.gameIds[0]!) ?? null) : null}
              {games}
            />
          {/each}
        {/each}
      {:else}
        {#each events as ev (ev.id)}
          <FeedCard
            event={ev}
            source={ev.sourceId ? (sourceById.get(ev.sourceId) ?? null) : null}
            game={ev.gameIds.length > 0 ? (gameById.get(ev.gameIds[0]!) ?? null) : null}
            {games}
          />
        {/each}
      {/if}
    </div>
  </div>
</dialog>

<style>
  /* Centered modal — mirrors EventDetailModal .detail-modal sizing so the
   * marker-click surface reads as the same dialog vocabulary as the rest of
   * the app (NOT the old docked drawer). */
  .event-day-modal[open] {
    display: flex;
    flex-direction: column;
  }
  .event-day-modal {
    width: min(680px, calc(100vw - 32px));
    max-height: min(86vh, 820px);
    padding: 0;
    border: 1px solid var(--border-2);
    border-radius: var(--r-lg);
    background: var(--surface);
    box-shadow: var(--shadow-elev);
    color: var(--text);
    margin: auto;
    overflow: hidden;
  }
  .event-day-modal::backdrop {
    background: var(--overlay-dark);
    backdrop-filter: blur(2px) saturate(120%);
    -webkit-backdrop-filter: blur(2px) saturate(120%);
  }
  @media (prefers-reduced-motion: reduce) {
    .event-day-modal::backdrop {
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }
  }
  @media (max-width: 640px) {
    .event-day-modal {
      width: calc(100vw - 12px);
      max-height: calc(100vh - 12px);
    }
  }

  .modal-inner {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-2);
    padding: var(--s-3) var(--s-4);
    border-bottom: 1px solid var(--border-hairline);
    flex-shrink: 0;
  }
  .head-titles {
    display: flex;
    align-items: baseline;
    gap: var(--s-2);
    min-width: 0;
  }
  .modal-title {
    margin: 0;
    font-size: var(--t-15, 15px);
    font-weight: var(--w-sb);
    color: var(--text);
  }
  .modal-day {
    font-size: var(--t-13);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .modal-close {
    width: 30px;
    height: 30px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r-sm);
    color: var(--text-3);
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
    flex-shrink: 0;
  }
  .modal-close:hover {
    background: var(--surface-2);
    color: var(--text);
  }

  /* Stats header — day delta block (number + arrow) alongside the event count. */
  .day-stats {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-3);
    padding: var(--s-3) var(--s-4);
    border-bottom: 1px solid var(--border-hairline);
    flex-shrink: 0;
  }
  .day-delta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .day-delta-7d {
    font-size: var(--t-18, 18px);
    font-weight: var(--w-sb);
    color: var(--text);
    font-variant-numeric: tabular-nums;
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
  }
  .day-delta-arrow {
    font-size: var(--t-15, 15px);
  }
  .day-delta-24h {
    font-size: var(--t-13);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .day-event-count {
    font-size: var(--t-13);
    color: var(--text-2);
    font-weight: var(--w-md);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .event-cards {
    flex: 1;
    overflow-y: auto;
    padding: var(--s-4);
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
    min-height: 0;
  }
  /* Per-day grouping (multi-day cluster): the shared FeedDateGroupHeader is
   * sticky to the page chrome on /feed; inside this scrolling modal it must
   * stick to the TOP of the scroll area instead (no chrome offset) and sit on
   * the modal surface, not the page bg. */
  .event-cards.grouped :global(.date-head) {
    top: calc(-1 * var(--s-4));
    background: var(--surface);
    padding-top: var(--s-2);
  }
</style>
