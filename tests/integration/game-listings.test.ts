import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createGame } from "../../src/lib/server/services/games.js";
import { seedUserDirectly } from "./helpers.js";
import { db } from "../../src/lib/server/db/client.js";
import { gameSteamListings } from "../../src/lib/server/db/schema/game-steam-listings.js";
import { AppError } from "../../src/lib/server/services/errors.js";

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

// Plan 02.1-29 — addSteamListing duplicate translation (Path B).
//
// Closes UAT-NOTES.md §4.25.E (500 → 422 on duplicate appId), §4.25.G prep
// (existingGameId + existingState payload for Plan 30's actionable toast),
// and §4.25.H verification (cross-tenant DELETE returns 404; the route
// itself shipped in Plan 02-08 at routes/game-listings.ts lines 69-77).
//
// Path B = unconditional DB constraint `(game_id, app_id)` + defensive
// pre-INSERT lookup (no `isNull(deletedAt)` filter so soft-deleted dupes
// surface as `existingState='soft_deleted'` BEFORE the INSERT) + race-window
// catch around the INSERT translating 23505 to AppError 422 with
// `existingState='active'`.
//
// Note on schema preconditions: this block expects the post-Plan-02.1-27
// schema state — Plan 27 drops `game_steam_listings_user_app_id_unq`, so
// cross-game-allowed (Test 3 below) is only post-27 valid. Pre-27 the
// (user_id, app_id) constraint would 23505 the second add and fall through
// to `existingState='active'` via the catch path. Plan 27 must run before
// this test passes its cross-game assertion.
describe("Plan 02.1-29 — addSteamListing duplicate translation (Path B)", () => {
  beforeEach(() => {
    vi.mocked(fetchSteamAppDetails).mockReset();
  });

  afterEach(() => {
    vi.mocked(fetchSteamAppDetails).mockReset();
  });

  it("Test 1: same-game active duplicate → AppError 422 'steam_listing_duplicate' with existingState='active'", async () => {
    vi.mocked(fetchSteamAppDetails).mockResolvedValue({
      appId: 620,
      name: "Portal 2",
      coverUrl: null,
      releaseDate: null,
      comingSoon: false,
      genres: [],
      categories: [],
      raw: {},
    });

    const userA = await seedUserDirectly({ email: `p29-1-${sfx()}@test.local` });
    const game = await createGame(userA.id, { title: "Portal 2 main" }, "127.0.0.1");

    // First add succeeds.
    await addSteamListing(userA.id, { gameId: game.id, appId: 620 }, "127.0.0.1");

    // Second add throws AppError 422 with the full payload.
    let caught: unknown;
    try {
      await addSteamListing(userA.id, { gameId: game.id, appId: 620 }, "127.0.0.1");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    const err = caught as AppError;
    expect(err.code).toBe("steam_listing_duplicate");
    expect(err.status).toBe(422);
    expect(err.metadata).toMatchObject({
      gameId: game.id,
      appId: 620,
      existingGameId: game.id,
      existingState: "active",
    });
  });

  it("Test 2 (Path B): same-game soft-deleted duplicate → AppError 422 with existingState='soft_deleted' (pre-INSERT lookup catches it)", async () => {
    vi.mocked(fetchSteamAppDetails).mockResolvedValue({
      appId: 620,
      name: "Portal 2",
      coverUrl: null,
      releaseDate: null,
      comingSoon: false,
      genres: [],
      categories: [],
      raw: {},
    });

    const userA = await seedUserDirectly({ email: `p29-2-${sfx()}@test.local` });
    const game = await createGame(userA.id, { title: "Soft-delete cycle" }, "127.0.0.1");

    const first = await addSteamListing(
      userA.id,
      { gameId: game.id, appId: 620 },
      "127.0.0.1",
    );

    // Soft-delete the listing directly (mirrors removeSteamListing's UPDATE).
    await db
      .update(gameSteamListings)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(gameSteamListings.userId, userA.id),
          eq(gameSteamListings.id, first.id),
        ),
      );

    // Re-add same (gameId, appId): the pre-INSERT lookup MUST catch the
    // soft-deleted row (Path B contract — no isNull(deletedAt) filter).
    let caught: unknown;
    try {
      await addSteamListing(userA.id, { gameId: game.id, appId: 620 }, "127.0.0.1");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    const err = caught as AppError;
    expect(err.code).toBe("steam_listing_duplicate");
    expect(err.status).toBe(422);
    expect(err.metadata).toMatchObject({
      gameId: game.id,
      appId: 620,
      existingGameId: game.id,
      existingState: "soft_deleted",
    });
  });

  it("Test 3 (post-Plan-27): cross-game same-appId is ALLOWED (the user-scoped unique constraint is gone)", async () => {
    vi.mocked(fetchSteamAppDetails).mockResolvedValue({
      appId: 620,
      name: "Portal 2",
      coverUrl: null,
      releaseDate: null,
      comingSoon: false,
      genres: [],
      categories: [],
      raw: {},
    });

    const userA = await seedUserDirectly({ email: `p29-3-${sfx()}@test.local` });
    const gameA = await createGame(userA.id, { title: "Portal 2 main" }, "127.0.0.1");
    const gameB = await createGame(userA.id, { title: "Portal 2 review-notes" }, "127.0.0.1");

    // Both attaches succeed: same appId attached to two games of the same user.
    const r1 = await addSteamListing(userA.id, { gameId: gameA.id, appId: 620 }, "127.0.0.1");
    const r2 = await addSteamListing(userA.id, { gameId: gameB.id, appId: 620 }, "127.0.0.1");

    expect(r1.appId).toBe(620);
    expect(r2.appId).toBe(620);
    expect(r1.gameId).toBe(gameA.id);
    expect(r2.gameId).toBe(gameB.id);

    // Verify both rows are present in the DB.
    const rows = await db
      .select()
      .from(gameSteamListings)
      .where(
        and(
          eq(gameSteamListings.userId, userA.id),
          eq(gameSteamListings.appId, 620),
        ),
      );
    expect(rows).toHaveLength(2);
    const gameIds = rows.map((r) => r.gameId).sort();
    expect(gameIds).toEqual([gameA.id, gameB.id].sort());
  });

  it("Test 4: cross-tenant POST /api/games/:gameId/listings → 404 (clean body, no 'forbidden' / 'permission')", async () => {
    vi.mocked(fetchSteamAppDetails).mockResolvedValue(null);

    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const userA = await seedUserDirectly({ email: `p29-4a-${sfx()}@test.local` });
    const userB = await seedUserDirectly({ email: `p29-4b-${sfx()}@test.local` });
    const gameA = await createGame(userA.id, { title: "A's game" }, "127.0.0.1");

    // userB POSTing against userA's gameId returns 404.
    const res = await app.request(`/api/games/${gameA.id}/listings`, {
      method: "POST",
      headers: {
        cookie: `neotolis.session_token=${userB.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ appId: 620 }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("not_found");
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toMatch(/forbidden|permission/i);
  });

  it("Test 5 (§4.25.H test surface): cross-tenant DELETE /api/games/:gameId/listings/:listingId → 404", async () => {
    vi.mocked(fetchSteamAppDetails).mockResolvedValue(null);

    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const userA = await seedUserDirectly({ email: `p29-5a-${sfx()}@test.local` });
    const userB = await seedUserDirectly({ email: `p29-5b-${sfx()}@test.local` });
    const gameA = await createGame(userA.id, { title: "A's game" }, "127.0.0.1");
    const listing = await addSteamListing(
      userA.id,
      { gameId: gameA.id, appId: 730 },
      "127.0.0.1",
    );

    // userB DELETEing against userA's listingId returns 404.
    const res = await app.request(
      `/api/games/${gameA.id}/listings/${listing.id}`,
      {
        method: "DELETE",
        headers: { cookie: `neotolis.session_token=${userB.signedSessionCookieValue}` },
      },
    );
    expect(res.status).toBe(404);
    const bodyStr = await res.text();
    expect(bodyStr).not.toMatch(/forbidden|permission/i);

    // Verify userA's listing is unchanged (NOT soft-deleted by the failed cross-tenant call).
    const [stillThere] = await db
      .select()
      .from(gameSteamListings)
      .where(
        and(
          eq(gameSteamListings.userId, userA.id),
          eq(gameSteamListings.id, listing.id),
        ),
      );
    expect(stillThere).toBeDefined();
    expect(stillThere?.deletedAt).toBeNull();
  });

  it("Test 6 (mapErr metadata): HTTP 422 body includes the full metadata object (existingGameId, existingState, gameId, appId)", async () => {
    vi.mocked(fetchSteamAppDetails).mockResolvedValue({
      appId: 620,
      name: "Portal 2",
      coverUrl: null,
      releaseDate: null,
      comingSoon: false,
      genres: [],
      categories: [],
      raw: {},
    });

    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const userA = await seedUserDirectly({ email: `p29-6-${sfx()}@test.local` });
    const game = await createGame(userA.id, { title: "Hosted" }, "127.0.0.1");
    const cookie = `neotolis.session_token=${userA.signedSessionCookieValue}`;

    const r1 = await app.request(`/api/games/${game.id}/listings`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ appId: 620 }),
    });
    expect(r1.status).toBe(201);

    const r2 = await app.request(`/api/games/${game.id}/listings`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ appId: 620 }),
    });
    expect(r2.status).toBe(422);
    const body = (await r2.json()) as Record<string, unknown>;
    expect(body.error).toBe("steam_listing_duplicate");
    expect(body.metadata).toBeDefined();
    const metadata = body.metadata as Record<string, unknown>;
    expect(metadata.gameId).toBe(game.id);
    expect(metadata.appId).toBe(620);
    expect(metadata.existingGameId).toBe(game.id);
    expect(metadata.existingState).toBe("active");
  });
});
