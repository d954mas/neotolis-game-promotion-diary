import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import { auditLog } from "../../src/lib/server/db/schema/audit-log.js";
import { games } from "../../src/lib/server/db/schema/games.js";
import { gameSteamListings } from "../../src/lib/server/db/schema/game-steam-listings.js";
// The gameYoutubeChannels / youtubeChannels / trackedYoutubeVideos
// schemas were retired in the baseline schema collapse. The original
// cascade test referenced them directly; we skip the stale subtest
// below (preserves the trail). The events cascade is also REMOVED
// (events are M:N now); the per-listing cascade continues to work via
// gameSteamListings (covered by the restore subtest).
import {
  createGame,
  softDeleteGame,
  restoreGame,
  getGameById,
  getGameByIdIncludingDeleted,
  updateGame,
  deriveReleaseInfoForGames,
  hardDeleteGame,
} from "../../src/lib/server/services/games.js";
import { toGameDto } from "../../src/lib/server/dto.js";
import { seedUserDirectly } from "./helpers.js";
import { AppError, NotFoundError } from "../../src/lib/server/services/errors.js";

/**
 * Games CRUD integration tests.
 */
describe("games CRUD", () => {
  it("create game returns 201 + DTO", async () => {
    const userA = await seedUserDirectly({ email: "g1-a@test.local" });
    const game = await createGame(userA.id, { title: "My Test Game" }, "127.0.0.1");

    expect(game.title).toBe("My Test Game");
    expect(game.userId).toBe(userA.id);
    // UUIDv7 hex with dashes (8-4-4-4-12).
    expect(game.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(game.notes).toBe("");
    expect(game.tags).toEqual([]);
    expect(game.deletedAt).toBeNull();

    const audits = await db.select().from(auditLog).where(eq(auditLog.userId, userA.id));
    const createdAudit = audits.find(
      (a) =>
        a.action === "game.created" &&
        (a.metadata as { gameId?: string } | null)?.gameId === game.id,
    );
    expect(createdAudit).toBeDefined();
  });

  it("422 on missing title", async () => {
    const userA = await seedUserDirectly({ email: "g2-a@test.local" });
    await expect(createGame(userA.id, { title: "" }, "127.0.0.1")).rejects.toBeInstanceOf(AppError);
    await expect(createGame(userA.id, { title: "   " }, "127.0.0.1")).rejects.toMatchObject({
      code: "validation_failed",
      status: 422,
    });

    // No row should have been inserted on the validation failure.
    const rows = await db.select().from(games).where(eq(games.userId, userA.id));
    expect(rows).toHaveLength(0);
  });

  // The original cascade test referenced gameYoutubeChannels /
  // youtubeChannels / trackedYoutubeVideos schemas that have been
  // retired. The events cascade in softDeleteGame is also removed
  // (M:N relations can't cleanly map a game's soft-delete to "delete
  // events whose gameId = this"). The gameSteamListings cascade
  // behavior is covered by the restore subtest below. Kept as
  // it.skip to preserve the trail.
  it.skip("soft cascade delete (superseded — gameSteamListings cascade covered by restore subtest below)", async () => {
    // Body intentionally elided — the original test exercised a cascade
    // which has been retired. The cascade now spans gameSteamListings
    // only; that path is exercised by the restore subtest below which
    // verifies the marker-timestamp design end-to-end.
  });

  it("transactional restore", async () => {
    const userA = await seedUserDirectly({ email: "g4-a@test.local" });
    const game = await createGame(userA.id, { title: "G4" }, "127.0.0.1");

    const [earlyListing] = await db
      .insert(gameSteamListings)
      .values({ userId: userA.id, gameId: game.id, appId: 1001, label: "Early" })
      .returning();
    const [laterListing] = await db
      .insert(gameSteamListings)
      .values({ userId: userA.id, gameId: game.id, appId: 1002, label: "Later" })
      .returning();

    // Soft-delete the EARLY listing first; its deletedAt < parent.deletedAt.
    const earlyDeletedAt = new Date(Date.now() - 60_000); // 1 minute ago
    await db
      .update(gameSteamListings)
      .set({ deletedAt: earlyDeletedAt })
      .where(
        and(eq(gameSteamListings.userId, userA.id), eq(gameSteamListings.id, earlyListing!.id)),
      );

    // Now soft-delete the parent (which also cascades laterListing with the parent's marker).
    await softDeleteGame(userA.id, game.id, "127.0.0.1");

    const [parentDeleted] = await db.select().from(games).where(eq(games.id, game.id));
    const markerTs = parentDeleted!.deletedAt!.getTime();
    // The early listing kept its earlier timestamp (cascade only touches NULL deletedAt rows).
    const [earlyAfterDelete] = await db
      .select()
      .from(gameSteamListings)
      .where(eq(gameSteamListings.id, earlyListing!.id));
    expect(earlyAfterDelete!.deletedAt!.getTime()).toBe(earlyDeletedAt.getTime());
    expect(earlyAfterDelete!.deletedAt!.getTime()).toBeLessThan(markerTs);

    // Restore the parent.
    await restoreGame(userA.id, game.id, "127.0.0.1");

    const [parentAfter] = await db.select().from(games).where(eq(games.id, game.id));
    const [earlyAfter] = await db
      .select()
      .from(gameSteamListings)
      .where(eq(gameSteamListings.id, earlyListing!.id));
    const [laterAfter] = await db
      .select()
      .from(gameSteamListings)
      .where(eq(gameSteamListings.id, laterListing!.id));

    expect(parentAfter!.deletedAt).toBeNull();
    // Later listing was cascaded with the parent's marker → restore reverses it.
    expect(laterAfter!.deletedAt).toBeNull();
    // Early listing's deletedAt !== marker → stays deleted.
    expect(earlyAfter!.deletedAt).not.toBeNull();
    expect(earlyAfter!.deletedAt!.getTime()).toBe(earlyDeletedAt.getTime());

    // Audit row exists.
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, userA.id), eq(auditLog.action, "game.restored")));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect((audits[0]!.metadata as { gameId?: string } | null)?.gameId).toBe(game.id);
  });

  // games.description column added in migration 0007 + updateGame
  // service extension + DTO projection. User during UAT (verbatim, ru):
  // "Еще я хочу чтобы тут можно было сделать описание игры." The
  // service-layer 2000-char cap and the empty-string → NULL
  // normalization are exercised here so the contract holds
  // independently of the HTTP-route Zod schema (which also caps at
  // 2000 — defense-in-depth).
  describe("games.description", () => {
    it("updateGame round-trips a description and the DTO projects it", async () => {
      const userA = await seedUserDirectly({ email: "p14a-rt-a@test.local" });
      const game = await createGame(userA.id, { title: "Desc RT" }, "127.0.0.1");
      // Initial state: NULL description.
      expect(game.description).toBeNull();
      const dto0 = toGameDto(game);
      expect(dto0.description).toBeNull();

      const updated = await updateGame(userA.id, game.id, {
        description: "A short pitch about the game.",
      });
      expect(updated.description).toBe("A short pitch about the game.");

      const dto1 = toGameDto(updated);
      expect(dto1.description).toBe("A short pitch about the game.");
      // P3 discipline: userId never crosses the projection boundary.
      expect(dto1).not.toHaveProperty("userId");
    });

    it("updateGame normalizes empty string to NULL", async () => {
      const userA = await seedUserDirectly({ email: "p14a-empty-a@test.local" });
      const game = await createGame(userA.id, { title: "Empty Desc" }, "127.0.0.1");
      // Set a real description first.
      const set = await updateGame(userA.id, game.id, {
        description: "Initial",
      });
      expect(set.description).toBe("Initial");
      // Empty string → NULL (service-layer normalization).
      const cleared = await updateGame(userA.id, game.id, {
        description: "",
      });
      expect(cleared.description).toBeNull();
      // Whitespace-only also normalizes to NULL.
      const wsCleared = await updateGame(userA.id, game.id, {
        description: "   \n  ",
      });
      expect(wsCleared.description).toBeNull();
    });

    it("updateGame allows explicit null to clear description", async () => {
      const userA = await seedUserDirectly({ email: "p14a-null-a@test.local" });
      const game = await createGame(userA.id, { title: "Null Desc" }, "127.0.0.1");
      await updateGame(userA.id, game.id, { description: "Set first" });
      const cleared = await updateGame(userA.id, game.id, { description: null });
      expect(cleared.description).toBeNull();
    });

    it("updateGame rejects descriptions over 2000 chars (validation_failed 422)", async () => {
      const userA = await seedUserDirectly({ email: "p14a-cap-a@test.local" });
      const game = await createGame(userA.id, { title: "Cap" }, "127.0.0.1");
      const tooLong = "x".repeat(2001);
      await expect(updateGame(userA.id, game.id, { description: tooLong })).rejects.toMatchObject({
        code: "validation_failed",
        status: 422,
      });
      // Boundary case: exactly 2000 chars is OK.
      const exactly2000 = "y".repeat(2000);
      const ok = await updateGame(userA.id, game.id, { description: exactly2000 });
      expect(ok.description).toBe(exactly2000);
    });

    it("cross-tenant updateGame with description still surfaces NotFoundError (404, not 403)", async () => {
      const userA = await seedUserDirectly({ email: "p14a-ct-a@test.local" });
      const userB = await seedUserDirectly({ email: "p14a-ct-b@test.local" });
      const aGame = await createGame(userA.id, { title: "A's Desc" }, "127.0.0.1");
      // User B writes a description to A's game → NotFoundError (PRIV-01).
      await expect(
        updateGame(userB.id, aGame.id, { description: "leak attempt" }),
      ).rejects.toBeInstanceOf(NotFoundError);
      // A's game description stays NULL.
      const stillThere = await getGameById(userA.id, aGame.id);
      expect(stillThere.description).toBeNull();
    });
  });

  it("02-04: cross-tenant getGameById returns NotFoundError (404, not 403)", async () => {
    const userA = await seedUserDirectly({ email: "ct-a@test.local" });
    const userB = await seedUserDirectly({ email: "ct-b@test.local" });
    const aGame = await createGame(userA.id, { title: "A's Game" }, "127.0.0.1");

    // Cross-tenant READ: NotFoundError (PRIV-01).
    await expect(getGameById(userB.id, aGame.id)).rejects.toBeInstanceOf(NotFoundError);

    // Cross-tenant SOFT-DELETE: NotFoundError too (the UPDATE matches zero rows under userB.id).
    await expect(softDeleteGame(userB.id, aGame.id, "127.0.0.1")).rejects.toBeInstanceOf(
      NotFoundError,
    );

    // The original game is still readable + intact for the actual owner.
    const stillThere = await getGameByIdIncludingDeleted(userA.id, aGame.id);
    expect(stillThere.deletedAt).toBeNull();
  });
});

// games.release_date + games.release_tba columns DROPPED in migration
// 0047 per denormalization-audit-2.md V-2 (AGENTS.md no-denorm rule).
// The effective release date is derived from `game_steam_listings`
// rows via deriveReleaseInfoForGames(). These tests assert the
// derivation contract:
//   - releaseDate: earliest non-null release_date across non-deleted listings
//   - releaseTba:  true when any non-deleted listing has release_date IS NULL
// The DTO consumer (GameCard / /games/[gameId]/+page.svelte) reads
// these fields under the same names they did before; only the SOURCE
// moved from the games row to the listings JOIN.
describe("games release info derived from listings (denorm fix V-2)", () => {
  it("returns empty release info for a game with no listings", async () => {
    const userA = await seedUserDirectly({ email: "rd-empty@test.local" });
    const game = await createGame(userA.id, { title: "No listings" }, "127.0.0.1");
    const map = await deriveReleaseInfoForGames(userA.id, [game.id]);
    // No rows in the map at all → caller falls back to {null,false}.
    expect(map.has(game.id)).toBe(false);

    // DTO path: loader passes the empty fallback explicitly.
    const dto = toGameDto(game);
    expect(dto.releaseDate).toBeNull();
    expect(dto.releaseTba).toBe(false);
  });

  it("releaseDate is the earliest non-null release_date across non-deleted listings", async () => {
    const userA = await seedUserDirectly({ email: "rd-early@test.local" });
    const game = await createGame(userA.id, { title: "Multi-release" }, "127.0.0.1");
    await db.insert(gameSteamListings).values([
      // Insert in NON-sorted order to verify the derivation actually picks the earliest.
      {
        userId: userA.id,
        gameId: game.id,
        appId: 1,
        label: "DLC",
        releaseDate: "2026-09-15",
      },
      {
        userId: userA.id,
        gameId: game.id,
        appId: 2,
        label: "Main",
        releaseDate: "2024-03-14",
      },
      {
        userId: userA.id,
        gameId: game.id,
        appId: 3,
        label: "OST",
        releaseDate: "2025-06-20",
      },
    ]);
    const map = await deriveReleaseInfoForGames(userA.id, [game.id]);
    expect(map.get(game.id)).toEqual({ releaseDate: "2024-03-14", releaseTba: false });
  });

  it("releaseTba=true when ANY non-deleted listing has release_date NULL", async () => {
    const userA = await seedUserDirectly({ email: "rd-tba@test.local" });
    const game = await createGame(userA.id, { title: "Mixed TBA" }, "127.0.0.1");
    await db.insert(gameSteamListings).values([
      {
        userId: userA.id,
        gameId: game.id,
        appId: 10,
        label: "Main",
        releaseDate: "2025-06-20",
      },
      {
        userId: userA.id,
        gameId: game.id,
        appId: 11,
        label: "Demo",
        releaseDate: null,
      },
    ]);
    const map = await deriveReleaseInfoForGames(userA.id, [game.id]);
    // Date from the dated listing surfaces AND TBA is true because of the null one.
    expect(map.get(game.id)).toEqual({ releaseDate: "2025-06-20", releaseTba: true });
  });

  it("soft-deleted listings are EXCLUDED from the derivation", async () => {
    const userA = await seedUserDirectly({ email: "rd-soft@test.local" });
    const game = await createGame(userA.id, { title: "Soft-deleted" }, "127.0.0.1");
    await db.insert(gameSteamListings).values([
      {
        userId: userA.id,
        gameId: game.id,
        appId: 20,
        label: "Live",
        releaseDate: "2026-01-01",
      },
      {
        userId: userA.id,
        gameId: game.id,
        appId: 21,
        label: "Old",
        releaseDate: "2020-01-01",
        deletedAt: new Date(), // soft-deleted earlier listing
      },
    ]);
    const map = await deriveReleaseInfoForGames(userA.id, [game.id]);
    // The old (soft-deleted) row is ignored — earliest live date is 2026-01-01.
    expect(map.get(game.id)).toEqual({ releaseDate: "2026-01-01", releaseTba: false });
  });

  it("batched: one query returns the per-game map for many games", async () => {
    const userA = await seedUserDirectly({ email: "rd-batch@test.local" });
    const g1 = await createGame(userA.id, { title: "G1" }, "127.0.0.1");
    const g2 = await createGame(userA.id, { title: "G2" }, "127.0.0.1");
    const g3 = await createGame(userA.id, { title: "G3" }, "127.0.0.1"); // no listings
    await db.insert(gameSteamListings).values([
      {
        userId: userA.id,
        gameId: g1.id,
        appId: 100,
        label: "G1-Main",
        releaseDate: "2025-05-01",
      },
      {
        userId: userA.id,
        gameId: g2.id,
        appId: 200,
        label: "G2-Demo",
        releaseDate: null,
      },
    ]);
    const map = await deriveReleaseInfoForGames(userA.id, [g1.id, g2.id, g3.id]);
    expect(map.get(g1.id)).toEqual({ releaseDate: "2025-05-01", releaseTba: false });
    expect(map.get(g2.id)).toEqual({ releaseDate: null, releaseTba: true });
    // G3 has no listings → not in the map at all. Loader maps to {null,false}.
    expect(map.has(g3.id)).toBe(false);
  });

  it("tenant scope: another user's listings DO NOT leak into the derivation", async () => {
    const userA = await seedUserDirectly({ email: "rd-ct-a@test.local" });
    const userB = await seedUserDirectly({ email: "rd-ct-b@test.local" });
    const aGame = await createGame(userA.id, { title: "A's game" }, "127.0.0.1");
    // Insert a listing under userA's game. Then probe as userB.
    await db.insert(gameSteamListings).values({
      userId: userA.id,
      gameId: aGame.id,
      appId: 999,
      label: "Main",
      releaseDate: "2026-01-01",
    });
    // userB asks for aGame's release info — tenant scope filters the
    // listings query so userB sees nothing.
    const map = await deriveReleaseInfoForGames(userB.id, [aGame.id]);
    expect(map.has(aGame.id)).toBe(false);
  });

  it("empty input returns an empty map (no query issued)", async () => {
    const userA = await seedUserDirectly({ email: "rd-empty-input@test.local" });
    const map = await deriveReleaseInfoForGames(userA.id, []);
    expect(map.size).toBe(0);
  });
});

// hardDeleteGame — permanent removal of soft-deleted game + cascaded children.
describe("hardDeleteGame — permanent delete of soft-deleted games", () => {
  it("soft-delete then hard-delete removes the game row from the DB", async () => {
    const userA = await seedUserDirectly({ email: "hd-game-1@test.local" });
    const game = await createGame(userA.id, { title: "Hard Del Game" }, "127.0.0.1");
    await softDeleteGame(userA.id, game.id, "127.0.0.1");

    await hardDeleteGame(userA.id, game.id, "127.0.0.1");

    const rows = await db.select().from(games).where(eq(games.id, game.id));
    expect(rows).toHaveLength(0);
  });

  it("hard-delete on a NON-soft-deleted game throws NotFoundError", async () => {
    const userA = await seedUserDirectly({ email: "hd-game-2@test.local" });
    const game = await createGame(userA.id, { title: "Live Game" }, "127.0.0.1");

    await expect(hardDeleteGame(userA.id, game.id, "127.0.0.1")).rejects.toBeInstanceOf(
      NotFoundError,
    );

    // Row is still in the DB.
    const rows = await db.select().from(games).where(eq(games.id, game.id));
    expect(rows).toHaveLength(1);
  });

  it("cross-tenant hard-delete throws NotFoundError (404, never 403)", async () => {
    const userA = await seedUserDirectly({ email: "hd-game-3a@test.local" });
    const userB = await seedUserDirectly({ email: "hd-game-3b@test.local" });
    const game = await createGame(userA.id, { title: "XT Game" }, "127.0.0.1");
    await softDeleteGame(userA.id, game.id, "127.0.0.1");

    const err = await hardDeleteGame(userB.id, game.id, "127.0.0.1").catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe("not_found");
    expect(err.status).toBe(404);
    expect(err.message).not.toMatch(/forbidden|permission/i);

    // Row is still intact for userA.
    const rows = await db.select().from(games).where(eq(games.id, game.id));
    expect(rows).toHaveLength(1);
  });

  it("hard-delete writes audit row game.delete_forever", async () => {
    const userA = await seedUserDirectly({ email: "hd-game-4@test.local" });
    const game = await createGame(userA.id, { title: "Audit Del Game" }, "127.0.0.1");
    await softDeleteGame(userA.id, game.id, "127.0.0.1");

    await hardDeleteGame(userA.id, game.id, "127.0.0.1");

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, userA.id), eq(auditLog.action, "game.delete_forever")));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({ gameId: game.id });
  });

  it("hard-delete game with attached listings cascades (listings also removed)", async () => {
    const userA = await seedUserDirectly({ email: "hd-game-5@test.local" });
    const game = await createGame(userA.id, { title: "Cascade Game" }, "127.0.0.1");

    // Attach a Steam listing to the game.
    await db.insert(gameSteamListings).values({
      userId: userA.id,
      gameId: game.id,
      appId: 9001,
      label: "Cascade Test",
    });

    const listingsBefore = await db
      .select()
      .from(gameSteamListings)
      .where(eq(gameSteamListings.gameId, game.id));
    expect(listingsBefore).toHaveLength(1);

    await softDeleteGame(userA.id, game.id, "127.0.0.1");
    await hardDeleteGame(userA.id, game.id, "127.0.0.1");

    // Game row gone.
    const gameRows = await db.select().from(games).where(eq(games.id, game.id));
    expect(gameRows).toHaveLength(0);

    // Listing rows also gone (hard-delete cascades to children).
    const listingsAfter = await db
      .select()
      .from(gameSteamListings)
      .where(eq(gameSteamListings.gameId, game.id));
    expect(listingsAfter).toHaveLength(0);
  });
});
