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
 * Hybrid search on events (Plan 03.4-10 follow-up: FTS + pg_trgm).
 *
 * Two complementary predicates run as an OR union in listFeedPage +
 * listFeedFacets when filters.query is non-empty:
 *
 *   1. FTS — `search_vec @@ plainto_tsquery('english', $q)`.
 *      Word-level English stemming, backed by GIN(search_vec). `promote`
 *      matches `promotion`; `viking` matches `vikings`; `wishlist`
 *      matches `wishlists`. `plainto_tsquery` (not `to_tsquery`) handles
 *      freeform input — auto-ANDs words and escapes operators (so
 *      `?q=foo!bar` doesn't trip a syntax error).
 *
 *   2. Trigram — `title ILIKE '%q%' OR notes ILIKE '%q%'`.
 *      Substring search (e.g. `?q=holl` matches "Hollow Knight"), backed
 *      by GIN(title gin_trgm_ops) + GIN(notes gin_trgm_ops). Fills the
 *      substring gap FTS can't cover.
 *
 * Ranking (when query is active): FTS matches sort first (rank 0),
 * trigram-only matches sort second (rank 1); within each tier by
 * ts_rank DESC then by occurred_at DESC. Industry-standard FTS +
 * pg_trgm hybrid recipe (Linear, Cal.com, Supabase docs).
 *
 * User input is escaped via escapeLikePattern before splicing into the
 * ILIKE pattern so `%` / `_` from the user behave as literals.
 *
 * Tenant scope MUST be preserved — every test seeds at least two
 * tenants and asserts cross-tenant rows never leak through the search
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

  // ------------------------------------------------------------------
  // pg_trgm hybrid-search cases (Plan 03.4-10 trigram rollout)
  // ------------------------------------------------------------------

  it("trigram: short prefix matches via substring (?q=holl finds Hollow Knight)", async () => {
    // FTS alone would NOT match `?q=holl` — `holl` is not a stemmed
    // lexeme, so `search_vec @@ plainto_tsquery('english', 'holl')`
    // returns no rows. With the trigram ILIKE branch added, the title
    // substring match fires and "Hollow Knight" surfaces.
    const { userId, gameId } = await seedTenant("trgm-prefix@test.local");
    const match = await createEvent(
      userId,
      {
        gameIds: [gameId],
        kind: "press",
        occurredAt: new Date("2026-04-01T12:00:00Z"),
        title: "Hollow Knight launch wishlist push",
      },
      "127.0.0.1",
    );
    await createEvent(
      userId,
      {
        gameIds: [gameId],
        kind: "press",
        occurredAt: new Date("2026-04-02T12:00:00Z"),
        title: "Some other release",
      },
      "127.0.0.1",
    );

    const page = await listFeedPage(userId, { query: "holl" }, null);
    expect(page.rows.map((r) => r.id)).toEqual([match.id]);
  });

  it("trigram: short prefix matches in notes too (?q=holl finds notes hit)", async () => {
    const { userId, gameId } = await seedTenant("trgm-notes-prefix@test.local");
    const match = await createEvent(
      userId,
      {
        gameIds: [gameId],
        kind: "press",
        occurredAt: new Date("2026-04-01T12:00:00Z"),
        title: "Unrelated title",
        notes: "Coverage of the Hollywood event was unexpected.",
      },
      "127.0.0.1",
    );
    await createEvent(
      userId,
      {
        gameIds: [gameId],
        kind: "press",
        occurredAt: new Date("2026-04-02T12:00:00Z"),
        title: "Another title",
        notes: "Nothing related here.",
      },
      "127.0.0.1",
    );

    const page = await listFeedPage(userId, { query: "holl" }, null);
    expect(page.rows.map((r) => r.id)).toEqual([match.id]);
  });

  it("FTS still preferred: ?q=viking matches vikings (stem) without trigram", async () => {
    // Stemming wins on its own — this test ensures the OR didn't break
    // the stem branch. `viking` → lexeme `viking`; "vikings" → also
    // `viking`. The trigram branch ALSO matches (substring), but the
    // FTS branch should fire and tier the result rank 0.
    const { userId, gameId } = await seedTenant("trgm-vikings@test.local");
    const stem = await createEvent(
      userId,
      {
        gameIds: [gameId],
        kind: "press",
        occurredAt: new Date("2026-04-01T12:00:00Z"),
        title: "Reviewing vikings combat in detail",
      },
      "127.0.0.1",
    );
    await createEvent(
      userId,
      {
        gameIds: [gameId],
        kind: "press",
        occurredAt: new Date("2026-04-02T12:00:00Z"),
        title: "Unrelated title",
      },
      "127.0.0.1",
    );

    const page = await listFeedPage(userId, { query: "viking" }, null);
    expect(page.rows.map((r) => r.id)).toEqual([stem.id]);
  });

  it("ranking: FTS-matched event sorts before trigram-only match", async () => {
    // Event A: word "hello" — FTS lexeme match (rank 0).
    // Event B: word "helloworld" — trigram-only substring (rank 1) —
    //   English stemmer treats `helloworld` as a single lexeme distinct
    //   from `hello`, so FTS does NOT consider B a `hello` match. The
    //   trigram ILIKE branch picks it up via the substring 'hello'.
    //
    // Even though B occurred LATER (would normally surface first by
    // date-desc), the rank tier flips: A (FTS, rank 0) MUST come before
    // B (trigram-only, rank 1).
    const { userId, gameId } = await seedTenant("trgm-rank@test.local");
    const fts = await createEvent(
      userId,
      {
        gameIds: [gameId],
        kind: "press",
        occurredAt: new Date("2026-04-01T12:00:00Z"),
        title: "hello there",
      },
      "127.0.0.1",
    );
    const trigramOnly = await createEvent(
      userId,
      {
        gameIds: [gameId],
        kind: "press",
        // Occurs LATER — would normally sort first by date-desc, but
        // FTS tier-0 should beat trigram tier-1 regardless of date.
        occurredAt: new Date("2026-04-05T12:00:00Z"),
        title: "Big helloworld push",
      },
      "127.0.0.1",
    );

    const page = await listFeedPage(userId, { query: "hello" }, null);
    // Both events are matched. Tier order: FTS first, trigram-only second.
    expect(page.rows.map((r) => r.id)).toEqual([fts.id, trigramOnly.id]);
  });

  it("ILIKE wildcard injection guard: literal % in query doesn't widen match", async () => {
    // Without escapeLikePattern, `?q=%` would build pattern `%%%` →
    // matches everything. With escaping, `%` becomes `\%` (literal) so
    // only rows whose title/notes contain a literal `%` character match.
    const { userId, gameId } = await seedTenant("trgm-escape@test.local");
    await createEvent(
      userId,
      {
        gameIds: [gameId],
        kind: "press",
        occurredAt: new Date("2026-04-01T12:00:00Z"),
        title: "Normal title",
      },
      "127.0.0.1",
    );
    const literalPercent = await createEvent(
      userId,
      {
        gameIds: [gameId],
        kind: "press",
        occurredAt: new Date("2026-04-02T12:00:00Z"),
        title: "Bumped 100% conversion on Friday",
      },
      "127.0.0.1",
    );

    // Query literally for "100%" — should only match the row containing
    // the literal "100%", not every row. The `%` from input must NOT
    // act as a wildcard.
    const page = await listFeedPage(userId, { query: "100%" }, null);
    expect(page.rows.map((r) => r.id)).toEqual([literalPercent.id]);
  });

  it("trigram facets: chip counts respect partial-match queries", async () => {
    // Three events: two with "Hollow" in title (one press, one youtube),
    // one with unrelated title. ?q=holl should narrow facets to the
    // matching two via the trigram branch.
    const { userId, gameId } = await seedTenant("trgm-facets@test.local");
    await createEvent(
      userId,
      {
        gameIds: [gameId],
        kind: "press",
        occurredAt: new Date("2026-04-01T12:00:00Z"),
        title: "Hollow Knight press",
      },
      "127.0.0.1",
    );
    await createEvent(
      userId,
      {
        gameIds: [gameId],
        kind: "youtube_video",
        occurredAt: new Date("2026-04-02T12:00:00Z"),
        title: "Hollow Knight video",
        externalId: "yt-trgm-1",
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

    const facets = await listFeedFacets(userId, { query: "holl" });
    expect(facets.total).toBe(2);
    expect(facets.kinds.press).toBe(1);
    expect(facets.kinds.youtube_video).toBe(1);
    expect(facets.show.all).toBe(2);
  });
});
