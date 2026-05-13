// Automation for the AuditFlow ↔ CHECK constraint lockstep convention.
//
// Two sources of truth for the flow enum must stay in sync:
//   1. TypeScript — `AuditFlow` literal union in src/lib/server/audit.ts
//   2. PostgreSQL — `audit_log_metadata_flow_valid` CHECK constraint in
//      drizzle/0025_phase03_01_audit_metadata_flow_check.sql
//
// Without automation, a developer can extend the TS union AND forget the
// migration. tsc passes (TS happy), tests pass (constraint accepts the legacy
// values), production fails when the first row is INSERTed with the new value.
//
// This test parses both files, extracts the flow values, and asserts they
// match. When adding a new flow value, the test fails with a clear "TS has
// X but SQL has Y" message until both edits land in lockstep.
//
// Same pattern as `tests/unit/paraglide.test.ts` (EXPECTED_KEYS) and
// `tests/unit/dto.test.ts` — hardcoded list that fails until both sides
// updated.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("AuditFlow union ↔ CHECK constraint sync", () => {
  it("0025 migration constraint allows the same values as the TS union", () => {
    // Hardcoded mirror of the AuditFlow union in src/lib/server/audit.ts.
    // When adding a new flow value, update this array AND the migration.
    // The test fails on either-side drift.
    const tsAuditFlow = ["initial", "incremental", "historical", "stats_refresh", "auto_passive"];

    const migrationPath = resolve(
      __dirname,
      "../../drizzle/0025_phase03_01_audit_metadata_flow_check.sql",
    );
    const sql = readFileSync(migrationPath, "utf-8");

    // Extract IN (...) list from CHECK constraint. The constraint shape:
    //   metadata->>'flow' IN ('initial','incremental',...,'auto_passive')
    const inListMatch = sql.match(/metadata->>'flow'\s+IN\s*\(([^)]+)\)/);
    expect(inListMatch, "could not locate IN (...) clause in migration 0025").not.toBeNull();
    const inListBody = inListMatch![1] ?? "";
    const sqlValues = Array.from(inListBody.matchAll(/'([^']+)'/g)).map((m) => m[1]);

    expect(sqlValues.slice().sort()).toEqual(tsAuditFlow.slice().sort());
  });

  it("audit.ts AuditFlow union matches the hardcoded mirror in this test", async () => {
    // Defense in depth — if someone updates audit.ts AuditFlow but forgets
    // to update this test's hardcoded mirror, this test catches it. Reads
    // audit.ts as text (not via import) because TS literal unions don't
    // survive to runtime.
    const auditPath = resolve(__dirname, "../../src/lib/server/audit.ts");
    const ts = readFileSync(auditPath, "utf-8");

    // Match: export type AuditFlow = | 'a' | 'b' | ... ;
    // Captures the union body between `=` and `;`.
    const unionMatch = ts.match(/export\s+type\s+AuditFlow\s*=\s*([^;]+);/);
    expect(unionMatch, "could not locate AuditFlow type declaration").not.toBeNull();
    const unionBody = unionMatch![1] ?? "";
    const tsValues = Array.from(unionBody.matchAll(/['"]([^'"]+)['"]/g)).map((m) => m[1]);

    const expectedMirror = [
      "initial",
      "incremental",
      "historical",
      "stats_refresh",
      "auto_passive",
    ];
    expect(tsValues.slice().sort()).toEqual(expectedMirror.slice().sort());
  });
});
