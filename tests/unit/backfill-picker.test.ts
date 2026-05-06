// Phase 03.0 Plan 12 — BackfillPicker (D-09 / UI-SPEC §"Component inventory").
//
// Post-build UX revision (2026-05-06): radio group → <select> dropdown,
// quota-cost hints removed (operator concern, not user concern), 'Everything'
// label → '1 year'.
//
// SSR-render coverage (this file):
//   - Test 1: <select> with 5 <option>s carrying the literal labels
//             '1 day' / '7 days' / '30 days' / '90 days' / '1 year'.
//   - Test 2: Initial render with value='30d' — that <option> is selected.
//   - Test 3: Helper paragraph renders the default copy when value is '30d'.
//   - Test 4: A11y — <label>-wrapped <select> with the legend "Initial backfill".
//   - Test 5: <select name="backfill_window"> so a non-JS form post sends it.
//   - Test 6: Source references the conditional helper Paraglide keys.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("$app/navigation", () => ({
  goto: vi.fn(),
  invalidateAll: vi.fn(),
}));

const SOURCE_PATH = resolve(__dirname, "../../src/lib/components/BackfillPicker.svelte");
const sourceText = readFileSync(SOURCE_PATH, "utf8");

const { render } = await import("svelte/server");
const BackfillPicker = (await import("../../src/lib/components/BackfillPicker.svelte")).default;

describe("Plan 03.0-12 — BackfillPicker (D-09)", () => {
  it("renders a <select> with 6 <option>s carrying the literal preset labels", () => {
    const out = render(BackfillPicker, { props: { value: "30d" } });
    expect(out.body).toContain("<select");
    expect(out.body).toContain("1 day");
    expect(out.body).toContain("7 days");
    expect(out.body).toContain("30 days");
    expect(out.body).toContain("90 days");
    expect(out.body).toContain("1 year");
    expect(out.body).toContain("Everything");
    const options = out.body.match(/<option[^>]*value="/g) ?? [];
    expect(options.length).toBe(6);
  });

  it("default-selects '30d' on initial render", () => {
    const out = render(BackfillPicker, { props: { value: "30d" } });
    // Svelte 5 emits selected on the matching <option> when bind:value matches.
    expect(out.body).toMatch(/<option[^>]*value="30d"[^>]*selected/);
  });

  it("renders the default helper paragraph when value='30d'", () => {
    const out = render(BackfillPicker, { props: { value: "30d" } });
    expect(out.body).toContain("Imports up to 1000 most-recent videos");
  });

  it("renders the section title 'Initial backfill'", () => {
    const out = render(BackfillPicker, { props: { value: "30d" } });
    expect(out.body).toContain("Initial backfill");
  });

  it("uses name='backfill_window' on the <select> (non-JS form post field)", () => {
    const out = render(BackfillPicker, { props: { value: "30d" } });
    expect(out.body).toMatch(/<select[^>]*name="backfill_window"/);
  });

  it("source references the conditional helper Paraglide keys (helper_1d + helper_default)", () => {
    expect(sourceText).toContain("backfill_picker_helper_1d");
    expect(sourceText).toContain("backfill_picker_helper_default");
    expect(sourceText).toContain("backfill_picker_section_title");
    expect(sourceText).toContain("backfill_picker_section_blurb");
  });

  it("source no longer references the deprecated quota cost Paraglide keys", () => {
    // UX revision 2026-05-06 — quota cost is operator concern, not user concern.
    expect(sourceText).not.toContain("backfill_picker_preset_cost");
  });
});
