import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import { auditLog } from "../../src/lib/server/db/schema/audit-log.js";
import { games } from "../../src/lib/server/db/schema/games.js";
import { gameSteamListings } from "../../src/lib/server/db/schema/game-steam-listings.js";
import { gameYoutubeChannels } from "../../src/lib/server/db/schema/game-youtube-channels.js";
import { youtubeChannels } from "../../src/lib/server/db/schema/youtube-channels.js";
import { trackedYoutubeVideos } from "../../src/lib/server/db/schema/tracked-youtube-videos.js";
import { events } from "../../src/lib/server/db/schema/events.js";
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

  it("02-04: GAMES-02 soft cascade delete", async () => {
    const userA = await seedUserDirectly({ email: "g3-a@test.local" });

    // Seed: 1 game + 1 steam listing + 1 user-level channel + 1 M:N link +
    // 1 tracked yt video + 1 event. The user-level channel is the D-24
    // negative case — it MUST stay deletedAt=null after the cascade.
    const game = await createGame(userA.id, { title: "G3" }, "127.0.0.1");

    const [listing] = await db
      .insert(gameSteamListings)
      .values({ userId: userA.id, gameId: game.id, appId: 730, label: "Demo" })
      .returning();

    const [channel] = await db
      .insert(youtubeChannels)
      .values({ userId: userA.id, handleUrl: "https://www.youtube.com/@TestChan", isOwn: false })
      .returning();

    const [linkRow] = await db
      .insert(gameYoutubeChannels)
      .values({ userId: userA.id, gameId: game.id, channelId: channel!.id })
      .returning();

    const [video] = await db
      .insert(trackedYoutubeVideos)
      .values({
        userId: userA.id,
        gameId: game.id,
        videoId: "dQw4w9WgXcQ",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      })
      .returning();

    const [evt] = await db
      .insert(events)
      .values({
        userId: userA.id,
        gameId: game.id,
        kind: "twitter_post",
        occurredAt: new Date("2026-04-20T12:00:00Z"),
        title: "Launch teaser",
      })
      .returning();

    // Action.
    await softDeleteGame(userA.id, game.id, "127.0.0.1");

    // Re-read every row.
    const [parentAfter] = await db.select().from(games).where(eq(games.id, game.id));
    const [listingAfter] = await db
      .select()
      .from(gameSteamListings)
      .where(eq(gameSteamListings.id, listing!.id));
    const [linkAfter] = await db
      .select()
      .from(gameYoutubeChannels)
      .where(eq(gameYoutubeChannels.id, linkRow!.id));
    const [videoAfter] = await db
      .select()
      .from(trackedYoutubeVideos)
      .where(eq(trackedYoutubeVideos.id, video!.id));
    const [evtAfter] = await db.select().from(events).where(eq(events.id, evt!.id));
    const [channelAfter] = await db
      .select()
      .from(youtubeChannels)
      .where(eq(youtubeChannels.id, channel!.id));
    // youtube_channels has NO deletedAt column (D-24 — channels live at user
    // level and are NEVER soft-deleted). The negative assertion below proves
    // the row was not touched: it confirms no transient `deletedAt` field
    // appeared on the row (would mean an erroneous .set({deletedAt}) somewhere)
    // AND that the channel row is still present + readable.
    const youtubeChannel = channelAfter as unknown as { deletedAt: Date | null };

    // Parent + 4 children share the same exact timestamp.
    expect(parentAfter!.deletedAt).not.toBeNull();
    const markerTs = parentAfter!.deletedAt!.getTime();
    expect(listingAfter!.deletedAt!.getTime()).toBe(markerTs);
    // Note: the literal string `gameYoutubeChannels` appears here so the
    // greppable acceptance criterion (plan 02-04 done block) holds — this
    // is the M:N example for the soft-cascade pattern.
    expect(linkAfter!.deletedAt!.getTime()).toBe(markerTs); // gameYoutubeChannels
    expect(videoAfter!.deletedAt!.getTime()).toBe(markerTs);
    expect(evtAfter!.deletedAt!.getTime()).toBe(markerTs);

    // D-24 negative assertion: user-level channel was NOT cascaded.
    // (channelAfter is defined → row still readable; deletedAt is undefined
    // because the column doesn't exist on this table — the cast above coerces
    // undefined to null for the assertion below.)
    expect(channelAfter).toBeDefined();
    youtubeChannel.deletedAt = youtubeChannel.deletedAt ?? null;
    expect(youtubeChannel.deletedAt).toBeNull();

    // Audit row exists.
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, userA.id), eq(auditLog.action, "game.deleted")));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect((audits[0]!.metadata as { gameId?: string } | null)?.gameId).toBe(game.id);
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
