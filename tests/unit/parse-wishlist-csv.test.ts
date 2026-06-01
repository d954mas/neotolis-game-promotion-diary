import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWishlistCsv } from "../../src/lib/server/csv/parse-wishlist-csv.js";

// Plan 03.2-02 (Wave 1): live tests for the Steamworks Wishlists.csv parser.
// Flipped from the Wave 0 (Plan 03.2-01 Task 3) it.skip stubs once
// `parseWishlistCsv` shipped.
//
// Fixtures are the test oracle (RESEARCH.md ## Validation Architecture):
//   wishlist-sample.csv        — canonical 3 rows, raw components below
//   wishlist-bom-crlf.csv      — BOM + CRLF + trailing blank line tolerance
//   wishlist-bad-header.csv    — missing Adds column → invalid-header error
//   wishlist-extra-column.csv  — trailing MonthCohort column ignored
//   wishlist-malformed-row.csv — one non-integer Adds row → skipped===1
//
// NOTE: the parser is PURE and returns RAW components only. Cumulative
// balance (36/83/111) is derived in the SERVICE plan (03.2-03) over
// date-sorted rows, NOT here (see PLAN <interfaces>). The Wave 0 stub that
// asserted `r.balance` was speculative and conflicts with that contract; it
// is repurposed here to the empty/header-only invalid-header case the plan
// lists instead.

const FIXTURES = join(process.cwd(), "tests", "fixtures");
const read = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

describe("parseWishlistCsv (Plan 03.2-02)", () => {
  it("03.2-02: canonical CSV parses to 3 rows with skipped===0", () => {
    const csv = read("wishlist-sample.csv");
    expect(csv).toContain("DateLocal,Game,Adds,Deletes,PurchasesAndActivations,Gifts");
    const { rows, skipped } = parseWishlistCsv(csv);
    expect(skipped).toBe(0);
    expect(rows).toEqual([
      { date: "2026-05-28", adds: 40, deletes: 3, purchasesAndActivations: 1, gifts: 0 },
      { date: "2026-05-29", adds: 55, deletes: 5, purchasesAndActivations: 2, gifts: 1 },
      { date: "2026-05-30", adds: 30, deletes: 2, purchasesAndActivations: 0, gifts: 0 },
    ]);
  });

  it("03.2-02: bad header (missing Adds) throws wishlist_csv_invalid_header", () => {
    const csv = read("wishlist-bad-header.csv");
    expect(csv).not.toContain(",Adds,");
    expect(() => parseWishlistCsv(csv)).toThrow("wishlist_csv_invalid_header");
  });

  it("03.2-02: BOM + CRLF + trailing blank line are tolerated", () => {
    const csv = read("wishlist-bom-crlf.csv");
    expect(csv.charCodeAt(0)).toBe(0xfeff); // leading BOM
    const { rows, skipped } = parseWishlistCsv(csv);
    expect(skipped).toBe(0);
    expect(rows).toEqual([
      { date: "2026-05-28", adds: 40, deletes: 3, purchasesAndActivations: 1, gifts: 0 },
      { date: "2026-05-29", adds: 55, deletes: 5, purchasesAndActivations: 2, gifts: 1 },
      { date: "2026-05-30", adds: 30, deletes: 2, purchasesAndActivations: 0, gifts: 0 },
    ]);
  });

  it("03.2-02: extra trailing column (MonthCohort) is ignored", () => {
    const csv = read("wishlist-extra-column.csv");
    expect(csv).toContain("MonthCohort");
    const { rows } = parseWishlistCsv(csv);
    expect(rows).toHaveLength(3); // the 6 known columns still parse by name
    expect(rows[0]).toEqual({
      date: "2026-05-28",
      adds: 40,
      deletes: 3,
      purchasesAndActivations: 1,
      gifts: 0,
    });
  });

  it("03.2-02: malformed row (non-integer Adds) → skipped===1, others present", () => {
    const csv = read("wishlist-malformed-row.csv");
    expect(csv).toContain("xx,1,0,0");
    const { rows, skipped } = parseWishlistCsv(csv);
    expect(skipped).toBe(1);
    expect(rows).toHaveLength(2);
  });

  it("03.2-02: real Wishlist-Actions export (sep=, + title + blank preamble) parses, reconciles to 254", () => {
    // Real SteamWishlists_4654990_2026-04-23_to_2026-06-01.csv: a `sep=,`
    // hint line + a human title line + a blank line precede the real header.
    // The parser must skip that preamble and find the header by content.
    const csv = read("wishlist-actions-real.csv");
    expect(csv.startsWith("sep=,")).toBe(true);
    const { rows, skipped } = parseWishlistCsv(csv);
    expect(skipped).toBe(0);
    expect(rows).toHaveLength(39);
    expect(rows[0]).toEqual({
      date: "2026-04-23",
      adds: 21,
      deletes: 0,
      purchasesAndActivations: 0,
      gifts: 0,
    });
    // Lifetime cross-check vs the wishlist-summary file: Adds 267, Deletes 13,
    // Outstanding 254. Cumulative balance the service derives must equal 254.
    const totalAdds = rows.reduce((n, r) => n + r.adds, 0);
    const totalDeletes = rows.reduce((n, r) => n + r.deletes, 0);
    expect(totalAdds).toBe(267);
    expect(totalDeletes).toBe(13);
    expect(totalAdds - totalDeletes).toBe(254);
  });

  it("03.2-02: lifetime SUMMARY file is rejected with the specific is-lifetime-summary code", () => {
    // The wrong-but-common file: SteamWishlistSummary (one lifetime row,
    // OutstandingWishes column) instead of the daily Wishlist Actions export.
    const csv = read("wishlist-lifetime-summary.csv");
    expect(csv).toContain("OutstandingWishes");
    expect(() => parseWishlistCsv(csv)).toThrow("wishlist_csv_is_lifetime_summary");
  });

  it("03.2-02: RFC-4180 — a quoted game title with a comma does NOT shift the numeric columns", () => {
    // A naive split(",") would shift Adds/Deletes and silently skip every row.
    // Covers a comma inside a quoted field AND a doubled-quote ("") escape.
    const csv = [
      "sep=,",
      "Steam Wishlisting data for 2026-05-01 - 2026-05-02",
      "",
      "DateLocal,Game,Adds,Deletes,PurchasesAndActivations,Gifts",
      '2026-05-01,"Portal: Companion, Vol. 2",10,1,0,0',
      '2026-05-02,"Hello, ""World""",5,0,0,0',
    ].join("\n");
    const { rows, skipped } = parseWishlistCsv(csv);
    expect(skipped).toBe(0);
    expect(rows).toEqual([
      { date: "2026-05-01", adds: 10, deletes: 1, purchasesAndActivations: 0, gifts: 0 },
      { date: "2026-05-02", adds: 5, deletes: 0, purchasesAndActivations: 0, gifts: 0 },
    ]);
  });

  it("03.2-02: empty / header-only input throws wishlist_csv_invalid_header", () => {
    expect(() => parseWishlistCsv("")).toThrow("wishlist_csv_invalid_header");
    expect(() =>
      parseWishlistCsv("DateLocal,Game,Adds,Deletes,PurchasesAndActivations,Gifts\n"),
    ).toThrow("wishlist_csv_invalid_header");
  });
});
