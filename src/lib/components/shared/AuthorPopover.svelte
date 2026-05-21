<script lang="ts">
  // AuthorPopover — Wave 0 Plan 03 shared primitive (Foundation C).
  //
  // Mine / Someone-else picker used by FeedCard, EventDetailModal, and
  // SourceRow per CONTEXT D-11. Two options only in v1 (no third
  // "specific blogger" option — deferred to v2 when there's a real need
  // to attribute events to a registered third-party source).
  //
  // Per RESEARCH §"Dialog Stack" Question 10: this is an absolute-
  // positioned <div role="menu">, NOT a native <dialog>. Reason:
  //   - Triggered by click-on-avatar, anchored to the avatar's bounds —
  //     the caller positions a wrapping <div style="position:relative">
  //     and the popover absolutely-positions itself within it.
  //   - The four NEW dialogs in 3.4 (AddEventModal, EventDetailModal,
  //     GamesPicker scrim, DateRangePicker scrim) use showModal() for
  //     top-layer + ::backdrop + focus trap. AuthorPopover doesn't need
  //     those — it's a small menu, dismisses on outside click (caller's
  //     responsibility) or Escape (handled here).
  //   - This also avoids a stacking issue: AuthorPopover can be opened
  //     from INSIDE the already-modal AddEventModal / EventDetailModal,
  //     and a nested <dialog> can't reliably layer above an open one
  //     across browsers.
  //
  // Positioning contract: the caller wraps AuthorPopover in a positioned
  // container (`position: relative`) anchored next to the avatar; the
  // component places itself absolute against that container.

  import { m } from "$lib/paraglide/messages.js";

  let {
    authorIsMe,
    mineName,
    onchange,
    onclose,
  }: {
    authorIsMe: boolean | undefined;
    mineName: string;
    onchange: (next: boolean) => void;
    onclose?: () => void;
  } = $props();

  function pickMine(): void {
    onchange(true);
    onclose?.();
  }

  function pickOthers(): void {
    onchange(false);
    onclose?.();
  }

  function onkeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") onclose?.();
  }
</script>

<div class="author-pick-pop" role="menu" aria-orientation="vertical" tabindex="-1" {onkeydown}>
  <button
    type="button"
    role="menuitemradio"
    aria-checked={authorIsMe === true}
    class="author-pick-row"
    data-active={authorIsMe === true ? "1" : "0"}
    onclick={pickMine}
  >
    {m.author_popover_mine_label({ name: mineName })}
  </button>
  <button
    type="button"
    role="menuitemradio"
    aria-checked={authorIsMe === false}
    class="author-pick-row"
    data-active={authorIsMe === false ? "1" : "0"}
    onclick={pickOthers}
  >
    {m.author_popover_someone_else()}
  </button>
</div>

<style>
  .author-pick-pop {
    position: absolute;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-elev);
    padding: var(--s-1);
    min-width: 200px;
    z-index: 50;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .author-pick-row {
    background: transparent;
    border: none;
    text-align: left;
    padding: var(--s-2) var(--s-3);
    font-size: var(--t-13);
    color: var(--text);
    cursor: pointer;
    border-radius: var(--r-sm);
    transition: background-color var(--m-fast) var(--m-ease);
  }
  .author-pick-row:hover {
    background: var(--accent-soft);
    color: var(--text);
  }
  .author-pick-row[data-active="1"] {
    background: var(--accent-soft);
    color: var(--accent);
  }
  @media (prefers-reduced-motion: reduce) {
    .author-pick-row {
      transition: none;
    }
  }
</style>
