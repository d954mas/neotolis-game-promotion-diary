<script lang="ts">
  // AuthorPopover — Wave 0 Plan 03 shared primitive (Foundation C).
  //
  // Mine / Someone-else picker used by FeedCard, EventDetailContent,
  // AddEventForm, and SourceRow per CONTEXT D-11. Two options only in v1
  // (no third "specific blogger" option — deferred to v2 when there's a
  // real need to attribute events to a registered third-party source).
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
  // Visual contract: 1:1 with docs/design/v2/ui-kit/index.html
  // .author-pick-pop / .author-pick-opt / .author-pick-opt-name /
  // .author-pick-opt-tag / .author-pick-opt-check rules. Each row
  // renders a 22px avatar (orange-filled for "mine", grey-bordered for
  // "?"), a name, a mono "you" tag on the mine row, and a check glyph
  // on the active row.
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
    placement = "down",
    anchor = null,
  }: {
    authorIsMe: boolean | undefined;
    mineName: string;
    onchange: (next: boolean) => void;
    onclose?: () => void;
    // "down" opens below trigger (default — used in card-meta avatars
    // where there's room below). "up" opens ABOVE trigger — used in
    // AddEventForm footer-hint where the trigger sits at the bottom of
    // the modal and a down-open would overflow the dialog.
    placement?: "up" | "down";
    // Optional anchor element. When provided, the popover renders with
    // position:fixed + computed top/left from anchor.getBoundingClientRect()
    // so it escapes any ancestor overflow:hidden (e.g. event-detail-modal).
    anchor?: HTMLElement | null;
  } = $props();

  // Fixed-position coordinates derived from anchor (when set).
  let popEl: HTMLDivElement | null = $state(null);
  let fixedTop = $state(0);
  let fixedLeft = $state(0);
  $effect(() => {
    if (!anchor || !popEl) return;
    const a = anchor;
    const p = popEl;

    const reposition = (): void => {
      const rect = a.getBoundingClientRect();
      const popRect = p.getBoundingClientRect();
      const vw = window.innerWidth;
      const PAD = 8;
      if (placement === "up") {
        fixedTop = rect.top - popRect.height - 6;
      } else {
        fixedTop = rect.bottom + 6;
      }
      // Horizontal placement: prefer right-aligning popover edge to anchor
      // edge. Clamp to viewport [PAD, vw - popRect.width - PAD] so the
      // popover never spills past either viewport edge.
      const desiredLeft = rect.right - popRect.width;
      const maxLeft = vw - popRect.width - PAD;
      fixedLeft = Math.max(PAD, Math.min(desiredLeft, maxLeft));
    };
    reposition();

    // B-9: reposition on scroll + resize so the popover stays glued to
    // the anchor when the page scrolls underneath an open menu (e.g. on
    // EventDetailModal where the modal body scrolls). `capture: true`
    // on scroll catches scrolls from nested scroll containers too — a
    // non-capturing listener on window only fires for window-level
    // scrolls.
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  });

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

  const mineInitial = $derived((mineName?.[0] ?? "Y").toUpperCase());
</script>

<div
  bind:this={popEl}
  class="author-pick-pop"
  data-placement={placement}
  data-fixed={anchor ? "1" : "0"}
  style={anchor ? `top: ${fixedTop}px; left: ${fixedLeft}px;` : null}
  role="menu"
  aria-orientation="vertical"
  tabindex="-1"
  {onkeydown}
>
  <button
    type="button"
    role="menuitemradio"
    aria-checked={authorIsMe === true}
    class="author-pick-opt"
    data-active={authorIsMe === true ? "1" : "0"}
    onclick={pickMine}
  >
    <span class="author-avatar" data-mine="1">{mineInitial}</span>
    <span class="author-pick-opt-name">{mineName}</span>
    <span class="author-pick-opt-tag">you</span>
    {#if authorIsMe === true}
      <span class="author-pick-opt-check" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </span>
    {/if}
    <!-- Hidden label for compat with older tests that read the i18n
         string verbatim. The visible row already carries the same text
         via {mineName} + "you". -->
    <span class="sr-only">{m.author_popover_mine_label({ name: mineName })}</span>
  </button>
  <button
    type="button"
    role="menuitemradio"
    aria-checked={authorIsMe === false}
    class="author-pick-opt"
    data-active={authorIsMe === false ? "1" : "0"}
    onclick={pickOthers}
  >
    <span class="author-avatar" data-mine="0">?</span>
    <span class="author-pick-opt-name">{m.author_popover_someone_else()}</span>
    {#if authorIsMe === false}
      <span class="author-pick-opt-check" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </span>
    {/if}
  </button>
</div>

<style>
  /* Prototype 1:1 — mirrors .author-pick-pop / .author-pick-opt /
   * .author-pick-opt-name / .author-pick-opt-tag / .author-pick-opt-check
   * from docs/design/v2/ui-kit/index.html. Positioned absolute below the
   * trigger; the caller's wrapping div with position:relative is the
   * positioning context. */
  .author-pick-pop {
    position: absolute;
    z-index: 81;
    right: 0;
    min-width: 240px;
    background: var(--surface);
    border: 1px solid var(--border-2);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-elev);
    padding: 4px;
    display: flex;
    flex-direction: column;
  }
  .author-pick-pop[data-placement="down"] {
    top: calc(100% + 6px);
  }
  .author-pick-pop[data-placement="up"] {
    bottom: calc(100% + 6px);
    left: 0;
    right: auto;
  }
  /* Fixed positioning — escapes any ancestor overflow:hidden (modals).
   * top/left set inline from anchor.getBoundingClientRect(). */
  .author-pick-pop[data-fixed="1"] {
    position: fixed;
    top: auto;
    bottom: auto;
    left: auto;
    right: auto;
    z-index: 1100;
  }
  .author-pick-opt {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 10px;
    background: transparent;
    border: 0;
    border-radius: var(--r-sm);
    color: var(--text);
    font-size: var(--t-13);
    text-align: left;
    cursor: pointer;
    transition: background-color var(--m-fast) var(--m-ease);
  }
  .author-pick-opt:hover {
    background: var(--surface-2);
  }
  .author-pick-opt[data-active="1"] {
    background: var(--accent-soft);
  }
  .author-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    background: var(--surface-3);
    color: var(--text-3);
    border: 1px solid var(--border);
    border-radius: 50%;
    font-family: var(--f-sans);
    font-size: 11px;
    font-weight: var(--w-sb);
    flex-shrink: 0;
  }
  .author-avatar[data-mine="1"] {
    background: var(--accent);
    color: var(--accent-text);
    border-color: var(--accent);
  }
  .author-pick-opt-name {
    flex: 1;
    color: var(--text);
    font-weight: var(--w-md);
  }
  .author-pick-opt-tag {
    color: var(--text-3);
    font-size: var(--t-12);
    font-family: var(--f-mono);
    letter-spacing: 0.02em;
  }
  .author-pick-opt-check {
    display: inline-flex;
    color: var(--accent-strong);
    flex-shrink: 0;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  @media (prefers-reduced-motion: reduce) {
    .author-pick-opt {
      transition: none;
    }
  }
</style>
