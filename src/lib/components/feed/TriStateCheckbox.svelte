<script lang="ts">
  // TriStateCheckbox — Wave 0 Plan 03 primitive (Foundation C).
  //
  // Three states: on / off / mixed. Used by GamesPicker per-game row to
  // express bulk-edit aggregation:
  //   - on:    all selected events have this game attached
  //   - off:   none do
  //   - mixed: some do, some don't (initial state for heterogeneous selection)
  //
  // Cycle on click (CONTEXT D-12 + prototype line 904):
  //   mixed / off → onchange("on")
  //   on          → onchange("off")
  //
  // Why a <button role="checkbox"> and not <input type="checkbox">:
  // wrapping a native checkbox inside a <label> caused a race between
  // browser's default toggle and our preventDefault — clicking the label
  // sometimes left input.checked out of sync with the parent's state,
  // making the chip appear non-responsive. Using a button with the
  // role="checkbox" + aria-checked contract gives us full visual control
  // and removes the label-forwarding race entirely. Keyboard semantics
  // preserved: Enter / Space trigger click on a focused <button>.

  let {
    state,
    onchange,
    label,
    ariaLabelledby,
  }: {
    state: "on" | "off" | "mixed";
    onchange: (next: "on" | "off") => void;
    label?: string;
    ariaLabelledby?: string;
  } = $props();

  function cycle(): void {
    if (state === "mixed" || state === "off") onchange("on");
    else onchange("off");
  }
</script>

<button
  type="button"
  class="tri-state"
  role="checkbox"
  aria-checked={state === "mixed" ? "mixed" : state === "on" ? "true" : "false"}
  aria-labelledby={ariaLabelledby}
  onclick={cycle}
>
  <span class="box" data-state={state} aria-hidden="true">
    {#if state === "on"}
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M2 6.5 L5 9.5 L10 3.5" />
      </svg>
    {:else if state === "mixed"}
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
      >
        <path d="M2.5 6 L9.5 6" />
      </svg>
    {/if}
  </span>
  {#if label}<span class="tri-state-label">{label}</span>{/if}
</button>

<style>
  .tri-state {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    background: transparent;
    border: 0;
    padding: 0;
    cursor: pointer;
    font: inherit;
    color: var(--text);
  }
  .tri-state .box {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border: 1.5px solid var(--border-2, var(--border));
    border-radius: 4px;
    background: var(--surface);
    color: var(--accent-text, #fff);
    flex-shrink: 0;
    transition:
      background var(--m-fast) var(--m-ease),
      border-color var(--m-fast) var(--m-ease);
  }
  .tri-state:hover .box {
    border-color: var(--accent);
  }
  .tri-state .box[data-state="on"],
  .tri-state .box[data-state="mixed"] {
    background: var(--accent);
    border-color: var(--accent);
  }
  .tri-state:focus-visible {
    outline: none;
  }
  .tri-state:focus-visible .box {
    box-shadow: var(--focus-ring);
  }
  .tri-state-label {
    font-size: var(--t-13);
    color: var(--text);
    user-select: none;
  }
</style>
