// BackfillPicker — pill-button row matching DateRangeControl on /feed (same
// visual language for "pick a time window" across the app). Per-preset
// helper text spells out BOTH limits — date cutoff + 1000-event cap.
//
// SSR-render coverage (this file):
//   - Test 1: 6 pill <button>s with the literal labels
//             '1 day' / '7 days' / '30 days' / '90 days' / '1 year' / 'All'.
//   - Test 2: Initial render with value='30d' — that button is aria-pressed.
//   - Test 3: Helper paragraph renders the per-preset copy when value='30d'
//             (and includes the literal "1000 events" string so the cap is
//             visible on screen).
//   - Test 4: A11y — section legend "Initial backfill" + role=group on the
//             button row carrying an aria-label.
//   - Test 5: Source references the per-preset helper Paraglide keys.

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

describe("BackfillPicker", () => {
  it("renders 6 pill <button>s carrying the literal preset labels", () => {
    const out = render(BackfillPicker, { props: { value: "30d" } });
    expect(out.body).toContain("1 day");
    expect(out.body).toContain("7 days");
    expect(out.body).toContain("30 days");
    expect(out.body).toContain("90 days");
    expect(out.body).toContain("1 year");
    expect(out.body).toContain("All");
    // The button row carries six type=button elements (one per preset).
    const buttons = out.body.match(/<button[^>]*type="button"/g) ?? [];
    expect(buttons.length).toBe(6);
  });

  it("default-selects '30d' on initial render (aria-pressed=true on the matching button)", () => {
    const out = render(BackfillPicker, { props: { value: "30d" } });
    // The 30d button is the only one carrying aria-pressed="true".
    const pressed = out.body.match(/aria-pressed="true"/g) ?? [];
    expect(pressed.length).toBe(1);
    // And the active button is the one labeled "30 days".
    expect(out.body).toMatch(/<button[^>]*aria-pressed="true"[^>]*>\s*30 days\s*</);
  });

  it("renders the per-preset helper paragraph when value='30d' (mentions 1000-event cap)", () => {
    const out = render(BackfillPicker, { props: { value: "30d" } });
    expect(out.body).toContain("Last 30 days");
    expect(out.body).toContain("1000 events");
  });

  it("renders the section title 'Initial backfill' and a role=group with aria-label", () => {
    const out = render(BackfillPicker, { props: { value: "30d" } });
    expect(out.body).toContain("Initial backfill");
    expect(out.body).toMatch(/role="group"[^>]*aria-label="Initial backfill window"/);
  });

  it("source references the per-preset helper Paraglide keys", () => {
    expect(sourceText).toContain("backfill_picker_helper_1d");
    expect(sourceText).toContain("backfill_picker_helper_7d");
    expect(sourceText).toContain("backfill_picker_helper_30d");
    expect(sourceText).toContain("backfill_picker_helper_90d");
    expect(sourceText).toContain("backfill_picker_helper_1y");
    expect(sourceText).toContain("backfill_picker_helper_everything");
    expect(sourceText).toContain("backfill_picker_section_title");
    expect(sourceText).toContain("backfill_picker_section_blurb");
  });

  it("blurb states the per-platform poll cadence (not a global 'every 6 hours')", () => {
    // YouTube (the default kind) keeps the "videos" noun + its 6h cadence.
    const yt = render(BackfillPicker, { props: { value: "30d", kind: "youtube_channel" } });
    expect(yt.body).toContain("past videos");
    expect(yt.body).toContain("every 6 hours");
    // A paid daily-poller (TikTok) gets DAILY + the hourly warm-stats note —
    // it must NOT inherit YouTube's 6h cadence (the stale-copy bug this fixes).
    const tt = render(BackfillPicker, { props: { value: "30d", kind: "tiktok_account" } });
    expect(tt.body).toContain("past posts");
    expect(tt.body.toLowerCase()).toContain("daily");
    expect(tt.body.toLowerCase()).toContain("hourly");
    expect(tt.body).not.toContain("every 6 hours");
  });

  it("source no longer references the deprecated quota cost / default-helper Paraglide keys", () => {
    // Quota cost is operator concern; default-helper collapsed into
    // per-preset helpers.
    expect(sourceText).not.toContain("backfill_picker_preset_cost");
    expect(sourceText).not.toContain("backfill_picker_helper_default");
  });

  // BACK-01 honesty: a telegram_channel source DOES have a backfill post cap
  // (TELEGRAM_BACKFILL_MAX_POSTS, default 100) — the picker must render the
  // "up to N posts" note on wide presets, NOT claim "no cap". The cap value is
  // read from the postCap prop (the loader's env value), not hardcoded.
  it("renders the post-cap note for telegram_channel on a wide preset (honest cap, from prop)", () => {
    const out = render(BackfillPicker, {
      props: { value: "everything", kind: "telegram_channel", postCap: 100 },
    });
    // The cap value passed via prop appears in the "Up to N most-recent posts" note.
    expect(out.body).toContain("Up to 100 most-recent posts");
    // And the snapshot honesty note also renders for the social source.
    expect(out.body).toContain("import as a current snapshot");
  });

  it("post-cap note reads the cap from the prop (no hardcoded 100)", () => {
    const out = render(BackfillPicker, {
      props: { value: "1y", kind: "telegram_channel", postCap: 250 },
    });
    expect(out.body).toContain("Up to 250 most-recent posts");
    expect(out.body).not.toContain("Up to 100 most-recent posts");
  });

  it("suppresses the post-cap note on a NARROW preset (date cutoff dominates)", () => {
    const out = render(BackfillPicker, {
      props: { value: "30d", kind: "telegram_channel", postCap: 100 },
    });
    // Narrow window → no "up to N posts" note (the date cutoff is the binding
    // limit), but the snapshot note still renders for the social source.
    expect(out.body).not.toContain("most-recent posts within this window");
    expect(out.body).toContain("import as a current snapshot");
  });
});
