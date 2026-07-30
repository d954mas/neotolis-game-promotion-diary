import { describe, expect, it } from "vitest";

const { journalHasSchemaDrift } = await import("../../scripts/check-db-schema-drift.mjs");

describe("db schema drift check", () => {
  it("accepts an unchanged migration journal", () => {
    const journal = {
      version: "7",
      dialect: "postgresql",
      entries: [{ idx: 75, tag: "0075_data_cleanup" }],
    };

    expect(journalHasSchemaDrift(journal, structuredClone(journal))).toBe(false);
  });

  it("rejects a migration generated from uncommitted schema changes", () => {
    const before = {
      version: "7",
      dialect: "postgresql",
      entries: [{ idx: 75, tag: "0075_data_cleanup" }],
    };
    const after = {
      ...before,
      entries: [...before.entries, { idx: 76, tag: "0076_ci_schema_drift" }],
    };

    expect(journalHasSchemaDrift(before, after)).toBe(true);
  });
});
