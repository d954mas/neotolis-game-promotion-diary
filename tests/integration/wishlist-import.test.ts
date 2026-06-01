import { describe, it } from "vitest";
import { createApp } from "../../src/lib/server/http/app.js";

// Wave 0 scaffold (Plan 03.2-01 Task 3): named-plan it.skip stubs for the
// wishlist CSV import HTTP surface. The behavior these assert ships in Plan
// 03.2-03 (Wave 2) — the POST /api/games/:gameId/listings/:listingId/
// wishlist-import route + service do not exist yet, so these are it.skip
// until 03.2-03 flips them to live `it(...)`.
//
// D-05 (idempotent re-import / last-write-wins), D-06 (tenant isolation,
// cross-tenant → 404 not 403), D-04 (audit row with full metadata) are the
// load-bearing invariants under test.

describe("wishlist CSV import (Plan 03.2-03)", () => {
  const app = createApp();
  void app; // referenced live in 03.2-03

  it.skip("03.2-03: upload → upsert 3 rows in wishlist_snapshots for the listing", async () => {
    // 03.2-03: seed user + game + steam listing; POST sample CSV multipart;
    // assert 3 wishlist_snapshots rows for the listing, balances 36/83/111.
  });

  it.skip("03.2-03: idempotent re-import — same row count, balances unchanged, updated_at bumped (D-05)", async () => {
    // 03.2-03: import twice; assert row count stable, balances identical,
    // updated_at advanced, response reports `updated: 3`.
  });

  it.skip("03.2-03: tenant isolation — user B's listing not writable by user A → 404; A's snapshots invisible to B (D-06)", async () => {
    // 03.2-03: seed users A + B; A uploads to B's listingId → 404;
    // B's snapshots never appear in A's reads.
  });

  it.skip("03.2-03: cross-tenant upload → 404 (not 403); body has no 'forbidden'/'permission' (D-06)", async () => {
    // 03.2-03: assert res.status === 404 and JSON body string excludes
    // "forbidden" and "permission".
  });

  it.skip("03.2-03: wishlist.imported audit row written with { appId, listingId, rowCount, dateRange } (D-04)", async () => {
    // 03.2-03: after import, assert one audit_log row action='wishlist.imported'
    // with metadata { appId, listingId, rowCount, dateRange }.
  });

  it.skip("03.2-03: bad-header → 422 / too-large → 413 / missing-file → 422 over full HTTP path", async () => {
    // 03.2-03: drive each error path through the mounted route.
  });
});
