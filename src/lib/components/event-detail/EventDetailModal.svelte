<script lang="ts">
  // EventDetailModal — D-05 dialog wrapper around EventDetailContent.
  //
  // Owns:
  //   - <dialog> element + .showModal() inside $effect
  //   - oncancel (Esc / system close) → onClose
  //   - onclick on the <dialog> itself (scrim click) → onClose
  //   - 760px overlay sizing per D-05
  //   - body-scroll-lock (LB-7) is handled by the browser when <dialog>
  //     has been opened via .showModal()
  //
  // Does NOT own: keyboard arrow nav, inline-edit drafts, footer actions.
  // Those live inside EventDetailContent so the route mount (which has
  // no <dialog> wrapper) gets them too.

  import EventDetailContent from "./EventDetailContent.svelte";
  import type { EventDto, GameDto, DataSourceDto } from "$lib/server/dto.js";
  import type { EventMetricSeries } from "$lib/sources/adapter.js";

  type EventUpdatePatch = Partial<{
    title: string;
    notes: string | null;
    url: string | null;
    authorIsMe: boolean;
  }>;

  let {
    event,
    games,
    sources,
    metricSeries = undefined,
    view = "feed",
    currentUserName = "",
    onClose,
    onDelete,
    onRestore,
    onDeleteForever,
    onUpdate,
    onOpenGamesPickerForCard,
  }: {
    event: EventDto;
    games: GameDto[];
    sources: DataSourceDto[];
    /** VIZ-01 series threaded straight to EventDetailContent (D-14).
     *  undefined (default — no caller threads it) → EventDetailContent lazy-
     *  fetches the endpoint for the opened event. A provided [] would suppress
     *  that fetch, so the modal must forward undefined, not []. */
    metricSeries?: EventMetricSeries[];
    view?: "feed" | "trash";
    currentUserName?: string;
    onClose: () => void;
    onDelete: (id: string) => Promise<void>;
    onRestore?: (id: string) => Promise<void>;
    onOpenGamesPickerForCard?: (id: string) => void;
    onDeleteForever?: (id: string) => Promise<void>;
    onUpdate: (id: string, patch: EventUpdatePatch) => Promise<void>;
  } = $props();

  let dialogEl: HTMLDialogElement | undefined = $state();

  $effect(() => {
    if (!dialogEl) return;
    if (!dialogEl.open) dialogEl.showModal();
    return () => {
      if (dialogEl && dialogEl.open) dialogEl.close();
    };
  });
</script>

<dialog
  bind:this={dialogEl}
  class="event-detail-modal"
  aria-label="Event details"
  oncancel={(e) => {
    e.preventDefault();
    onClose();
  }}
  onclick={(e) => {
    if (e.target === dialogEl) onClose();
  }}
>
  <EventDetailContent
    {event}
    {games}
    {sources}
    {metricSeries}
    {view}
    {currentUserName}
    {onClose}
    {onDelete}
    {onRestore}
    {onDeleteForever}
    {onUpdate}
    {onOpenGamesPickerForCard}
  />
</dialog>

<style>
  /* D-05 + prototype .detail-modal — centered dialog up to 760px wide,
   * max-height = min(86vh, 820px) so the dialog never hugs the viewport
   * edge. Mirrors docs/design/v2/ui-kit/index.html .detail-modal. */
  .event-detail-modal[open] {
    display: flex;
    flex-direction: column;
  }
  .event-detail-modal {
    width: min(760px, calc(100vw - 32px));
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
  .event-detail-modal::backdrop {
    background: var(--overlay-dark);
    backdrop-filter: blur(2px) saturate(120%);
    -webkit-backdrop-filter: blur(2px) saturate(120%);
  }
  @media (max-width: 640px) {
    .event-detail-modal {
      width: calc(100vw - 12px);
      max-height: calc(100vh - 12px);
    }
  }
</style>
