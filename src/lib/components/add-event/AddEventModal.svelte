<script lang="ts">
  // AddEventModal — D-16 dialog wrapper around AddEventForm.
  //
  // Visual contract: 1:1 with docs/design/v2/ui-kit/add-event-modal.jsx
  // + .modal / .modal-head / .modal-body / .modal-foot CSS rules in
  // docs/design/v2/ui-kit/index.html.
  //
  // Owns:
  //   - <dialog> element + .showModal() / .close() coordination.
  //   - tryClose dirty-confirm gate (D-16): scrim click / Esc / × button
  //     all funnel through tryClose so an in-progress form doesn't get
  //     thrown away by an accidental click.
  //   - 560px overlay sizing per design v2.
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
    currentUserName = "",
    onSave,
    onClose,
  }: {
    open: boolean;
    games: GameDto[];
    initialKind?: EventKind;
    initialAttachedGameIds?: string[];
    currentUserName?: string;
    onSave: (payload: AddEventPayload) => Promise<void>;
    onClose: () => void;
  } = $props();

  let dialogEl: HTMLDialogElement | undefined = $state();
  let dirty = $state(false);

  // Open / close the native <dialog> in response to the `open` prop.
  // SSR-safe note: $effect only runs in the browser, never during SSR.
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
  class="add-event-modal modal"
  oncancel={(e) => {
    e.preventDefault();
    tryClose();
  }}
  onclick={(e) => {
    if (e.target === dialogEl) tryClose();
  }}
>
  <header class="modal-head">
    <h2 class="modal-title">{m.add_event_modal_title()}</h2>
    <button
      type="button"
      class="modal-close"
      aria-label={m.add_event_modal_close_aria()}
      onclick={tryClose}
    >×</button>
  </header>
  {#key open}
    <!-- Remount the form per open-cycle so previously-entered values
         (title / url / notes / kind / fetched-state) don't leak into a
         fresh "Add event" attempt. User UAT: «после создания события
         когда я хочу добавить новое на этом окне старые введённые
         данные». The dialog itself stays mounted (it has its own state +
         body-scroll-lock contract); only the form's local state resets. -->
    <AddEventForm
      {games}
      {initialKind}
      {initialAttachedGameIds}
      {currentUserName}
      onSave={async (payload) => {
        await onSave(payload);
      }}
      onCancel={tryClose}
      onDirtyChange={(d) => (dirty = d)}
    />
  {/key}
</dialog>

<style>
  /* Prototype 1:1 — mirrors .modal / .modal-head / .modal-title /
   * .modal-close from docs/design/v2/ui-kit/index.html.
   *
   * Native <dialog> opened via showModal() lives in the browser top-layer
   * which auto-centers; explicit margin: auto reinforces the centering
   * when the page CSS sets a different default. The flex column layout
   * scopes to [open] so when the dialog is closed it stays display:none
   * (default) and doesn't render in flow before showModal hoists it. */
  .add-event-modal[open] {
    display: flex; flex-direction: column;
  }
  .add-event-modal {
    width: min(560px, calc(100vw - 32px));
    max-height: min(86vh, 760px);
    padding: 0;
    background: var(--surface);
    border: 1px solid var(--border-2);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-elev);
    color: var(--text);
    margin: auto;
    overflow: hidden;
  }
  .add-event-modal::backdrop {
    background: var(--overlay-dark);
    backdrop-filter: blur(2px) saturate(120%);
    -webkit-backdrop-filter: blur(2px) saturate(120%);
  }
  .modal-head {
    display: flex; align-items: center;
    padding: 14px 18px 12px;
    border-bottom: 1px solid var(--border-hairline);
    flex-shrink: 0;
  }
  .modal-title {
    margin: 0; flex: 1;
    font-size: var(--t-15);
    font-weight: var(--w-sb);
    letter-spacing: -0.005em;
    color: var(--text);
  }
  .modal-close {
    background: transparent; border: 0; color: var(--text-3);
    width: 28px; height: 28px; border-radius: var(--r-sm);
    font-size: 18px; line-height: 1; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
    transition: background var(--m-fast) var(--m-ease),
                color var(--m-fast) var(--m-ease);
  }
  .modal-close:hover { background: var(--surface-2); color: var(--text); }

  @media (max-width: 540px) {
    .add-event-modal {
      width: calc(100vw - 16px);
      max-height: calc(100vh - 16px);
    }
    .modal-head { padding: 12px 14px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .modal-close { transition: none; }
  }
</style>
