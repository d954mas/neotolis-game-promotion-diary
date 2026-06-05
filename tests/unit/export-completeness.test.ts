// D-08 account export envelope completeness drift-guard (06-02 flips this green).
//
// The silent gap this test exists to prevent: the JSON export predated Phase
// 3.1/3.2/4 and quietly dropped the user's wishlist + per-post metric history.
// Nobody noticed because nothing FAILED when a new tenant table shipped without
// an export key. This test makes that omission loud:
//
//   For every identifier in the ESLint plugin's TENANT_TABLES set, the table
//   MUST be either (a) mapped to an AccountExportEnvelope key in
//   EXPORT_KEY_BY_TENANT_TABLE, or (b) named in EXPORT_EXCLUDED_TENANT_TABLES
//   with a documented reason. Adding a new tenant table to TENANT_TABLES
//   without doing one of those two fails this test by name.
//
// TENANT_TABLES is imported from the ESLint plugin (the single source of truth
// for "what is a tenant table"); it holds camelCase Drizzle identifiers, NOT
// SQL snake_case names.

import { describe, it, expect } from "vitest";
import { TENANT_TABLES } from "../../eslint-plugin-tenant-scope/no-unfiltered-tenant-query.js";
import type { AccountExportEnvelope } from "../../src/lib/server/services/account.js";

// camelCase TENANT_TABLES identifier → AccountExportEnvelope top-level key.
const EXPORT_KEY_BY_TENANT_TABLE: Record<string, string> = {
  games: "games",
  gameSteamListings: "game_steam_listings",
  dataSources: "data_sources",
  events: "events",
  apiKeysSteam: "api_keys_steam",
  auditLog: "audit_log",
  wishlistSnapshots: "wishlist_snapshots",
};

// Tenant tables intentionally NOT carried in the export envelope, each with the
// reason it is excluded. A reviewer adding a tenant table that genuinely should
// not be exported lands it here (a deliberate decision), not silently nowhere.
const EXPORT_EXCLUDED_TENANT_TABLES = new Set<string>([
  "eventGames", // junction — represented inside events[].gameIds, not as its own section
  "adapterRefreshQueue", // operational queue/cursor state, not user content
]);

// The frozen 11-key envelope shape (10 sections + the exported_at scalar). YT
// and Reddit per-event metric history are PUBLIC-DATA sections (no user_id) so
// they are NOT in EXPORT_KEY_BY_TENANT_TABLE above — but they ARE keys of the
// envelope, so they belong in this pin. Adding/removing an envelope key without
// updating this list fails the second test.
const EXPECTED_EXPORT_KEYS = [
  "api_keys_steam",
  "audit_log",
  "data_sources",
  "events",
  "exported_at",
  "game_steam_listings",
  "games",
  "reddit_post_snapshots",
  "user",
  "wishlist_snapshots",
  "youtube_video_snapshots",
].sort();

describe("account export envelope completeness (D-08)", () => {
  it("every TENANT_TABLES entry has a corresponding AccountExportEnvelope key OR is in EXPORT_EXCLUDED_TENANT_TABLES [06-02]", () => {
    const uncovered: string[] = [];
    for (const table of TENANT_TABLES) {
      const isExported = Object.prototype.hasOwnProperty.call(EXPORT_KEY_BY_TENANT_TABLE, table);
      const isExcluded = EXPORT_EXCLUDED_TENANT_TABLES.has(table);
      if (!isExported && !isExcluded) uncovered.push(table);
    }
    // Fail loudly naming the offender: a new tenant table without an export key
    // AND without an explicit exclusion is exactly the drift that left
    // wishlists out of the export for three phases.
    expect(
      uncovered,
      `Tenant table(s) ${JSON.stringify(uncovered)} are in TENANT_TABLES but neither ` +
        `mapped to an AccountExportEnvelope key (EXPORT_KEY_BY_TENANT_TABLE) nor ` +
        `excluded with a reason (EXPORT_EXCLUDED_TENANT_TABLES). Wire it into the ` +
        `export or document why it is excluded.`,
    ).toEqual([]);

    // The mapping must not reference tables that no longer exist in TENANT_TABLES
    // (stale entry detection — keeps the map honest as tables are removed).
    const stale = Object.keys(EXPORT_KEY_BY_TENANT_TABLE).filter((t) => !TENANT_TABLES.has(t));
    expect(stale, `EXPORT_KEY_BY_TENANT_TABLE has stale tables not in TENANT_TABLES`).toEqual([]);
    const staleExcluded = [...EXPORT_EXCLUDED_TENANT_TABLES].filter((t) => !TENANT_TABLES.has(t));
    expect(
      staleExcluded,
      `EXPORT_EXCLUDED_TENANT_TABLES has stale tables not in TENANT_TABLES`,
    ).toEqual([]);
  });

  it("AccountExportEnvelope keys match the frozen EXPECTED_EXPORT_KEYS list [06-02]", () => {
    // Build a sample envelope typed as the REAL AccountExportEnvelope so a key
    // added to the interface without one here is a TYPECHECK failure (Record of
    // every required key), and a key removed from the interface makes the
    // `satisfies` excess-property check fail. Object.keys then pins the runtime
    // key set against the frozen EXPECTED_EXPORT_KEYS list — the export-key set
    // becomes a deliberate, reviewed decision rather than a silent gap.
    const sample = {
      exported_at: "1970-01-01T00:00:00.000Z",
      user: {} as AccountExportEnvelope["user"],
      games: [],
      game_steam_listings: [],
      data_sources: [],
      events: [],
      api_keys_steam: [],
      audit_log: [],
      wishlist_snapshots: [],
      youtube_video_snapshots: [],
      reddit_post_snapshots: [],
    } satisfies AccountExportEnvelope;
    expect(Object.keys(sample).sort()).toEqual(EXPECTED_EXPORT_KEYS);

    // Every EXPORT_KEY_BY_TENANT_TABLE target must be a real envelope key —
    // catches a typo'd mapping value (e.g. "wishlists" vs "wishlist_snapshots").
    for (const key of Object.values(EXPORT_KEY_BY_TENANT_TABLE)) {
      expect(EXPECTED_EXPORT_KEYS).toContain(key);
    }
  });
});
