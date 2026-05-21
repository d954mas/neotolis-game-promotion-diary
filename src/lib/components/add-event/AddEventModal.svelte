<script lang="ts">
  // AddEventModal — D-16 dialog wrapper around AddEventForm.
  //
  // Owns:
  //   - <dialog> element + .showModal() / .close() coordination
  //   - tryClose dirty-confirm gate (D-16): scrim click / Esc / X button
  //     all funnel through tryClose so an in-progress form doesn't get
  //     thrown away by an accidental click
  //   - 560px overlay sizing per design v2
  //
  // Does NOT own: field state, URL fetch, save mutation. Those live
  // inside AddEventForm so the route mount (which has no <dialog>) gets
  // them too.

  import AddEventForm, { type AddEventPayload } from "./AddEventForm.svelte";
  import { m } from "$lib/paraglide/messages.js";
  import type { GameDto } from "$lib/server/dto.js";

  type EventKind =
    | "youtube_video"
    | "reddit_post"
    | "twitter_post"
    | "telegram_post"
    | "discord_drop"
    | "conference"
    | "talk"
    | "press"
    | "other"
    | "post";

  let {
    open,
    games,
    initialKind = "post",
    initialAttachedGameIds = [],
    onSave,
    onClose,
  }: {
    open: boolean;
    games: GameDto[];
    initialKind?: EventKind;
    initialAttachedGameIds?: string[];
    onSave: (payload: AddEventPayload) => Promise<void>;
    onClose: () => void;
  } = $props();

  let dialogEl: HTMLDialogElement | undefined = $state();
  let dirty = $state(false);

  // Open / close the native <dialog> in response to the `open` prop.
  $effect(() => {
    if (!dialogEl) return;
    if (open && !dialogEl.open) {
      dialogEl.showModal();
    } else if (!open && dialogEl.open) {
      dialogEl.close();
    }
  });

  function tryClose(): void {
    if (dirty && !window.confirm(m.add_event_modal_dirty_confirm())) {
      return;
    }
    onClose();
  }
</script>

<dialog
  bind:this={dialogEl}
  class="add-event-modal"
  oncancel={(e) => {
    e.preventDefault();
    tryClose();
  }}
  onclick={(e) => {
    if (e.target === dialogEl) tryClose();
  }}
>
  <header class="header">
    <h2 class="header-title">{m.add_event_modal_title()}</h2>
    <button
      type="button"
      class="close-btn"
      aria-label={m.add_event_modal_close_aria()}
      onclick={tryClose}
    >
      ×
    </button>
  </header>
  <AddEventForm
    {games}
    {initialKind}
    {initialAttachedGameIds}
    onSave={async (payload) => {
      await onSave(payload);
      // Caller resets dirty by closing the modal (open=false → $effect
      // runs dialogEl.close()); we DO NOT call onClose here directly to
      // give the caller room to show the success toast first.
    }}
    onCancel={tryClose}
    onDirtyChange={(d) => (dirty = d)}
  />
</dialog>

<style>
  .add-event-modal {
    width: min(560px, 100vw - 32px);
    max-height: calc(100vh - 64px);
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--surface-2);
    color: var(--text);
    box-shadow: var(--shadow-elev);
    margin: auto;
    overflow: hidden;
  }
  .add-event-modal::backdrop {
    background: var(--overlay-dark);
  }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--s-3) var(--s-4);
    border-bottom: 1px solid var(--border-hairline);
  }
  .header-title {
    font-size: var(--t-15);
    font-weight: var(--w-sb);
    margin: 0;
    color: var(--text);
  }
  .close-btn {
    min-width: var(--hit);
    min-height: var(--hit);
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-3);
    cursor: pointer;
    font-size: var(--t-17);
    line-height: 1;
    border-radius: var(--r-sm);
    transition:
      background var(--m-fast) var(--m-ease),
      color var(--m-fast) var(--m-ease);
  }
  .close-btn:hover {
    background: var(--accent-soft);
    color: var(--accent);
  }
  @media (prefers-reduced-motion: reduce) {
    .close-btn {
      transition: none;
    }
  }
</style>
