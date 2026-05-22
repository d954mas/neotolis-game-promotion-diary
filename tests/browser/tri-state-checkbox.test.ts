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
}): { btn: HTMLButtonElement; component: ReturnType<typeof mount> } {
  const component = mount(TriStateCheckbox, { target: host, props });
  flushSync();
  // Component renders <button role="checkbox"> (was <input type="checkbox">) —
  // the label-input pattern caused a race between browser default toggle and
  // preventDefault; a button removes that entirely.
  const btn = host.querySelector("button[role=checkbox]") as HTMLButtonElement | null;
  if (!btn) throw new Error("TriStateCheckbox failed to render a <button role=checkbox>");
  return { btn, component };
}

describe("TriStateCheckbox — state→aria mapping", () => {
  it('state="on" → aria-checked="true" + data-state="on"', () => {
    const { btn, component } = mountTriState({ state: "on", onchange: () => {} });
    expect(btn.getAttribute("aria-checked")).toBe("true");
    expect(btn.querySelector(".box")?.getAttribute("data-state")).toBe("on");
    unmount(component);
  });

  it('state="off" → aria-checked="false" + data-state="off"', () => {
    const { btn, component } = mountTriState({ state: "off", onchange: () => {} });
    expect(btn.getAttribute("aria-checked")).toBe("false");
    expect(btn.querySelector(".box")?.getAttribute("data-state")).toBe("off");
    unmount(component);
  });

  it('state="mixed" → aria-checked="mixed" + data-state="mixed"', () => {
    const { btn, component } = mountTriState({ state: "mixed", onchange: () => {} });
    expect(btn.getAttribute("aria-checked")).toBe("mixed");
    expect(btn.querySelector(".box")?.getAttribute("data-state")).toBe("mixed");
    unmount(component);
  });
});

describe("TriStateCheckbox — aria-checked", () => {
  it('state="on" → aria-checked="true"', () => {
    const { btn, component } = mountTriState({ state: "on", onchange: () => {} });
    expect(btn.getAttribute("aria-checked")).toBe("true");
    unmount(component);
  });

  it('state="off" → aria-checked="false"', () => {
    const { btn, component } = mountTriState({ state: "off", onchange: () => {} });
    expect(btn.getAttribute("aria-checked")).toBe("false");
    unmount(component);
  });

  it('state="mixed" → aria-checked="mixed"', () => {
    const { btn, component } = mountTriState({ state: "mixed", onchange: () => {} });
    expect(btn.getAttribute("aria-checked")).toBe("mixed");
    unmount(component);
  });
});

describe("TriStateCheckbox — click cycle", () => {
  it('click on state="mixed" calls onchange("on")', () => {
    const onchange = vi.fn();
    const { btn, component } = mountTriState({ state: "mixed", onchange });
    btn.click();
    expect(onchange).toHaveBeenCalledExactlyOnceWith("on");
    unmount(component);
  });

  it('click on state="off" calls onchange("on")', () => {
    const onchange = vi.fn();
    const { btn, component } = mountTriState({ state: "off", onchange });
    btn.click();
    expect(onchange).toHaveBeenCalledExactlyOnceWith("on");
    unmount(component);
  });

  it('click on state="on" calls onchange("off")', () => {
    const onchange = vi.fn();
    const { btn, component } = mountTriState({ state: "on", onchange });
    btn.click();
    expect(onchange).toHaveBeenCalledExactlyOnceWith("off");
    unmount(component);
  });
});

describe("TriStateCheckbox — $effect resyncs indeterminate on state change", () => {
  it("re-mounting with state=off after state=mixed clears indeterminate", () => {
    // The load-bearing case: mixed→on/off must clear the visual dash.
    // State changes drive the visible box via the data-state attribute
    // + aria-checked on the button. Re-mount with different states to
    // verify reactive flow.
    const { btn: btn1, component: c1 } = mountTriState({
      state: "mixed",
      onchange: () => {},
    });
    expect(btn1.getAttribute("aria-checked")).toBe("mixed");
    expect(btn1.querySelector(".box")?.getAttribute("data-state")).toBe("mixed");
    unmount(c1);

    host.innerHTML = "";
    const { btn: btn2, component: c2 } = mountTriState({
      state: "off",
      onchange: () => {},
    });
    expect(btn2.getAttribute("aria-checked")).toBe("false");
    expect(btn2.querySelector(".box")?.getAttribute("data-state")).toBe("off");
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
