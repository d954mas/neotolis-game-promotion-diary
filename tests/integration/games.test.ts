import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import { auditLog } from "../../src/lib/server/db/schema/audit-log.js";
import { games } from "../../src/lib/server/db/schema/games.js";
import { gameSteamListings } from "../../src/lib/server/db/schema/game-steam-listings.js";
// Plan 02.1-28 (Rule 3 — Blocking): the gameYoutubeChannels / youtubeChannels /
// trackedYoutubeVideos imports below were retired in Plan 02.1-01 baseline
// schema collapse. The Phase 2 02-04 GAMES-02 cascade test referenced them
// directly; we skip the stale subtest below (preserves the trail) and remove
// the imports here so this test file compiles. The Plan 02.1-28 events
// cascade is REMOVED entirely (events are M:N now); the per-listing cascade
// continues to work via gameSteamListings (covered by the restore subtest).
import {
  createGame,
  softDeleteGame,
  restoreGame,
  getGameById,
  getGameByIdIncludingDeleted,
} from "../../src/lib/server/services/games.js";
import { seedUserDirectly } from "./helpers.js";
import { AppError, NotFoundError } from "../../src/lib/server/services/errors.js";

/**
 * Plan 02-04 — GAMES-01 + GAMES-02 live integration tests.
 *
 * The placeholder it.skip stubs from Plan 02-01 are replaced with `it(...)`
 * bodies here. Names match exactly so Wave 0 traceability holds: each
 * placeholder belongs to one implementing plan, and each implementing plan
 * fills in the body with no new it() calls.
 */
describe("games CRUD (GAMES-01, GAMES-02)", () => {
  it("02-04: GAMES-01 create game returns 201 + DTO", async () => {
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
      (a) => a.action === "game.created" && (a.metadata as { gameId?: string } | null)?.gameId === game.id,
    );
    expect(createdAudit).toBeDefined();
  });

  it("02-04: GAMES-01 422 on missing title", async () => {
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

  // Plan 02.1-28 (Rule 3 — Blocking): the original Phase 2 cascade test
  // referenced gameYoutubeChannels / youtubeChannels / trackedYoutubeVideos
  // schemas that Plan 02.1-01 retired; this stale subtest has been broken
  // since Plan 02.1-01 baseline collapse. Plan 02.1-28 also removes the
  // events cascade in softDeleteGame (M:N relations can't cleanly map a
  // game's soft-delete to "delete events whose gameId = this"). The
  // gameSteamListings cascade behavior is covered by the GAMES-02 restore
  // subtest below. Marked it.skip to preserve the Wave 0 trail.
  it.skip("02-04: GAMES-02 soft cascade delete (superseded — see Plan 02.1-01 + 02.1-28; gameSteamListings cascade covered by restore subtest below)", async () => {
    // Body intentionally elided — the original test exercised the Phase 2
    // gameYoutubeChannels / youtubeChannels / trackedYoutubeVideos cascade
    // which has been retired by Plan 02.1-01 (baseline schema collapse) and
    // events.gameId by Plan 02.1-27 (M:N junction). The cascade now spans
    // gameSteamListings only (Plan 02.1-28 services/games.ts header doc);
    // that path is exercised by the GAMES-02 restore subtest below which
    // verifies the marker-timestamp design end-to-end.
  });

  it("02-04: GAMES-02 transactional restore", async () => {
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
        and(
          eq(gameSteamListings.userId, userA.id),
          eq(gameSteamListings.id, earlyListing!.id),
        ),
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
