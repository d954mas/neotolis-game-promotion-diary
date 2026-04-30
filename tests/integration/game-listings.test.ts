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

  // Plan 02.1-39 round-6 polish #12 (UAT-NOTES.md §5.8 follow-up #12,
  // 2026-04-30): per-game listing restore endpoint. New surface:
  //   POST /api/games/:gameId/listings/:listingId/restore
  // Cross-tenant access on either gameId or listingId returns 404, never
  // 403 (AGENTS.md item 2 — tenant-scope invariant). Body must NOT
  // contain "forbidden" / "permission" for tenant-owned resources.
  it("Plan 02.1-39 #12: cross-tenant POST /api/games/:gameId/listings/:listingId/restore → 404", async () => {
    vi.mocked(fetchSteamAppDetails).mockResolvedValue(null);

    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const userA = await seedUserDirectly({ email: `p39-12a-${sfx()}@test.local` });
    const userB = await seedUserDirectly({ email: `p39-12b-${sfx()}@test.local` });
    const gameA = await createGame(userA.id, { title: "A's game" }, "127.0.0.1");
    const listing = await addSteamListing(
      userA.id,
      { gameId: gameA.id, appId: 730 },
      "127.0.0.1",
    );

    // userA soft-deletes the listing first (so a row is restorable).
    await db
      .update(gameSteamListings)
      .set({ deletedAt: new Date() })
      .where(eq(gameSteamListings.id, listing.id));

    // userB POSTing against userA's restore endpoint returns 404 — no
    // discrimination between "doesn't exist" and "exists but yours not".
    const res = await app.request(
      `/api/games/${gameA.id}/listings/${listing.id}/restore`,
      {
        method: "POST",
        headers: { cookie: `neotolis.session_token=${userB.signedSessionCookieValue}` },
      },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("not_found");
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toMatch(/forbidden|permission/i);

    // Verify userA's listing is still soft-deleted (NOT restored by the
    // failed cross-tenant call).
    const [stillDeleted] = await db
      .select()
      .from(gameSteamListings)
      .where(
        and(
          eq(gameSteamListings.userId, userA.id),
          eq(gameSteamListings.id, listing.id),
        ),
      );
    expect(stillDeleted).toBeDefined();
    expect(stillDeleted?.deletedAt).not.toBeNull();
  });

  it("Plan 02.1-39 #12: same-tenant POST /listings/:listingId/restore on already-active row → 404", async () => {
    vi.mocked(fetchSteamAppDetails).mockResolvedValue(null);

    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const userA = await seedUserDirectly({ email: `p39-12c-${sfx()}@test.local` });
    const game = await createGame(userA.id, { title: "Hosted" }, "127.0.0.1");
    const listing = await addSteamListing(
      userA.id,
      { gameId: game.id, appId: 730 },
      "127.0.0.1",
    );

    // Listing is active (not soft-deleted) — restore must throw NotFoundError
    // (programming error: the UI should not surface this case).
    const res = await app.request(
      `/api/games/${game.id}/listings/${listing.id}/restore`,
      {
        method: "POST",
        headers: { cookie: `neotolis.session_token=${userA.signedSessionCookieValue}` },
      },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("not_found");
  });

  it("Plan 02.1-39 #12: same-tenant POST /listings/:listingId/restore on soft-deleted row → 200 + active DTO", async () => {
    vi.mocked(fetchSteamAppDetails).mockResolvedValue({
      appId: 730,
      name: "Counter-Strike 2",
      coverUrl: null,
      releaseDate: null,
      comingSoon: false,
      genres: [],
      categories: [],
      raw: {},
    });

    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const userA = await seedUserDirectly({ email: `p39-12d-${sfx()}@test.local` });
    const game = await createGame(userA.id, { title: "Hosted" }, "127.0.0.1");
    const listing = await addSteamListing(
      userA.id,
      { gameId: game.id, appId: 730 },
      "127.0.0.1",
    );

    // Soft-delete via the existing DELETE endpoint flow (sets deletedAt).
    await db
      .update(gameSteamListings)
      .set({ deletedAt: new Date() })
      .where(eq(gameSteamListings.id, listing.id));

    const res = await app.request(
      `/api/games/${game.id}/listings/${listing.id}/restore`,
      {
        method: "POST",
        headers: { cookie: `neotolis.session_token=${userA.signedSessionCookieValue}` },
      },
    );
    expect(res.status).toBe(200);
    const dto = (await res.json()) as Record<string, unknown>;
    expect(dto.id).toBe(listing.id);
    expect(dto.deletedAt).toBeNull();
    // P3 discipline: userId is stripped at the projection layer.
    expect(dto).not.toHaveProperty("userId");
  });

  // Plan 02.1-39 round-6 polish #14c (UAT-NOTES.md §5.8 follow-up #14,
  // 2026-04-30): per-listing label edit. User during round-6 UAT:
  //   "При редактировании стора, я бы хотел иметь возможноть поменять label"
  // Today only `label` is mutable (the rest of §5.3 item B remains a
  // Phase 6 deferred). New service updateListing + PATCH route
  // /api/games/:gameId/listings/:listingId. Cross-tenant 404 invariant
  // exercised; same-tenant happy-path round-trips; route accepts {label}
  // and rejects {label: <too long>} at the Zod boundary.
  describe("Plan 02.1-39 round-6 polish #14c — per-listing label edit", () => {
    it("updateListing service round-trips label and the DTO projects the new value", async () => {
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
      const { updateListing } = await import(
        "../../src/lib/server/services/game-steam-listings.js"
      );
      const userA = await seedUserDirectly({ email: `p14c-rt-${sfx()}@test.local` });
      const game = await createGame(userA.id, { title: "Label RT" }, "127.0.0.1");
      const listing = await addSteamListing(
        userA.id,
        { gameId: game.id, appId: 620, label: "Demo" },
        "127.0.0.1",
      );
      expect(listing.label).toBe("Demo");
      const updated = await updateListing(userA.id, game.id, listing.id, {
        label: "Full",
      });
      expect(updated.label).toBe("Full");
      // userId stripped at the DTO boundary.
      const dto = toGameSteamListingDto(updated);
      expect(dto.label).toBe("Full");
      expect(dto).not.toHaveProperty("userId");
    });

    it("updateListing — cross-tenant gameId/listingId surfaces NotFoundError (404, not 403)", async () => {
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
      const { updateListing } = await import(
        "../../src/lib/server/services/game-steam-listings.js"
      );
      const { NotFoundError } = await import(
        "../../src/lib/server/services/errors.js"
      );
      const userA = await seedUserDirectly({ email: `p14c-ct-a-${sfx()}@test.local` });
      const userB = await seedUserDirectly({ email: `p14c-ct-b-${sfx()}@test.local` });
      const aGame = await createGame(userA.id, { title: "A's" }, "127.0.0.1");
      const aListing = await addSteamListing(
        userA.id,
        { gameId: aGame.id, appId: 620, label: "Original" },
        "127.0.0.1",
      );
      // User B writes to A's listing → NotFoundError (PRIV-01).
      await expect(
        updateListing(userB.id, aGame.id, aListing.id, { label: "leak" }),
      ).rejects.toBeInstanceOf(NotFoundError);
      // The original label is unchanged.
      const [unchanged] = await db
        .select()
        .from(gameSteamListings)
        .where(eq(gameSteamListings.id, aListing.id));
      expect(unchanged?.label).toBe("Original");
    });

    it("updateListing — soft-deleted row returns NotFoundError (must restore first)", async () => {
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
      const { updateListing } = await import(
        "../../src/lib/server/services/game-steam-listings.js"
      );
      const { NotFoundError } = await import(
        "../../src/lib/server/services/errors.js"
      );
      const userA = await seedUserDirectly({ email: `p14c-sd-${sfx()}@test.local` });
      const game = await createGame(userA.id, { title: "SD" }, "127.0.0.1");
      const listing = await addSteamListing(
        userA.id,
        { gameId: game.id, appId: 620 },
        "127.0.0.1",
      );
      await db
        .update(gameSteamListings)
        .set({ deletedAt: new Date() })
        .where(eq(gameSteamListings.id, listing.id));
      await expect(
        updateListing(userA.id, game.id, listing.id, { label: "should-fail" }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("PATCH /api/games/:gameId/listings/:listingId — happy path returns updated DTO", async () => {
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
      const userA = await seedUserDirectly({ email: `p14c-http-${sfx()}@test.local` });
      const game = await createGame(userA.id, { title: "HTTP" }, "127.0.0.1");
      const listing = await addSteamListing(
        userA.id,
        { gameId: game.id, appId: 620, label: "Old" },
        "127.0.0.1",
      );
      const cookie = `neotolis.session_token=${userA.signedSessionCookieValue}`;
      const res = await app.request(
        `/api/games/${game.id}/listings/${listing.id}`,
        {
          method: "PATCH",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ label: "New" }),
        },
      );
      expect(res.status).toBe(200);
      const dto = (await res.json()) as Record<string, unknown>;
      expect(dto.id).toBe(listing.id);
      expect(dto.label).toBe("New");
      expect(dto).not.toHaveProperty("userId");
    });

    it("PATCH /api/games/:gameId/listings/:listingId — cross-tenant returns 404 with no forbidden|permission body leak", async () => {
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
      const userA = await seedUserDirectly({ email: `p14c-ct-a2-${sfx()}@test.local` });
      const userB = await seedUserDirectly({ email: `p14c-ct-b2-${sfx()}@test.local` });
      const aGame = await createGame(userA.id, { title: "A" }, "127.0.0.1");
      const aListing = await addSteamListing(
        userA.id,
        { gameId: aGame.id, appId: 620 },
        "127.0.0.1",
      );
      const cookieB = `neotolis.session_token=${userB.signedSessionCookieValue}`;
      const res = await app.request(
        `/api/games/${aGame.id}/listings/${aListing.id}`,
        {
          method: "PATCH",
          headers: { cookie: cookieB, "content-type": "application/json" },
          body: JSON.stringify({ label: "intrusion" }),
        },
      );
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).not.toMatch(/forbidden/i);
      expect(body).not.toMatch(/permission/i);
    });

    it("PATCH /api/games/:gameId/listings/:listingId — Zod rejects label > 100 chars at the boundary", async () => {
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
      const userA = await seedUserDirectly({ email: `p14c-cap-${sfx()}@test.local` });
      const game = await createGame(userA.id, { title: "Cap" }, "127.0.0.1");
      const listing = await addSteamListing(
        userA.id,
        { gameId: game.id, appId: 620 },
        "127.0.0.1",
      );
      const cookie = `neotolis.session_token=${userA.signedSessionCookieValue}`;
      const tooLong = "x".repeat(101);
      const res = await app.request(
        `/api/games/${game.id}/listings/${listing.id}`,
        {
          method: "PATCH",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ label: tooLong }),
        },
      );
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("validation_failed");
    });
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
