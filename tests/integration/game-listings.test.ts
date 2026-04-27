import { describe, it, expect } from "vitest";
import { createGame } from "../../src/lib/server/services/games.js";
import {
  createChannel,
  attachToGame,
  listChannelsForGame,
} from "../../src/lib/server/services/youtube-channels.js";
import { seedUserDirectly } from "./helpers.js";
import { NotFoundError } from "../../src/lib/server/services/errors.js";

/**
 * Plan 02-04 — GAMES-04a live integration tests for the M:N attach
 * (game ↔ youtube-channels). Placeholder it.skip stubs from Plan 02-01
 * are flipped to `it(...)` here.
 */
describe("game ↔ youtube-channels link (GAMES-04a)", () => {
  it("02-04: GAMES-04a attach youtube channel", async () => {
    const userA = await seedUserDirectly({ email: "ch1-a@test.local" });
    const game = await createGame(userA.id, { title: "G1" }, "127.0.0.1");
    const channel = await createChannel(userA.id, {
      handleUrl: "https://www.youtube.com/@SoloDev",
      isOwn: true,
    });

    await attachToGame(userA.id, game.id, channel.id);

    const linked = await listChannelsForGame(userA.id, game.id);
    expect(linked).toHaveLength(1);
    expect(linked[0]!.id).toBe(channel.id);
    expect(linked[0]!.handleUrl).toBe("https://www.youtube.com/@SoloDev");
    expect(linked[0]!.isOwn).toBe(true);
  });

  it("02-04: GAMES-04a multiple channels per game (M:N)", async () => {
    const userA = await seedUserDirectly({ email: "ch2-a@test.local" });
    const game = await createGame(userA.id, { title: "G2" }, "127.0.0.1");
    const c1 = await createChannel(userA.id, { handleUrl: "https://www.youtube.com/@A" });
    const c2 = await createChannel(userA.id, { handleUrl: "https://www.youtube.com/@B" });

    await attachToGame(userA.id, game.id, c1.id);
    await attachToGame(userA.id, game.id, c2.id);

    const all = await listChannelsForGame(userA.id, game.id);
    expect(all.map((c) => c.id).sort()).toEqual([c1.id, c2.id].sort());

    // Third attach with the same channel — UNIQUE(game_id, channel_id) rejects.
    await expect(attachToGame(userA.id, game.id, c1.id)).rejects.toThrow(/unique|duplicate/i);
  });

  it("02-04: cross-tenant attachToGame returns NotFoundError (404, not 403)", async () => {
    const userA = await seedUserDirectly({ email: "ct-list-a@test.local" });
    const userB = await seedUserDirectly({ email: "ct-list-b@test.local" });
    const aGame = await createGame(userA.id, { title: "A's Game" }, "127.0.0.1");
    const bChannel = await createChannel(userB.id, {
      handleUrl: "https://www.youtube.com/@BBlogger",
    });

    // user B trying to attach their own channel to user A's game → NotFoundError on game lookup.
    await expect(attachToGame(userB.id, aGame.id, bChannel.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    // user A trying to attach user B's channel to user A's game → NotFoundError on channel lookup.
    await expect(attachToGame(userA.id, aGame.id, bChannel.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
