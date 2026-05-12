import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Structural guard for quota.ts.
//
// The events_per_day quota counter must filter `source_id IS NULL` so that
// auto-imported rows (source_id IS NOT NULL) never count against the
// human-driven 500/day cap. The cap is a HUMAN-TIME envelope, not a
// database-row envelope: a registered YouTube channel posting 50 videos
// in one day must not consume the user's manual-paste budget.
//
// Behavioural verification of currentCount + withQuotaGuard lives in
// tests/integration/auto-import-quota-bypass.test.ts (real Postgres).
// The unit-level guard here pins the source-code shape so a future
// refactor cannot silently regress the filter back to "all rows".

const here = dirname(fileURLToPath(import.meta.url));
const QUOTA_PATH = resolve(here, "../../src/lib/server/services/quota.ts");

describe("quota events_per_day source_id filter", () => {
  it("quota.ts events_per_day branch filters source_id IS NULL", async () => {
    const src = await readFile(QUOTA_PATH, "utf8");
    // The events_per_day branch must reference the sourceId filter — either
    // the Drizzle helper `isNull(events.sourceId)` OR a raw SQL fragment.
    const hasIsNullHelper = /isNull\s*\(\s*events\.sourceId\s*\)/.test(src);
    const hasRawSqlFilter = /source_id\s+IS\s+NULL/i.test(src);
    expect(hasIsNullHelper || hasRawSqlFilter).toBe(true);
  });

  it("quota.ts events_per_day comment documents the auto-import exclusion", async () => {
    const src = await readFile(QUOTA_PATH, "utf8");
    // Pin the rationale: auto-imported rows must not count against the
    // human-driven cap. The comment phrasing keeps the WHY visible to a
    // future reader who might "simplify" the filter back to "all rows".
    expect(src).toMatch(
      /source_id IS NOT NULL.+excluded|human-driven creates only|human-time budget/i,
    );
  });

  it("quota.ts still imports isNull from drizzle-orm (regression guard)", async () => {
    const src = await readFile(QUOTA_PATH, "utf8");
    // The import line must contain isNull so the events_per_day filter
    // resolves at runtime. The games / data_sources branches also use it;
    // this test pins it so a future import-pruner does not strip the symbol.
    expect(src).toMatch(/import\s+\{[^}]*\bisNull\b[^}]*\}\s+from\s+"drizzle-orm"/);
  });
});
