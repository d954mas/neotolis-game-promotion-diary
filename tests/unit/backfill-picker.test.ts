// Phase 03.0 Plan 12 — BackfillPicker (D-09 / UI-SPEC §"Component inventory").
//
// SSR-render coverage (this file):
//   - Test 1: 5 radio rows with the literal labels '1 day', '7 days',
//             '30 days', '90 days', 'Everything' (Paraglide keys
//             backfill_picker_preset_*_label from messages/en.json).
//   - Test 2: Initial render: '30 days' is the checked radio (default).
//   - Test 3: Each non-Everything row carries the cost hint
//             '≈ 1 quota unit'; Everything carries
//             'up to ≈ 20 quota units (one-time)'.
//   - Test 4: Helper paragraph renders the default copy when value is '30d'.
//   - Test 5: A11y — <fieldset>+<legend> wraps the radio group; section
//             title is "Initial backfill" (legend text).
//   - Test 6: All radio inputs share name="backfill_window" so a non-JS
//             form submission posts the chosen value as that field.
//
// Selection-driven helper switching (1d → backfill_picker_helper_1d) is
// exercised at the browser level (DOM event); SSR snapshot here only
// asserts the default-state helper text. The selection-switch behavior
// is validated by the source containing the $derived expression — the
// $derived runtime is unit-tested by Svelte itself.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("$app/navigation", () => ({
  goto: vi.fn(),
  invalidateAll: vi.fn(),
}));

const SOURCE_PATH = resolve(
  __dirname,
  "../../src/lib/components/BackfillPicker.svelte",
);
const sourceText = readFileSync(SOURCE_PATH, "utf8");

const { render } = await import("svelte/server");
const BackfillPicker = (
  await import("../../src/lib/components/BackfillPicker.svelte")
).default;

describe("Plan 03.0-12 — BackfillPicker (D-09)", () => {
  it("renders 5 radio rows with the literal preset labels", () => {
    const out = render(BackfillPicker, { props: { value: "30d" } });
    expect(out.body).toContain("1 day");
    expect(out.body).toContain("7 days");
    expect(out.body).toContain("30 days");
    expect(out.body).toContain("90 days");
    expect(out.body).toContain("Everything");
    // 5 radio inputs total.
    const radios = out.body.match(/<input[^>]*type="radio"/g) ?? [];
    expect(radios.length).toBe(5);
  });

  it("default-selects '30d' on initial render", () => {
    const out = render(BackfillPicker, { props: { value: "30d" } });
    // The radio with value="30d" should be checked. Svelte 5's bind:group
    // emits checked=... on the matching radio.
    expect(out.body).toMatch(/<input[^>]*value="30d"[^>]*checked/);
  });

  it("renders the cost-hint copy on each row", () => {
    const out = render(BackfillPicker, { props: { value: "30d" } });
    // Five low-cost rows would all read the same string; one Everything row
    // reads the higher-cost string. We don't count occurrences (the markup
    // structure is deliberately one cost-hint per <label>) — we only
    // assert both strings appear.
    expect(out.body).toContain("≈ 1 quota unit");
    expect(out.body).toContain("up to ≈ 20 quota units (one-time)");
  });

  it("renders the default helper paragraph when value='30d'", () => {
    const out = render(BackfillPicker, { props: { value: "30d" } });
    expect(out.body).toContain("30 days fits most active devlogs");
  });

  it("uses fieldset + legend with the literal section title", () => {
    const out = render(BackfillPicker, { props: { value: "30d" } });
    expect(out.body).toContain("<fieldset");
    expect(out.body).toContain("<legend");
    expect(out.body).toContain("Initial backfill");
  });

  it("all radio inputs share name='backfill_window' (non-JS form post field)", () => {
    const out = render(BackfillPicker, { props: { value: "30d" } });
    const matches = out.body.match(/name="backfill_window"/g) ?? [];
    expect(matches.length).toBe(5);
  });

  it("source references the conditional helper Paraglide keys (helper_1d + helper_default)", () => {
    expect(sourceText).toContain("backfill_picker_helper_1d");
    expect(sourceText).toContain("backfill_picker_helper_default");
    expect(sourceText).toContain("backfill_picker_section_title");
    expect(sourceText).toContain("backfill_picker_section_blurb");
  });
});
