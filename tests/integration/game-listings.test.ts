import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { createGame } from "../../src/lib/server/services/games.js";
import { seedUserDirectly } from "./helpers.js";

// Plan 02.1-25 round-3 dev/test-DB conflation: tests/setup.ts truncates
// `neotolis_test`, but runMigrations() reads env.DATABASE_URL which points
// at `neotolis` (the dev DB). Tests run against the dev DB, so a fixed
// email collides across re-runs. Random suffix keeps emails unique per
// invocation without changing the test-harness wiring (deferred).
const sfx = (): string => randomBytes(4).toString("hex");

/**
 * Plan 02-04 — GAMES-04a integration tests for `youtube-channels` were
 * retired in Plan 02.1-01 baseline collapse (the per-platform table was
 * dropped in favor of `data_sources`). The original Phase 2 attach tests
 * lived in this file; their service imports are gone post-2.1, so the
 * file now hosts the Plan 02.1-25 round-3 closure for Steam listing
 * `name` persistence. Cross-tenant ownership of Steam listings stays
 * exercised in `tests/integration/games.test.ts` and the cross-tenant
 * matrix in `tests/integration/tenant-scope.test.ts`.
 */

// Plan 02.1-25 — Steam listing `name` persistence.
//
// Round-3 UAT §3.3-polish: user wants the game's Steam name visible on
// /games/[id] (not just `App {id}`) plus an "Open on Steam" link. This
// test covers the data layer: addSteamListing populates the new `name`
// column from the Steam appdetails fetch; toGameSteamListingDto projects
// it; on Steam-down the column stays NULL (UI fallback to "App {id}"
// renders correctly via SteamListingRow).
//
// We mock fetchSteamAppDetails via vi.mock so the test does not call the
// public Steam endpoint (deterministic + no rate-limit risk).
vi.mock("../../src/lib/server/integrations/steam-api.js", () => ({
  fetchSteamAppDetails: vi.fn(),
}));

// Re-import after the mock is registered.
const { addSteamListing, listListings } = await import(
  "../../src/lib/server/services/game-steam-listings.js"
);
const { toGameSteamListingDto } = await import("../../src/lib/server/dto.js");
const { fetchSteamAppDetails } = await import(
  "../../src/lib/server/integrations/steam-api.js"
);

describe("Plan 02.1-25 — Steam listing name persistence", () => {
  beforeEach(() => {
    vi.mocked(fetchSteamAppDetails).mockReset();
  });

  afterEach(() => {
    vi.mocked(fetchSteamAppDetails).mockReset();
  });

  it("addSteamListing persists Steam name when fetchSteamAppDetails returns success", async () => {
    vi.mocked(fetchSteamAppDetails).mockResolvedValueOnce({
      appId: 620,
      name: "Portal 2",
      coverUrl: "https://shared.akamai.steamstatic.com/.../header.jpg",
      releaseDate: "Apr 19, 2011",
      comingSoon: false,
      genres: ["Action", "Adventure"],
      categories: ["Single-player", "Multi-player"],
      raw: { name: "Portal 2" },
    });

    const userA = await seedUserDirectly({ email: `p25-a-${sfx()}@test.local` });
    const game = await createGame(userA.id, { title: "Hosted" }, "127.0.0.1");

    const row = await addSteamListing(userA.id, { gameId: game.id, appId: 620 }, "127.0.0.1");

    expect(row.name).toBe("Portal 2");

    const dto = toGameSteamListingDto(row);
    expect(dto.name).toBe("Portal 2");
    // P3 discipline: userId never crosses the projection boundary.
    expect(dto).not.toHaveProperty("userId");
  });

  it("addSteamListing leaves name NULL when fetchSteamAppDetails returns null (Steam down)", async () => {
    vi.mocked(fetchSteamAppDetails).mockResolvedValueOnce(null);

    const userA = await seedUserDirectly({ email: `p25-b-${sfx()}@test.local` });
    const game = await createGame(userA.id, { title: "Steam-down case" }, "127.0.0.1");

    const row = await addSteamListing(
      userA.id,
      { gameId: game.id, appId: 99999 },
      "127.0.0.1",
    );

    expect(row.name).toBeNull();
    expect(row.coverUrl).toBeNull();
    expect(row.comingSoon).toBe("unavailable");

    const dto = toGameSteamListingDto(row);
    expect(dto.name).toBeNull();
  });

  it("listListings returns name for both populated and NULL rows (mixed-state forward-compat)", async () => {
    vi.mocked(fetchSteamAppDetails)
      .mockResolvedValueOnce({
        appId: 1145360,
        name: "HADES",
        coverUrl: "https://shared.akamai.steamstatic.com/header_hades.jpg",
        releaseDate: "Sep 17, 2020",
        comingSoon: false,
        genres: [],
        categories: [],
        raw: {},
      })
      .mockResolvedValueOnce(null);

    const userA = await seedUserDirectly({ email: `p25-c-${sfx()}@test.local` });
    const game = await createGame(userA.id, { title: "Mixed" }, "127.0.0.1");

    await addSteamListing(userA.id, { gameId: game.id, appId: 1145360 }, "127.0.0.1");
    await addSteamListing(userA.id, { gameId: game.id, appId: 31337 }, "127.0.0.1");

    const rows = await listListings(userA.id, game.id);
    const dtos = rows.map((r) => toGameSteamListingDto(r));
    const byApp = new Map(dtos.map((d) => [d.appId, d]));

    expect(byApp.get(1145360)?.name).toBe("HADES");
    expect(byApp.get(31337)?.name).toBeNull();
  });
});
