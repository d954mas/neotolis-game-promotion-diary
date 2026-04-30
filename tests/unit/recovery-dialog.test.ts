// Plan 02.1-39 round-6 polish #11 (UAT-NOTES.md §5.8 follow-up #11) —
// regression guards for <RecoveryDialog>, the modal that replaces the
// bottom-of-page DeletedEventsPanel anchor target on /feed. The anchor
// link broke on infinite-scroll surfaces by construction (clicking jumps
// to bottom → sentinel fires → bottom moves → user lost). Switching to
// a native <dialog> modal decouples the recovery UI from scroll position.
//
// SSR-render coverage (this file):
//   - Heading text reads "Recently deleted (N)" with the count from items.length.
//   - Each item row renders the item's name + a Restore button.
//   - Empty-items branch renders the localized "Nothing to recover" copy
//     instead of the rows list.
//   - data-entity-type attribute is set so future styling / a11y hooks
//     can target per-type (forward-compat per §5.8 paths B/C — /games and
//     /sources adoption is deferred).
//   - The <dialog> root element is rendered (not just a <div>) so the
//     parent's `open` prop drives showModal() / close() at runtime.
//
// Browser-driven assertions (Escape closes, backdrop click closes, ×
// click closes) need DOM + Playwright — those land in the browser
// project alongside the auth harness in Phase 6 (same precedent as Plan
// 02.1-39's other §5.x manual-UAT items). The Russian UAT recipe for
// the round-6 walkthrough lives in tests/browser/responsive-360.test.ts.

import { describe, it, expect } from "vitest";
import { render } from "svelte/server";
import RecoveryDialog from "../../src/lib/components/RecoveryDialog.svelte";

describe("Plan 02.1-39 round-6 polish #11 — RecoveryDialog (anchor → modal)", () => {
  it("renders one row per item with the item's name + a Restore button", () => {
    const out = render(RecoveryDialog, {
      props: {
        open: true,
        items: [
          { id: "ev-1", name: "Hades launch trailer", deletedAt: new Date("2026-04-25T12:00:00Z") },
          { id: "ev-2", name: "Reddit AMA recap", deletedAt: new Date("2026-04-26T14:30:00Z") },
        ],
        entityType: "event" as const,
        retentionDays: 60,
        onClose: () => {},
        onRestore: async () => {},
      },
    });

    expect(out.body).toContain("Hades launch trailer");
    expect(out.body).toContain("Reddit AMA recap");
    // Restore button should appear once per item.
    const restoreMatches = out.body.match(/<button[^>]*class="[^"]*\brestore\b[^"]*"/g);
    expect(restoreMatches?.length, "expected one Restore button per item").toBe(2);
  });

  it("renders the heading with the count from items.length", () => {
    const out = render(RecoveryDialog, {
      props: {
        open: true,
        items: [
          { id: "ev-1", name: "A", deletedAt: new Date("2026-04-25T12:00:00Z") },
          { id: "ev-2", name: "B", deletedAt: new Date("2026-04-25T12:00:00Z") },
          { id: "ev-3", name: "C", deletedAt: new Date("2026-04-25T12:00:00Z") },
        ],
        entityType: "event" as const,
        retentionDays: 60,
        onClose: () => {},
        onRestore: async () => {},
      },
    });

    // Heading interpolates the count via paraglide message.
    expect(out.body).toMatch(/Recently deleted \(3\)/);
  });

  it("renders the empty-state copy when items.length === 0 (no rows list)", () => {
    const out = render(RecoveryDialog, {
      props: {
        open: true,
        items: [],
        entityType: "event" as const,
        retentionDays: 60,
        onClose: () => {},
        onRestore: async () => {},
      },
    });

    // The English message is "Nothing to recover." (recovery_dialog_empty).
    expect(out.body).toContain("Nothing to recover.");
    // No rows list when items is empty — defends against rendering
    // RetentionBadge / Restore buttons against an empty array.
    expect(out.body).not.toMatch(/<ul[^>]*class="[^"]*\brows\b/);
  });

  it("renders <dialog> as the root element (not a <div>) so showModal() / close() drive open/closed", () => {
    const out = render(RecoveryDialog, {
      props: {
        open: false,
        items: [{ id: "ev-1", name: "A", deletedAt: new Date("2026-04-25T12:00:00Z") }],
        entityType: "event" as const,
        retentionDays: 60,
        onClose: () => {},
        onRestore: async () => {},
      },
    });

    // The dialog element is the load-bearing host — its showModal() /
    // close() drive open/closed at runtime. SSR doesn't run the
    // $effect that calls those methods, so we cannot assert the runtime
    // open state here; the structural guard is that the root element
    // IS a <dialog> (not the previous bottom-of-page <div id=...>).
    expect(out.body).toMatch(/<dialog\b/);
  });

  it("sets data-entity-type on the dialog so future per-type styling / a11y hooks can target it", () => {
    for (const entityType of ["event", "game", "source"] as const) {
      const out = render(RecoveryDialog, {
        props: {
          open: true,
          items: [{ id: "x", name: "Test", deletedAt: new Date("2026-04-25T12:00:00Z") }],
          entityType,
          retentionDays: 60,
          onClose: () => {},
          onRestore: async () => {},
        },
      });
      expect(out.body).toContain(`data-entity-type="${entityType}"`);
    }
  });

  it("renders a close button with an aria-label for screen-reader users (Escape + backdrop + × all close)", () => {
    const out = render(RecoveryDialog, {
      props: {
        open: true,
        items: [{ id: "ev-1", name: "A", deletedAt: new Date("2026-04-25T12:00:00Z") }],
        entityType: "event" as const,
        retentionDays: 60,
        onClose: () => {},
        onRestore: async () => {},
      },
    });
    // The close button needs an aria-label because its visual text is "×".
    // The label resolves through paraglide's m.common_close().
    expect(out.body).toMatch(
      /<button[^>]*type="button"[^>]*class="[^"]*\bclose\b[^"]*"[^>]*aria-label="Close"/,
    );
  });
});
