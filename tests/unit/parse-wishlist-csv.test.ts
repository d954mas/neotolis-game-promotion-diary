import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Wave 0 scaffold (Plan 03.2-01 Task 3): named-plan it.skip stubs for the
// Steamworks Wishlists.csv parser. The behavior these assert ships in Plan
// 03.2-02 (Wave 1) — the parser `parseWishlistCsv` does not exist yet, so
// these are it.skip until 03.2-02 flips them to live `it(...)`.
//
// Fixtures are the test oracle (RESEARCH.md ## Validation Architecture):
//   wishlist-sample.csv        — canonical 3 rows, balances 36/83/111
//   wishlist-bom-crlf.csv      — BOM + CRLF + trailing blank line tolerance
//   wishlist-bad-header.csv    — missing Adds column → invalid-header error
//   wishlist-extra-column.csv  — trailing MonthCohort column ignored
//   wishlist-malformed-row.csv — one non-integer Adds row → skipped===1

const FIXTURES = join(process.cwd(), "tests", "fixtures");
const read = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

describe("parseWishlistCsv (Plan 03.2-02)", () => {
  it.skip("03.2-02: canonical CSV parses to 3 rows with skipped===0", () => {
    const csv = read("wishlist-sample.csv");
    expect(csv).toContain("DateLocal,Game,Adds,Deletes,PurchasesAndActivations,Gifts");
    // 03.2-02: const { rows, skipped } = parseWishlistCsv(csv);
    // expect(rows).toHaveLength(3);
    // expect(skipped).toBe(0);
  });

  it.skip("03.2-02: bad header (missing Adds) throws wishlist_csv_invalid_header", () => {
    const csv = read("wishlist-bad-header.csv");
    expect(csv).not.toContain(",Adds,");
    // 03.2-02: expect(() => parseWishlistCsv(csv)).toThrow("wishlist_csv_invalid_header");
  });

  it.skip("03.2-02: BOM + CRLF + trailing blank line are tolerated", () => {
    const csv = read("wishlist-bom-crlf.csv");
    expect(csv.charCodeAt(0)).toBe(0xfeff); // leading BOM
    // 03.2-02: const { rows, skipped } = parseWishlistCsv(csv);
    // expect(rows).toHaveLength(3);
    // expect(skipped).toBe(0);
  });

  it.skip("03.2-02: extra trailing column (MonthCohort) is ignored", () => {
    const csv = read("wishlist-extra-column.csv");
    expect(csv).toContain("MonthCohort");
    // 03.2-02: const { rows } = parseWishlistCsv(csv);
    // expect(rows).toHaveLength(3); // the 6 known columns still parse
  });

  it.skip("03.2-02: malformed row (non-integer Adds) → skipped===1, others present", () => {
    const csv = read("wishlist-malformed-row.csv");
    expect(csv).toContain("xx,1,0,0");
    // 03.2-02: const { rows, skipped } = parseWishlistCsv(csv);
    // expect(skipped).toBe(1);
    // expect(rows).toHaveLength(2);
  });

  it.skip("03.2-02: balance derivation oracle = cumulative(adds−deletes−pa−gifts) → 36/83/111", () => {
    const csv = read("wishlist-sample.csv");
    expect(csv).toContain("40,3,1,0");
    // 03.2-02: const { rows } = parseWishlistCsv(csv);
    // expect(rows.map((r) => r.balance)).toEqual([36, 83, 111]);
  });
});
