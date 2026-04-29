// Phase 2.1 Plan 20 (gap closure round 2) — render-time regression guard
// for the /audit filter UX rewrite. Replaces the Plan 02.1-11 ActionFilter
// guards (component deleted by Plan 02.1-20). AuditRow guard preserved —
// AuditRow is unchanged.
//
// New guards over FiltersSheet (the ActionFilter replacement):
//   1. Renders one checkbox per AUDIT_ACTIONS member when filters.action is
//      a non-undefined array (sweep over the closed AUDIT_ACTIONS list — a
//      future addition to AUDIT_ACTIONS without the matching auditActionLabel
//      switch case + AUDIT_ACTIONS_MIRROR entry trips this assertion).
//   2. Does NOT render the action fieldset when filters.action is undefined
//      (the /feed default).
//   3. Renders the actions in alphabetical-by-translated-label order
//      (sortByLabel locked-in via the rendered HTML output).

import { describe, it, expect } from "vitest";
import { render } from "svelte/server";
import AuditRow from "../../src/lib/components/AuditRow.svelte";
import FiltersSheet from "../../src/lib/components/FiltersSheet.svelte";
import { AUDIT_ACTIONS } from "../../src/lib/server/audit/actions.js";

describe("/audit render-time guard (Plan 02.1-20 — FiltersSheet + AuditRow)", () => {
  it("AuditRow renders a non-fallback chip label for every AUDIT_ACTIONS value", () => {
    for (const a of AUDIT_ACTIONS) {
      const renderOnce = () =>
        render(AuditRow, {
          props: {
            entry: {
              id: "test-id",
              action: a,
              ipAddress: "10.0.0.1",
              userAgent: "test",
              metadata: null,
              createdAt: new Date("2026-04-28T12:00:00Z"),
            },
          },
        });

      expect(renderOnce).not.toThrow();
      const out = renderOnce();
      // Svelte 5 SSR adds a scoped class suffix (svelte-XXXXX) — the regex
      // accepts the chip class with or without sibling classes.
      const chipMatch = out.body.match(/<span class="chip(?:\s[^"]*)?"[^>]*>([^<]*)<\/span>/);
      expect(
        chipMatch,
        `AuditRow render for action="${a}" produced no <span class="chip"> element`,
      ).not.toBeNull();
      const chipText = chipMatch![1]!.trim();
      expect(chipText.length, `AuditRow chip empty for action="${a}"`).toBeGreaterThan(0);
      expect(
        chipText,
        `AuditRow chip text for action="${a}" is the raw action — chipLabel switch missing this case`,
      ).not.toBe(a);
    }
  });

  it("FiltersSheet renders one checkbox per AUDIT_ACTIONS value when action axis is active", () => {
    const out = render(FiltersSheet, {
      props: {
        filters: {
          source: [],
          kind: [],
          show: { kind: "any" },
          defaultDateRange: false,
          all: true,
          action: [], // ← non-undefined enables the action fieldset
        },
        sources: [],
        games: [],
        onApply: () => {},
        onClose: () => {},
      },
    });

    // Find the fieldset[data-axis="action"] block, count <input
    // type="checkbox"> within. Counting via substring is robust against
    // attribute reordering by the renderer.
    const fieldsetMatch = out.body.match(
      /<fieldset[^>]*data-axis="action"[^>]*>([\s\S]*?)<\/fieldset>/,
    );
    expect(fieldsetMatch, "FiltersSheet did not render action fieldset").not.toBeNull();
    const fieldsetHtml = fieldsetMatch![1]!;
    const checkboxCount = (fieldsetHtml.match(/<input[^>]*type="checkbox"/g) ?? []).length;
    expect(checkboxCount).toBe(AUDIT_ACTIONS.length);
  });

  it("FiltersSheet does NOT render action fieldset when action axis is undefined", () => {
    const out = render(FiltersSheet, {
      props: {
        filters: {
          source: [],
          kind: [],
          show: { kind: "any" },
          defaultDateRange: false,
          all: true,
          // action: undefined  ← omitted; axis must NOT render
        },
        sources: [],
        games: [],
        onApply: () => {},
        onClose: () => {},
      },
    });
    expect(out.body).not.toMatch(/<fieldset[^>]*data-axis="action"/);
  });

  it("FiltersSheet action options sorted alphabetically by translated label", () => {
    const out = render(FiltersSheet, {
      props: {
        filters: {
          source: [],
          kind: [],
          show: { kind: "any" },
          defaultDateRange: false,
          all: true,
          action: [],
        },
        sources: [],
        games: [],
        onApply: () => {},
        onClose: () => {},
      },
    });
    const fieldsetMatch = out.body.match(
      /<fieldset[^>]*data-axis="action"[^>]*>([\s\S]*?)<\/fieldset>/,
    )!;
    const fieldsetHtml = fieldsetMatch[1]!;
    // Extract the visible label text after each checkbox. The HTML shape is
    // <label class="check svelte-XXXXX"><input type="checkbox"/> Visible label</label>.
    // Svelte 5 SSR adds a scoped class suffix; the regex accepts any class
    // attribute that begins with "check".
    const labelRegex = /<label[^>]*class="check(?:\s[^"]*)?"[^>]*>[\s\S]*?<input[^>]*?\/?>\s*([^<]+?)\s*<\/label>/g;
    const labels: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = labelRegex.exec(fieldsetHtml)) !== null) {
      labels.push(match[1]!.trim());
    }
    expect(labels.length).toBe(AUDIT_ACTIONS.length);
    const sorted = [...labels].sort((a, b) =>
      new Intl.Collator(undefined, { sensitivity: "base" }).compare(a, b),
    );
    expect(labels).toEqual(sorted);
  });
});
