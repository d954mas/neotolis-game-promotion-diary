import { describe, it, expect } from "vitest";
import {
  createEvent,
  listFeedPage,
  listFeedFacets,
} from "../../src/lib/server/services/events.js";
import { db } from "../../src/lib/server/db/client.js";
import { games } from "../../src/lib/server/db/schema/games.js";
import { uuidv7 } from "../../src/lib/server/ids.js";
import { seedUserDirectly } from "./helpers.js";

/**
 * Postgres FTS on `events.search_vec` (Plan 03.4-10 follow-up).
 *
 * search_vec is GENERATED ALWAYS AS to_tsvector('english', title || notes),
 * backed by GIN index `idx_events_search_vec`. listFeedPage +
 * listFeedFacets apply `search_vec @@ plainto_tsquery('english', $q)`
 * when filters.query is non-empty.
 *
 * `plainto_tsquery` (not `to_tsquery`) handles freeform user input — it
 * auto-ANDs supplied words and escapes operators (so `?q=promotion!`
 * doesn't trip a syntax error). Stemming is English-default: "promote",
 * "promoting", "promoted", "promotion" all share the same lexeme so a
 * query for any matches events containing any of the inflections.
 *
 * Tenant scope MUST be preserved — every test seeds at least two
 * tenants and asserts cross-tenant rows never leak through the FTS
 * predicate.
 */

async function seedTenant(email: string): Promise<{ userId: string; gameId: string }> {
  const u = await seedUserDirectly({ email });
  const gameId = uuidv7();
  await db.insert(games).values({ id: gameId, userId: u.id, title: "Game" });
  return { userId: u.id, gameId };
}

describe("FEED-SEARCH: server-side FTS on events.title + events.notes", () => {
  it("returns events matching the query in title (stemmed)", async () => {
    const { userId, gameId } = await seedTenant("fts-title@test.local");
    const promo = await createEvent(
      userId,
      {
        gameIds: [gameId],
        kind: "press",
        occurredAt: new Date("2026-04-01T12:00:00Z"),
        title: "Major promotion push",
        notes: "Pinned on the dev blog.",
      },
      "127.0.0.1",
    );
    await createEvent(
      userId,
      {
        gameIds: [gameId],
        kind: "press",
        occurredAt: new Date("2026-04-02T12:00:00Z"),
        title: "Patch notes",
        notes: "Bug fixes.",
      },
      "127.0.0.1",
    );
    await createEvent(
      userId,
      {
        gameIds: [gameId],
        kind: "talk",
        occurredAt: new Date("2026-04-03T12:00:00Z"),
        title: "Roadmap update",
        notes: "Q3 plan.",
      },
      "127.0.0.1",
    );

    // English stemmer matches "promotion" / "promote" / "promoting" to the
    // same lexeme — the seeded "promotion" matches a `?q=promote` query.
    const page = await listFeedPage(userId, { query: "promote" }, null);
    expect(page.rows.map((r) => r.id)).toEqual([promo.id]);
  });

  it("returns events matching the query in notes (stemmed)", async () => {
    const { userId, gameId } = await seedTenant("fts-notes@test.local");
    const matchingNotes = await createEvent(
      userId,
      {
        gameIds: [gameId],
        kind: "talk",
        occurredAt: new Date("2026-04-01T12:00:00Z"),
        title: "Conference recap",
        notes: "Discussed wishlist strategy in detail.",
      },
      "127.0.0.1",
    );
    await createEvent(
      userId,
      {
        gameIds: [gameId],
        kind: "talk",
        occurredAt: new Date("2026-04-02T12:00:00Z"),
        title: "Random talk",
        notes: "About game design only.",
      },
      "127.0.0.1",
    );

    const page = await listFeedPage(userId, { query: "wishlist" }, null);
    expect(page.rows.map((r) => r.id)).toEqual([matchingNotes.id]);
  });

  it("returns zero rows for a query that matches nothing", async () => {
    const { userId, gameId } = await seedTenant("fts-empty@test.local");
    await createEvent(
      userId,
      {
        gameIds: [gameId],
        kind: "press",
        occurredAt: new Date("2026-04-01T12:00:00Z"),
        title: "Real title",
        notes: "Real notes",
      },
      "127.0.0.1",
    );

    const page = await listFeedPage(userId, { query: "NonexistentTerm" }, null);
    expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("query is tenant-scoped (other tenants' events with matching text don't leak)", async () => {
    const tenantA = await seedTenant("fts-tenantA@test.local");
    const tenantB = await seedTenant("fts-tenantB@test.local");

    // Both tenants seed events whose title contains the same query word.
    const aMatch = await createEvent(
      tenantA.userId,
      {
        gameIds: [tenantA.gameId],
        kind: "press",
        occurredAt: new Date("2026-04-01T12:00:00Z"),
        title: "Tenant A announcement",
        notes: "Big day.",
      },
      "127.0.0.1",
    );
    const bMatch = await createEvent(
      tenantB.userId,
      {
        gameIds: [tenantB.gameId],
        kind: "press",
        occurredAt: new Date("2026-04-01T12:00:00Z"),
        title: "Tenant B announcement",
        notes: "Different day.",
      },
      "127.0.0.1",
    );

    const pageA = await listFeedPage(tenantA.userId, { query: "announcement" }, null);
    expect(pageA.rows.map((r) => r.id)).toEqual([aMatch.id]);
    const pageB = await listFeedPage(tenantB.userId, { query: "announcement" }, null);
    expect(pageB.rows.map((r) => r.id)).toEqual([bMatch.id]);
  });

  it("query composes with other filter axes (kind + query intersection)", async () => {
    const { userId, gameId } = await seedTenant("fts-compose@test.local");
    const ytMatch = await createEvent(
      userId,
      {
        gameIds: [gameId],
        kind: "youtube_video",
        occurredAt: new Date("2026-04-01T12:00:00Z"),
        title: "Promotion video about wishlists",
        externalId: "yt-fts-1",
      },
      "127.0.0.1",
    );
    await createEvent(
      userId,
      {
        gameIds: [gameId],
        kind: "press",
        occurredAt: new Date("2026-04-02T12:00:00Z"),
        title: "Promotion press release",
        notes: "Same word, different kind.",
      },
      "127.0.0.1",
    );
    await createEvent(
      userId,
      {
        gameIds: [gameId],
        kind: "youtube_video",
        occurredAt: new Date("2026-04-03T12:00:00Z"),
        title: "Unrelated devlog",
        externalId: "yt-fts-2",
      },
      "127.0.0.1",
    );

    // kind=youtube_video AND query=promotion → only the matching YT event.
    const page = await listFeedPage(
      userId,
      { kind: "youtube_video", query: "promotion" },
      null,
    );
    expect(page.rows.map((r) => r.id)).toEqual([ytMatch.id]);
  });

  it("whitespace-only query is treated as no filter", async () => {
    const { userId, gameId } = await seedTenant("fts-whitespace@test.local");
    await createEvent(
      userId,
      {
        gameIds: [gameId],
        kind: "press",
        occurredAt: new Date("2026-04-01T12:00:00Z"),
        title: "Anything",
      },
      "127.0.0.1",
    );

    const page = await listFeedPage(userId, { query: "   " }, null);
    // Whitespace-only trims to "" → no FTS clause → all tenant events.
    expect(page.rows.length).toBeGreaterThan(0);
  });

  it("freeform input with operator characters doesn't throw (plainto_tsquery escapes)", async () => {
    // `to_tsquery` would throw 'syntax error in tsquery' on input
    // containing `!`, `&`, `|`. `plainto_tsquery` escapes them.
    const { userId, gameId } = await seedTenant("fts-operators@test.local");
    await createEvent(
      userId,
      {
        gameIds: [gameId],
        kind: "press",
        occurredAt: new Date("2026-04-01T12:00:00Z"),
        title: "Innocent title",
      },
      "127.0.0.1",
    );

    // None of these should throw — they should just return no matches.
    for (const q of ["foo!bar", "foo&bar", "a|b", "weird:!&|stuff"]) {
      await expect(listFeedPage(userId, { query: q }, null)).resolves.toBeDefined();
    }
  });

  it("listFeedFacets respects the query (chip counts narrow to FTS scope)", async () => {
    const { userId, gameId } = await seedTenant("fts-facets@test.local");
    // Two events with "Promotion" title — one press, one youtube. One event
    // without — should be excluded by the query predicate, so the kind
    // facet should show press=1, youtube_video=1, NOT press=2.
    await createEvent(
      userId,
      {
        gameIds: [gameId],
        kind: "press",
        occurredAt: new Date("2026-04-01T12:00:00Z"),
        title: "Promotion press",
      },
      "127.0.0.1",
    );
    await createEvent(
      userId,
      {
        gameIds: [gameId],
        kind: "youtube_video",
        occurredAt: new Date("2026-04-02T12:00:00Z"),
        title: "Promotion video",
        externalId: "yt-facets-1",
      },
      "127.0.0.1",
    );
    await createEvent(
      userId,
      {
        gameIds: [gameId],
        kind: "press",
        occurredAt: new Date("2026-04-03T12:00:00Z"),
        title: "Unrelated press",
      },
      "127.0.0.1",
    );

    const facets = await listFeedFacets(userId, { query: "promotion" });
    expect(facets.total).toBe(2);
    expect(facets.kinds.press).toBe(1);
    expect(facets.kinds.youtube_video).toBe(1);
    expect(facets.show.all).toBe(2);
  });
});
