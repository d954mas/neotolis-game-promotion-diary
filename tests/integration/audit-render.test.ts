// Phase 2.1 Plan 11 (gap closure) — render-time regression guard for /audit.
// Closes Gap 1 + Gap 11 from 02.1-VERIFICATION.md. A future AUDIT_ACTIONS
// addition or Paraglide-key rename trips this test before reaching UAT.

import { describe, it, expect } from "vitest";
import { render } from "svelte/server";
import ActionFilter from "../../src/lib/components/ActionFilter.svelte";
import AuditRow from "../../src/lib/components/AuditRow.svelte";
import { AUDIT_ACTIONS } from "../../src/lib/server/audit/actions.js";

describe("/audit render-time guard (Gap 1 + Gap 11 — Plan 02.1-11)", () => {
  it("ActionFilter renders one option per AUDIT_ACTIONS value plus 'all' (20 total)", () => {
    const out = render(ActionFilter, {
      props: {
        value: "all",
        onChange: () => {},
      },
    });

    // Count <option ... > occurrences in the rendered HTML. 1 "all" + 19
    // AUDIT_ACTIONS = 20 total. Counting via substring is robust against
    // attribute reordering by the renderer.
    const optionCount = (out.body.match(/<option/g) ?? []).length;
    expect(optionCount).toBe(20);
  });

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

      // Test 2 contract: rendering MUST NOT throw for any action value.
      expect(renderOnce).not.toThrow();

      const out = renderOnce();
      const chipMatch = out.body.match(
        /<span class="chip"[^>]*>([^<]*)<\/span>/,
      );
      expect(
        chipMatch,
        `AuditRow render for action="${a}" produced no <span class="chip"> element`,
      ).not.toBeNull();
      const chipText = chipMatch![1]!.trim();
      // Non-empty AND not equal to the raw action string (i.e. Paraglide
      // returned a real label, not the chipLabel default fallback).
      expect(
        chipText.length,
        `AuditRow chip empty for action="${a}"`,
      ).toBeGreaterThan(0);
      expect(
        chipText,
        `AuditRow chip text for action="${a}" is the raw action — chipLabel switch missing this case`,
      ).not.toBe(a);
    }
  });

  it("ActionFilter <select> values match exactly ['all', ...AUDIT_ACTIONS] (no missing, no stale)", () => {
    const out = render(ActionFilter, {
      props: {
        value: "all",
        onChange: () => {},
      },
    });

    const values: string[] = [];
    const re = /<option[^>]*value="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(out.body)) !== null) {
      values.push(m[1]!);
    }

    const expected = ["all", ...AUDIT_ACTIONS];
    expect(values.slice().sort()).toEqual(expected.slice().sort());
  });
});
