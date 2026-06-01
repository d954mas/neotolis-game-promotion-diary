import { describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { and, eq, desc } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { seedUserDirectly } from "./helpers.js";

// Plan 03.2-03 (Wave 2): the wishlist CSV import HTTP surface + service.
//
// D-05 (idempotent re-import / last-write-wins), D-06 (tenant isolation,
// cross-tenant → 404 not 403), D-04 (audit row with full metadata) are the
// load-bearing invariants under test. Real Postgres, no DB mocks — only
// fetchSteamAppDetails is stubbed so addSteamListing does not hit the
// public Steam endpoint.

// Dev/test-DB conflation: tests run against the dev DB on some machines, so
// a fixed email collides across re-runs. Random suffix keeps emails unique.
const sfx = (): string => randomBytes(4).toString("hex");

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");

vi.mock("../../src/lib/server/integrations/steam-api.js", () => ({
  fetchSteamAppDetails: vi.fn(),
}));

const { createGame } = await import("../../src/lib/server/services/games.js");
const { addSteamListing } = await import(
  "../../src/lib/server/services/game-steam-listings.js"
);
const { fetchSteamAppDetails } = await import("../../src/lib/server/integrations/steam-api.js");
const { importWishlistCsv, getWishlistSummary, listRecentSnapshots } = await import(
  "../../src/lib/server/services/wishlist-snapshots.js"
);
const { wishlistSnapshots } = await import(
  "../../src/lib/server/db/schema/wishlist-snapshots.js"
);
const { auditLog } = await import("../../src/lib/server/db/schema/audit-log.js");
const { db } = await import("../../src/lib/server/db/client.js");
const { NotFoundError } = await import("../../src/lib/server/services/errors.js");

vi.mocked(fetchSteamAppDetails).mockResolvedValue(null);

interface SeedResult {
  userId: string;
  cookie: string;
  gameId: string;
  listingId: string;
  appId: number;
}

async function seedUserGameListing(emailPrefix: string, appId: number): Promise<SeedResult> {
  const user = await seedUserDirectly({ email: `${emailPrefix}-${sfx()}@test.local` });
  const game = await createGame(user.id, { title: "My Indie Game" }, "127.0.0.1");
  const listing = await addSteamListing(user.id, { gameId: game.id, appId }, "127.0.0.1");
  return {
    userId: user.id,
    cookie: `neotolis.session_token=${user.signedSessionCookieValue}`,
    gameId: game.id,
    listingId: listing.id,
    appId,
  };
}

describe("wishlist CSV import (Plan 03.2-03)", () => {
  it("03.2-03: import → upsert 3 rows in wishlist_snapshots for the listing (balances 36/83/111)", async () => {
    const s = await seedUserGameListing("wl-import", 620);

    const result = await importWishlistCsv(
      s.userId,
      s.gameId,
      s.listingId,
      fixture("wishlist-sample.csv"),
      "127.0.0.1",
    );

    expect(result).toEqual({
      rowCount: 3,
      updated: 0,
      skipped: 0,
      dateRange: { from: "2026-05-28", to: "2026-05-30" },
    });

    const rows = await db
      .select()
      .from(wishlistSnapshots)
      .where(
        and(
          eq(wishlistSnapshots.userId, s.userId),
          eq(wishlistSnapshots.listingId, s.listingId),
        ),
      )
      .orderBy(wishlistSnapshots.date);

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.balance)).toEqual([36, 83, 111]);
    expect(rows.map((r) => r.source)).toEqual(["csv", "csv", "csv"]);
    // Raw components persisted.
    expect(rows[0]).toMatchObject({ adds: 40, deletes: 3, purchasesAndActivations: 1, gifts: 0 });
    expect(rows[1]).toMatchObject({ adds: 55, deletes: 5, purchasesAndActivations: 2, gifts: 1 });
    expect(rows[2]).toMatchObject({ adds: 30, deletes: 2, purchasesAndActivations: 0, gifts: 0 });
  });

  it("03.2-03: idempotent re-import — same row count, balances unchanged, updated_at bumped, updated:3 (D-05)", async () => {
    const s = await seedUserGameListing("wl-idem", 620);
    const csv = fixture("wishlist-sample.csv");

    const first = await importWishlistCsv(s.userId, s.gameId, s.listingId, csv, "127.0.0.1");
    expect(first.updated).toBe(0);
    expect(first.rowCount).toBe(3);

    const second = await importWishlistCsv(s.userId, s.gameId, s.listingId, csv, "127.0.0.1");
    expect(second.updated).toBe(3);
    expect(second.rowCount).toBe(3);

    const after = await db
      .select()
      .from(wishlistSnapshots)
      .where(eq(wishlistSnapshots.listingId, s.listingId))
      .orderBy(wishlistSnapshots.date);

    expect(after).toHaveLength(3);
    expect(after.map((r) => r.balance)).toEqual([36, 83, 111]);
    // The conflict path sets updatedAt; createdAt stays the original insert
    // time, so updatedAt >= createdAt proves the UPDATE branch fired (and
    // sidesteps the Postgres-server-clock vs Node-client-clock skew that a
    // cross-import updatedAt comparison would be subject to).
    after.forEach((r) => {
      expect(r.updatedAt.getTime()).toBeGreaterThanOrEqual(r.createdAt.getTime());
    });
  });

  it("03.2-03: malformed-row CSV → skipped count surfaces, valid rows land", async () => {
    const s = await seedUserGameListing("wl-malformed", 620);

    const result = await importWishlistCsv(
      s.userId,
      s.gameId,
      s.listingId,
      fixture("wishlist-malformed-row.csv"),
      "127.0.0.1",
    );

    // wishlist-malformed-row.csv: 2 valid rows (05-28, 05-29) + 1 malformed (xx adds).
    expect(result.skipped).toBe(1);
    expect(result.rowCount).toBe(2);
    expect(result.dateRange).toEqual({ from: "2026-05-28", to: "2026-05-29" });

    const rows = await db
      .select()
      .from(wishlistSnapshots)
      .where(eq(wishlistSnapshots.listingId, s.listingId));
    expect(rows).toHaveLength(2);
  });

  it("03.2-03: getWishlistSummary returns latest balance/date + recent days DESC; null when empty", async () => {
    const s = await seedUserGameListing("wl-summary", 620);

    // No snapshots yet → null.
    const empty = await getWishlistSummary(s.userId, s.listingId);
    expect(empty).toBeNull();

    await importWishlistCsv(
      s.userId,
      s.gameId,
      s.listingId,
      fixture("wishlist-sample.csv"),
      "127.0.0.1",
    );

    const summary = await getWishlistSummary(s.userId, s.listingId);
    expect(summary).not.toBeNull();
    expect(summary!.balance).toBe(111);
    expect(summary!.lastDate).toBe("2026-05-30");
    // recent days ordered DESC by date.
    expect(summary!.recentDays.map((d) => d.date)).toEqual([
      "2026-05-30",
      "2026-05-29",
      "2026-05-28",
    ]);
    // DTO discipline: userId stripped.
    expect(summary!.recentDays[0]).not.toHaveProperty("userId");

    const recent = await listRecentSnapshots(s.userId, s.listingId);
    expect(recent.map((d) => d.date)).toEqual(["2026-05-30", "2026-05-29", "2026-05-28"]);
    expect(recent[0]).not.toHaveProperty("userId");
  });

  it("03.2-03: tenant isolation — user A importing to user B's listing → NotFoundError; B's snapshots invisible to A (D-06)", async () => {
    const a = await seedUserGameListing("wl-tenant-a", 620);
    const b = await seedUserGameListing("wl-tenant-b", 730);

    // A tries to import to B's listing → 404 (NotFoundError), before any write.
    await expect(
      importWishlistCsv(a.userId, b.gameId, b.listingId, fixture("wishlist-sample.csv"), "127.0.0.1"),
    ).rejects.toBeInstanceOf(NotFoundError);

    // B imports to their own listing.
    await importWishlistCsv(
      b.userId,
      b.gameId,
      b.listingId,
      fixture("wishlist-sample.csv"),
      "127.0.0.1",
    );

    // A reading B's listingId sees nothing (tenant-scoped read).
    const aSeesB = await getWishlistSummary(a.userId, b.listingId);
    expect(aSeesB).toBeNull();
    const aList = await listRecentSnapshots(a.userId, b.listingId);
    expect(aList).toHaveLength(0);

    // No snapshots were written to B's listing by A's failed import attempt
    // beyond the legitimate one B did themselves.
    const rows = await db
      .select()
      .from(wishlistSnapshots)
      .where(eq(wishlistSnapshots.listingId, b.listingId));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.userId === b.userId)).toBe(true);
  });

  it("03.2-03: two users, SAME appId, different games — each sees only their own snapshots (no bleed by appId)", async () => {
    // The privacy concern: appId is NOT the storage key (listing_id + user_id
    // are). Two tenants owning the same Steam appId must stay fully isolated.
    const APPID = 4654990;
    const a = await seedUserGameListing("wl-sameapp-a", APPID);
    const b = await seedUserGameListing("wl-sameapp-b", APPID);
    // Same appId, but distinct listing rows — UNIQUE(game_id, app_id) is
    // per-game, so the shared appId does not collide across tenants.
    expect(a.appId).toBe(b.appId);
    expect(a.listingId).not.toBe(b.listingId);

    // Distinct data per user so any bleed would show: A = 3-row sample
    // (balance 111), B = the real 39-row daily export (balance 254).
    await importWishlistCsv(a.userId, a.gameId, a.listingId, fixture("wishlist-sample.csv"), "127.0.0.1");
    await importWishlistCsv(
      b.userId,
      b.gameId,
      b.listingId,
      fixture("wishlist-actions-real.csv"),
      "127.0.0.1",
    );

    // Each user reads only their own balance.
    expect((await getWishlistSummary(a.userId, a.listingId))?.balance).toBe(111);
    expect((await getWishlistSummary(b.userId, b.listingId))?.balance).toBe(254);

    // Cross-tenant reads of the OTHER user's listing (same appId) → empty/null.
    expect(await getWishlistSummary(a.userId, b.listingId)).toBeNull();
    expect(await listRecentSnapshots(a.userId, b.listingId)).toHaveLength(0);
    expect(await getWishlistSummary(b.userId, a.listingId)).toBeNull();
    expect(await listRecentSnapshots(b.userId, a.listingId)).toHaveLength(0);

    // DB-level: every snapshot under each listing carries only its owner.
    const aRows = await db
      .select()
      .from(wishlistSnapshots)
      .where(eq(wishlistSnapshots.listingId, a.listingId));
    expect(aRows).toHaveLength(3);
    expect(aRows.every((r) => r.userId === a.userId)).toBe(true);
    const bRows = await db
      .select()
      .from(wishlistSnapshots)
      .where(eq(wishlistSnapshots.listingId, b.listingId));
    expect(bRows).toHaveLength(39);
    expect(bRows.every((r) => r.userId === b.userId)).toBe(true);
  });

  it("03.2-03: filename appId guard — mismatched SteamWishlists_{appId}_ name rejected; matching / renamed names import", async () => {
    const s = await seedUserGameListing("wl-fileguard", 620);
    const csv = fixture("wishlist-sample.csv");

    // Wrong game's export (appId 999999 in the Steam filename) → rejected
    // before any write, with the specific app-mismatch code.
    await expect(
      importWishlistCsv(
        s.userId,
        s.gameId,
        s.listingId,
        csv,
        "127.0.0.1",
        "SteamWishlists_999999_2026-04-23_to_2026-06-01.csv",
      ),
    ).rejects.toThrow("wishlist_csv_app_mismatch");
    const none = await db
      .select()
      .from(wishlistSnapshots)
      .where(eq(wishlistSnapshots.listingId, s.listingId));
    expect(none).toHaveLength(0);

    // Filename appId matches the listing → imports.
    const ok = await importWishlistCsv(
      s.userId,
      s.gameId,
      s.listingId,
      csv,
      "127.0.0.1",
      "SteamWishlists_620_2026-04-23_to_2026-06-01.csv",
    );
    expect(ok.rowCount).toBe(3);

    // Renamed file (no appId in the name) → can't verify, so allowed.
    const renamed = await importWishlistCsv(
      s.userId,
      s.gameId,
      s.listingId,
      csv,
      "127.0.0.1",
      "my-wishlists.csv",
    );
    expect(renamed.rowCount).toBe(3);
  });

  it("03.2-03: wishlist.imported audit row written with { appId, listingId, rowCount, dateRange } (D-04)", async () => {
    const s = await seedUserGameListing("wl-audit", 9001);

    await importWishlistCsv(
      s.userId,
      s.gameId,
      s.listingId,
      fixture("wishlist-sample.csv"),
      "127.0.0.1",
    );

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, s.userId), eq(auditLog.action, "wishlist.imported")))
      .orderBy(desc(auditLog.createdAt));

    expect(audits).toHaveLength(1);
    const meta = audits[0]!.metadata as Record<string, unknown>;
    expect(meta).toMatchObject({
      appId: 9001,
      listingId: s.listingId,
      rowCount: 3,
      dateRange: { from: "2026-05-28", to: "2026-05-30" },
      skipped: 0,
    });
  });

  // Full HTTP-path assertions for the multipart route (Task 2). These drive
  // the mounted POST route via app.request with a multipart FormData body.
  describe("HTTP route — POST /api/games/:gameId/listings/:listingId/wishlist-import", () => {
    async function postCsv(
      cookie: string,
      gameId: string,
      listingId: string,
      csv: string,
      filename = "Wishlists.csv",
    ): Promise<Response> {
      const { createApp } = await import("../../src/lib/server/http/app.js");
      const app = createApp();
      const form = new FormData();
      form.append("file", new Blob([csv], { type: "text/csv" }), filename);
      return app.request(`/api/games/${gameId}/listings/${listingId}/wishlist-import`, {
        method: "POST",
        headers: { cookie },
        body: form,
      });
    }

    it("happy path → 200 with { rowCount, updated, skipped, dateRange }", async () => {
      const s = await seedUserGameListing("wl-http-ok", 620);
      const res = await postCsv(s.cookie, s.gameId, s.listingId, fixture("wishlist-sample.csv"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({
        rowCount: 3,
        updated: 0,
        skipped: 0,
        dateRange: { from: "2026-05-28", to: "2026-05-30" },
      });
    });

    it("cross-tenant listingId → 404, body has no 'forbidden'/'permission' (D-06)", async () => {
      const a = await seedUserGameListing("wl-http-ct-a", 620);
      const b = await seedUserGameListing("wl-http-ct-b", 730);
      // user A's cookie POSTing against user B's gameId/listingId → 404.
      const res = await postCsv(a.cookie, b.gameId, b.listingId, fixture("wishlist-sample.csv"));
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).not.toMatch(/forbidden|permission/i);
    });

    it("bad-header CSV → 422 wishlist_csv_invalid_header", async () => {
      const s = await seedUserGameListing("wl-http-badhdr", 620);
      const res = await postCsv(s.cookie, s.gameId, s.listingId, fixture("wishlist-bad-header.csv"));
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("wishlist_csv_invalid_header");
    });

    it("missing file part → 422 wishlist_csv_missing_file", async () => {
      const s = await seedUserGameListing("wl-http-nofile", 620);
      const { createApp } = await import("../../src/lib/server/http/app.js");
      const app = createApp();
      const form = new FormData();
      form.append("notfile", "irrelevant");
      const res = await app.request(
        `/api/games/${s.gameId}/listings/${s.listingId}/wishlist-import`,
        { method: "POST", headers: { cookie: s.cookie }, body: form },
      );
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("wishlist_csv_missing_file");
    });

    it("oversized body (>2 MiB) → 413 wishlist_csv_too_large", async () => {
      const s = await seedUserGameListing("wl-http-toolarge", 620);
      // A valid header + a huge number of valid rows pushes the body past 2 MiB.
      const header = "DateLocal,Game,Adds,Deletes,PurchasesAndActivations,Gifts\n";
      const row = "2026-05-28,My Indie Game,1,0,0,0\n";
      const big = header + row.repeat(70000); // ~2.3 MiB
      const res = await postCsv(s.cookie, s.gameId, s.listingId, big);
      expect(res.status).toBe(413);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("wishlist_csv_too_large");
    });
  });
});
