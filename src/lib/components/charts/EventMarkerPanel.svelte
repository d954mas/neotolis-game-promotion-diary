<script lang="ts">
  // EventMarkerPanel — D-02 responsive detail surface for a wishlist-chart
  // marker click. ONE <dialog>, NOT two components: the drawer-vs-sheet
  // difference is pure CSS.
  //
  //   - >=600px : docks RIGHT as a drawer (height:100vh, width:min(420px,90vw)),
  //               so the correlation chart stays visible to the LEFT — the
  //               whole point is comparing event ↔ wishlist-line reaction.
  //   - <600px  : docks BOTTOM as a sheet (width:100vw, max-height:70vh), so
  //               the chart stays visible ABOVE; the internal list scrolls.
  //
  // 600px is the D-02 breakpoint (NOT the 640px EventDetailModal mobile point).
  //
  // showModal() (the EventDetailModal LB-7 pattern) triggers the global
  // `html:has(dialog[open]) { overflow: hidden }` body-scroll-lock for free.
  // The slide-in is gated by prefers-reduced-motion.
  //
  // Body (D-03/D-04/D-05):
  //   1. The DAY's wishlist delta ONCE — number + direction arrow ("+47 за 7д ↑")
  //      plus the 24h figure. The delta is a DAY attribute (D-05): every event
  //      on this day shares it; per-event wishlist deltas are NEVER claimed.
  //   2. The day's event LIST — one row per event with its OWN platform metrics
  //      (YouTube views/likes/comments via EventDetailStats). Clicking a row
  //      expands that event's full detail (EventDetailContent, read-only here —
  //      the panel is a comparison surface, not an editor).

  import KindIcon from "$lib/components/KindIcon.svelte";
  import EventDetailStats from "$lib/components/event-detail/EventDetailStats.svelte";
  import EventDetailContent from "$lib/components/event-detail/EventDetailContent.svelte";
  import { m } from "$lib/paraglide/messages.js";
  import type { EventDto, GameDto, DataSourceDto, WishlistDelta } from "$lib/server/dto.js";

  let {
    dayEvents,
    delta,
    sources,
    games,
    onClose,
  }: {
    dayEvents: EventDto[];
    delta: WishlistDelta | null;
    sources: DataSourceDto[];
    games: GameDto[];
    onClose: () => void;
  } = $props();

  let dialogEl: HTMLDialogElement | undefined = $state();

  // showModal() on mount (LB-7 scroll-lock); close() on unmount — copied
  // verbatim from EventDetailModal so the body-scroll-lock + focus-trap
  // behavior is identical.
  $effect(() => {
    if (!dialogEl) return;
    if (!dialogEl.open) dialogEl.showModal();
    return () => {
      if (dialogEl && dialogEl.open) dialogEl.close();
    };
  });

  // Signed display ("+47" / "-12" / "0") for the day delta number. null →
  // render "—" (no post-event snapshot to anchor the window, D-05).
  function signed(n: number | null): string {
    if (n === null) return "—";
    return n > 0 ? `+${n}` : `${n}`;
  }

  // ↑ / ↓ / → direction arrow by sign. null delta gets no arrow.
  function arrow(n: number | null): string {
    if (n === null || n === 0) return "→";
    return n > 0 ? "↑" : "↓";
  }

  // Expanded single-event detail (D-04: click a row → its full detail). null
  // = list view; an id = that event is expanded. Read-only: the panel is a
  // comparison surface, so the mutation callbacks are no-ops.
  let expandedId = $state<string | null>(null);
  const expandedEvent = $derived(
    expandedId ? (dayEvents.find((e) => e.id === expandedId) ?? null) : null,
  );

  const noopUpdate = async (): Promise<void> => {};

  // Variant attribute so the browser test can assert drawer-vs-sheet without
  // reading computed CSS. matchMedia is client-only; default "drawer" under
  // SSR keeps the markup deterministic before hydration.
  const variant = $derived.by((): "drawer" | "sheet" => {
    if (typeof window === "undefined") return "drawer";
    return window.matchMedia("(max-width: 600px)").matches ? "sheet" : "drawer";
  });
</script>

<dialog
  bind:this={dialogEl}
  class="event-marker-panel"
  data-testid="event-marker-panel"
  data-variant={variant}
  aria-label={m.viz_day_events_title()}
  oncancel={(e) => {
    e.preventDefault();
    onClose();
  }}
  onclick={(e) => {
    if (e.target === dialogEl) onClose();
  }}
>
  <div class="panel-inner">
    <header class="panel-head">
      <h2 class="panel-title">{m.viz_day_events_title()}</h2>
      <button type="button" class="panel-close" onclick={onClose} aria-label="Close">×</button>
    </header>

    {#if expandedEvent}
      <!-- D-04: an event row expanded to its full detail (read-only). -->
      <div class="panel-body">
        <button type="button" class="back-row" onclick={() => (expandedId = null)}>
          ‹ {m.viz_day_events_title()}
        </button>
        <EventDetailContent
          event={expandedEvent}
          {games}
          {sources}
          view="feed"
          onClose={() => (expandedId = null)}
          onDelete={noopUpdate}
          onUpdate={noopUpdate}
        />
      </div>
    {:else}
      <div class="panel-body">
        <!-- D-03/D-05: the DAY's delta shown ONCE (number + arrow). -->
        <div class="day-delta" data-testid="day-delta">
          <span class="day-delta-7d">
            {m.viz_delta_7d({ value: signed(delta?.delta7d ?? null) })}
            <span class="day-delta-arrow" aria-hidden="true">{arrow(delta?.delta7d ?? null)}</span>
          </span>
          <span class="day-delta-24h">
            {m.viz_delta_24h({ value: signed(delta?.delta24h ?? null) })}
          </span>
        </div>

        <!-- D-04: the day's event list, each with its OWN platform metrics. -->
        <ul class="event-list">
          {#each dayEvents as ev (ev.id)}
            <li>
              <button type="button" class="event-row" onclick={() => (expandedId = ev.id)}>
                <span class="event-row-icon"><KindIcon kind={ev.kind} size={18} /></span>
                <span class="event-row-title">{ev.title}</span>
              </button>
              {#if ev.stats}
                <EventDetailStats stats={ev.stats} />
              {/if}
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>
</dialog>

<style>
  /* ONE dialog. Default (>=600px) = right-side drawer; @media (max-width:600px)
   * = bottom sheet. The drawer/sheet split is pure CSS on the same element. */
  .event-marker-panel {
    padding: 0;
    border: 1px solid var(--border-2);
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-elev);
    /* Drawer: dock right, full height. margin-left:auto pushes it to the
     * right edge so the chart stays visible to the left. */
    margin-left: auto;
    margin-right: 0;
    margin-top: 0;
    margin-bottom: 0;
    height: 100vh;
    max-height: 100vh;
    width: min(420px, 90vw);
    max-width: 90vw;
    border-radius: 0;
    border-top-left-radius: var(--r-lg);
    border-bottom-left-radius: var(--r-lg);
    /* Slide in from the right. */
    transform: translateX(0);
    transition: transform var(--m-base, 200ms) var(--m-ease, ease);
  }
  .event-marker-panel::backdrop {
    background: var(--overlay-dark);
  }
  .event-marker-panel[open] {
    display: flex;
    flex-direction: column;
  }

  @media (max-width: 600px) {
    .event-marker-panel {
      /* Bottom sheet: dock bottom, chart stays visible above. */
      margin-top: auto;
      margin-bottom: 0;
      margin-left: 0;
      margin-right: 0;
      height: auto;
      max-height: 70vh;
      width: 100vw;
      max-width: 100vw;
      border-radius: 0;
      border-top-left-radius: var(--r-lg);
      border-top-right-radius: var(--r-lg);
    }
  }

  /* prefers-reduced-motion gates the slide (AGENTS.md). */
  @media (prefers-reduced-motion: reduce) {
    .event-marker-panel {
      transition: none;
    }
  }

  .panel-inner {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-2);
    padding: var(--s-3) var(--s-4);
    border-bottom: 1px solid var(--border-hairline);
    flex-shrink: 0;
  }
  .panel-title {
    margin: 0;
    font-size: var(--t-15, 15px);
    font-weight: var(--w-sb);
    color: var(--text);
  }
  .panel-close {
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
  }
  .panel-close:hover {
    background: var(--surface-2);
    color: var(--text);
  }
  .panel-body {
    flex: 1;
    overflow-y: auto;
    padding: var(--s-4);
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
    min-height: 0;
  }

  /* Day delta block (D-03/D-05) — number + arrow, shown ONCE. */
  .day-delta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--s-3);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
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

  .event-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }
  .event-list > li {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-bottom: var(--s-3);
    border-bottom: 1px solid var(--border-hairline);
  }
  .event-list > li:last-child {
    border-bottom: 0;
    padding-bottom: 0;
  }
  .event-row {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    width: 100%;
    background: transparent;
    border: 0;
    padding: 4px 0;
    text-align: left;
    cursor: pointer;
    color: var(--text);
    font: inherit;
  }
  .event-row-icon {
    flex-shrink: 0;
    display: inline-flex;
  }
  .event-row-title {
    flex: 1;
    min-width: 0;
    font-size: var(--t-14);
    font-weight: var(--w-md);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .event-row:hover .event-row-title {
    color: var(--accent);
  }

  .back-row {
    align-self: flex-start;
    background: transparent;
    border: 0;
    padding: 0 0 var(--s-2);
    color: var(--accent);
    font-size: var(--t-13);
    font-weight: var(--w-sb);
    cursor: pointer;
  }
</style>
