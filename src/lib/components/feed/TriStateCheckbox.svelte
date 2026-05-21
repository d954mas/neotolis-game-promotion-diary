<script lang="ts">
  // TriStateCheckbox — Wave 0 Plan 03 primitive (Foundation C).
  //
  // Renders a native <input type="checkbox"> that visually + semantically
  // expresses three states: on / off / mixed. Used by GamesPicker per-game
  // row (Plan 08) to express bulk-edit aggregation:
  //   - on:    all selected events have this game attached
  //   - off:   none do
  //   - mixed: some do, some don't (initial state when bulk-editing a
  //           heterogeneous selection)
  //
  // Cycle on click (CONTEXT D-12 + prototype line 904):
  //   mixed → onchange("on")
  //   off   → onchange("on")
  //   on    → onchange("off")
  //
  // The "mixed" state is OUTPUT-ONLY — once the user clicks, the checkbox
  // commits to on/off and can't return to mixed without external state
  // (e.g., Cancel restoring the original view in GamesPicker).
  //
  // CRITICAL: HTML `indeterminate` is a JS property, NOT a reflected
  // attribute. Svelte's `bind:` doesn't cover it. The component uses
  // `bind:this={el}` + `$effect` to imperatively sync `el.indeterminate`
  // every time `state` changes. Without this sync the dash glyph would
  // never clear when state transitions from "mixed" to "on" or "off".

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

  let el: HTMLInputElement;

  $effect(() => {
    if (!el) return;
    el.checked = state === "on";
    el.indeterminate = state === "mixed";
  });

  function cycle(): void {
    if (state === "mixed" || state === "off") onchange("on");
    else onchange("off");
  }
</script>

<label class="tri-state">
  <input
    bind:this={el}
    type="checkbox"
    aria-checked={state === "mixed" ? "mixed" : state === "on" ? "true" : "false"}
    aria-labelledby={ariaLabelledby}
    onclick={(e) => {
      e.preventDefault();
      cycle();
    }}
  />
  {#if label}<span class="tri-state-label">{label}</span>{/if}
</label>

<style>
  .tri-state {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    cursor: pointer;
  }
  .tri-state input[type="checkbox"] {
    width: 18px;
    height: 18px;
    accent-color: var(--accent);
    cursor: pointer;
  }
  .tri-state-label {
    font-size: var(--t-13);
    color: var(--text);
    user-select: none;
  }
</style>
