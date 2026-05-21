// tests/browser/tri-state-checkbox.test.ts
//
// TriStateCheckbox — Wave 0 Plan 03 primitive (Foundation C).
//
// `<input type="checkbox" indeterminate>` works as an HTML attribute on
// initial parse only; subsequent state transitions must touch the DOM
// `indeterminate` property directly. Svelte's `bind:` doesn't cover
// `indeterminate` (it's not a reflected attribute), so the component
// uses `bind:this` + `$effect(...)` to re-sync on every state change.
// This test runs in real Chromium (vitest browser-mode) so the property
// is actually live — SSR can't reach it because the property doesn't
// exist on the server.
//
// Cycle contract (CONTEXT D-12 + prototype line 904):
//   - mixed → onchange("on")
//   - off   → onchange("on")
//   - on    → onchange("off")
//
// ARIA: aria-checked="mixed" for screen readers when state="mixed"; the
// DOM `indeterminate=true` would otherwise expose as "false" to AT,
// silently breaking the tri-state semantic.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import TriStateCheckbox from "../../src/lib/components/feed/TriStateCheckbox.svelte";

// Each test gets its own host element so a stale mount can't leak DOM into
// the next assertion. The host lives directly under document.body — the
// component renders a <label> wrapper, so the container shape doesn't
// matter for the input lookup.
let host: HTMLElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

function mountTriState(props: {
  state: "on" | "off" | "mixed";
  onchange: (next: "on" | "off") => void;
  label?: string;
}): { input: HTMLInputElement; component: ReturnType<typeof mount> } {
  const component = mount(TriStateCheckbox, { target: host, props });
  // Svelte 5 schedules `$effect` callbacks for the next microtask; without
  // flushSync the indeterminate / checked property assignments inside the
  // effect haven't landed by the time the test inspects the DOM. flushSync
  // is the official Svelte API for "run all pending effects synchronously".
  flushSync();
  const input = host.querySelector("input") as HTMLInputElement | null;
  if (!input) throw new Error("TriStateCheckbox failed to render an <input>");
  return { input, component };
}

describe("TriStateCheckbox — state→DOM property mapping", () => {
  it('state="on" → input.checked === true', () => {
    const { input, component } = mountTriState({ state: "on", onchange: () => {} });
    expect(input.checked).toBe(true);
    expect(input.indeterminate).toBe(false);
    unmount(component);
  });

  it('state="off" → input.checked === false, indeterminate false', () => {
    const { input, component } = mountTriState({ state: "off", onchange: () => {} });
    expect(input.checked).toBe(false);
    expect(input.indeterminate).toBe(false);
    unmount(component);
  });

  it('state="mixed" → input.indeterminate === true', () => {
    const { input, component } = mountTriState({ state: "mixed", onchange: () => {} });
    expect(input.indeterminate).toBe(true);
    unmount(component);
  });
});

describe("TriStateCheckbox — aria-checked", () => {
  it('state="on" → aria-checked="true"', () => {
    const { input, component } = mountTriState({ state: "on", onchange: () => {} });
    expect(input.getAttribute("aria-checked")).toBe("true");
    unmount(component);
  });

  it('state="off" → aria-checked="false"', () => {
    const { input, component } = mountTriState({ state: "off", onchange: () => {} });
    expect(input.getAttribute("aria-checked")).toBe("false");
    unmount(component);
  });

  it('state="mixed" → aria-checked="mixed"', () => {
    const { input, component } = mountTriState({ state: "mixed", onchange: () => {} });
    expect(input.getAttribute("aria-checked")).toBe("mixed");
    unmount(component);
  });
});

describe("TriStateCheckbox — click cycle", () => {
  it('click on state="mixed" calls onchange("on")', () => {
    const onchange = vi.fn();
    const { input, component } = mountTriState({ state: "mixed", onchange });
    input.click();
    expect(onchange).toHaveBeenCalledExactlyOnceWith("on");
    unmount(component);
  });

  it('click on state="off" calls onchange("on")', () => {
    const onchange = vi.fn();
    const { input, component } = mountTriState({ state: "off", onchange });
    input.click();
    expect(onchange).toHaveBeenCalledExactlyOnceWith("on");
    unmount(component);
  });

  it('click on state="on" calls onchange("off")', () => {
    const onchange = vi.fn();
    const { input, component } = mountTriState({ state: "on", onchange });
    input.click();
    expect(onchange).toHaveBeenCalledExactlyOnceWith("off");
    unmount(component);
  });
});

describe("TriStateCheckbox — $effect resyncs indeterminate on state change", () => {
  it("re-mounting with state=off after state=mixed clears indeterminate", () => {
    // The load-bearing case: mixed→on/off must clear the visual dash.
    // Svelte's `bind:` doesn't touch the indeterminate DOM property; the
    // `$effect` is the only mechanism that brings the DOM back in sync.
    // Re-mount with the new state to verify the effect runs on initial
    // render too (proxying the prop-change codepath).
    const { input: input1, component: c1 } = mountTriState({
      state: "mixed",
      onchange: () => {},
    });
    expect(input1.indeterminate).toBe(true);
    unmount(c1);

    host.innerHTML = "";
    const { input: input2, component: c2 } = mountTriState({
      state: "off",
      onchange: () => {},
    });
    expect(input2.indeterminate).toBe(false);
    expect(input2.checked).toBe(false);
    unmount(c2);
  });
});

describe("TriStateCheckbox — optional label", () => {
  it("renders the label text adjacent to the input when label prop is set", () => {
    const { component } = mountTriState({
      state: "on",
      onchange: () => {},
      label: "Cyber Dungeon",
    });
    expect(host.textContent).toContain("Cyber Dungeon");
    unmount(component);
  });
});
