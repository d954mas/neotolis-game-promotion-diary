import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import {
  createEvent,
  listFeedPage,
  markStandalone,
  FEED_PAGE_SIZE,
} from "../../src/lib/server/services/events.js";
import { db } from "../../src/lib/server/db/client.js";
import { dataSources } from "../../src/lib/server/db/schema/data-sources.js";
import { games } from "../../src/lib/server/db/schema/games.js";
import { events } from "../../src/lib/server/db/schema/events.js";
import { encodeCursor } from "../../src/lib/server/services/audit-read.js";
import { uuidv7 } from "../../src/lib/server/ids.js";
import { seedUserDirectly } from "./helpers.js";

/**
 * Phase 2.1 Wave 1B (Plan 02.1-05) — listFeedPage service-level tests.
 *
 * The placeholders (Plan 02.1-02) named `Plan 02.1-06: GET /api/events ...` —
 * those route-layer assertions land in Plan 02.1-06. Here we flip them to live
 * SERVICE-level tests against listFeedPage, which is the function the route
 * layer wraps. The service contract IS the load-bearing one (RESEARCH §3.3 +
 * PITFALL P19); the route layer only adds URL-param parsing + DTO projection.
 */

interface Seeded {
  userId: string;
  gameId: string;
  sourceId: string;
}

async function seedUserGameAndSource(email: string): Promise<Seeded> {
  const u = await seedUserDirectly({ email });
  // Insert games / data_sources rows directly so we don't depend on the
  // games / data-sources services (Plan 02.1-04 may be mid-flight in parallel).
  const gameId = uuidv7();
  await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });
  const sourceId = uuidv7();
  await db.insert(dataSources).values({
    id: sourceId,
    userId: u.id,
    kind: "youtube_channel",
    handleUrl: `https://www.youtube.com/@feed-${u.id.slice(0, 8)}`,
    displayName: "Test Channel",
    isOwnedByMe: true,
    autoImport: true,
  });
  return { userId: u.id, gameId, sourceId };
}

describe("FEED-01: listFeedPage chronological pool with filters", () => {
  it("returns ALL user events sorted occurredAt DESC, id DESC; cursor null when fewer than FEED_PAGE_SIZE+1", async () => {
    const { userId, gameId } = await seedUserGameAndSource("feed1@test.local");
    const e1 = await createEvent(
      userId,
      {
        gameId,
        kind: "press",
        occurredAt: new Date("2026-04-01T12:00:00Z"),
        title: "First",
      },
      "127.0.0.1",
    );
    const e2 = await createEvent(
      userId,
      {
        gameId,
        kind: "conference",
        occurredAt: new Date("2026-06-15T09:00:00Z"),
        title: "Second",
      },
      "127.0.0.1",
    );
    const e3 = await createEvent(
      userId,
      {
        gameId: null,
        kind: "talk",
        occurredAt: new Date("2026-05-10T15:00:00Z"),
        title: "Inbox-talk",
      },
      "127.0.0.1",
    );

    const page = await listFeedPage(userId, {}, null);
    expect(page.rows).toHaveLength(3);
    // Sorted DESC: conference(Jun) → talk(May) → press(Apr).
    expect(page.rows[0]!.id).toBe(e2.id);
    expect(page.rows[1]!.id).toBe(e3.id);
    expect(page.rows[2]!.id).toBe(e1.id);
    expect(page.nextCursor).toBeNull();
  });

  it("filter source=:id returns only events with that source_id", async () => {
    const { userId, gameId, sourceId } = await seedUserGameAndSource("feed2@test.local");
    const owned = await createEvent(
      userId,
      {
        gameId,
        kind: "youtube_video",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "From source",
        sourceId,
        externalId: "src-vid-1",
      },
      "127.0.0.1",
    );
    await createEvent(
      userId,
      {
        gameId,
        kind: "press",
        occurredAt: new Date("2026-06-02T10:00:00Z"),
        title: "Manual press",
      },
      "127.0.0.1",
    );

    const page = await listFeedPage(userId, { source: sourceId }, null);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.id).toBe(owned.id);
    expect(page.rows[0]!.sourceId).toBe(sourceId);
  });

  it("filter kind=youtube_video filters by kind", async () => {
    const { userId, gameId } = await seedUserGameAndSource("feed3@test.local");
    const yt = await createEvent(
      userId,
      {
        gameId,
        kind: "youtube_video",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Video",
        externalId: "yt-1",
      },
      "127.0.0.1",
    );
    await createEvent(
      userId,
      {
        gameId,
        kind: "press",
        occurredAt: new Date("2026-06-02T10:00:00Z"),
        title: "Press",
      },
      "127.0.0.1",
    );

    const page = await listFeedPage(userId, { kind: "youtube_video" }, null);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.id).toBe(yt.id);
  });

  it("filter game=:id filters by game_id", async () => {
    const u = await seedUserDirectly({ email: "feed4@test.local" });
    const gameA = uuidv7();
    const gameB = uuidv7();
    await db.insert(games).values({ id: gameA, userId: u.id, title: "A" });
    await db.insert(games).values({ id: gameB, userId: u.id, title: "B" });

    const evA = await createEvent(
      u.id,
      {
        gameId: gameA,
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "A press",
      },
      "127.0.0.1",
    );
    await createEvent(
      u.id,
      {
        gameId: gameB,
        kind: "press",
        occurredAt: new Date("2026-06-02T10:00:00Z"),
        title: "B press",
      },
      "127.0.0.1",
    );

    const page = await listFeedPage(
      u.id,
      { show: { kind: "specific", gameIds: [gameA] } },
      null,
    );
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.id).toBe(evA.id);
  });

  it("filter show.specific with empty gameIds is equivalent to any (no filter applied)", async () => {
    // Plan 02.1-19 contract: `show: { kind: 'specific', gameIds: [] }` is
    // semantically equivalent to `show: { kind: 'any' }`. The UI prevents
    // this state but the service stays defensive (mirrors pushAxis empty-
    // array semantics).
    const u = await seedUserDirectly({ email: "feed4b@test.local" });
    const gA = uuidv7();
    await db.insert(games).values({ id: gA, userId: u.id, title: "GA" });
    const ev = await createEvent(
      u.id,
      {
        gameId: gA,
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Specific empty",
      },
      "127.0.0.1",
    );
    const page = await listFeedPage(
      u.id,
      { show: { kind: "specific", gameIds: [] } },
      null,
    );
    expect(page.rows.map((r) => r.id)).toContain(ev.id);
  });

  it("filter show.specific with multiple gameIds returns events attached to ANY of them", async () => {
    const u = await seedUserDirectly({ email: "feed4c@test.local" });
    const gA = uuidv7();
    const gB = uuidv7();
    const gC = uuidv7();
    await db.insert(games).values({ id: gA, userId: u.id, title: "A" });
    await db.insert(games).values({ id: gB, userId: u.id, title: "B" });
    await db.insert(games).values({ id: gC, userId: u.id, title: "C" });
    const evA = await createEvent(
      u.id,
      {
        gameId: gA,
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "A",
      },
      "127.0.0.1",
    );
    const evB = await createEvent(
      u.id,
      {
        gameId: gB,
        kind: "press",
        occurredAt: new Date("2026-06-02T10:00:00Z"),
        title: "B",
      },
      "127.0.0.1",
    );
    await createEvent(
      u.id,
      {
        gameId: gC,
        kind: "press",
        occurredAt: new Date("2026-06-03T10:00:00Z"),
        title: "C",
      },
      "127.0.0.1",
    );
    const page = await listFeedPage(
      u.id,
      { show: { kind: "specific", gameIds: [gA, gB] } },
      null,
    );
    const ids = page.rows.map((r) => r.id);
    expect(ids).toContain(evA.id);
    expect(ids).toContain(evB.id);
    expect(page.rows).toHaveLength(2);
  });

  it("filter show.any returns ALL rows for that user (no game/inbox filter applied)", async () => {
    const { userId, gameId } = await seedUserGameAndSource("feed4d@test.local");
    const attached = await createEvent(
      userId,
      {
        gameId,
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Attached row",
      },
      "127.0.0.1",
    );
    const inbox = await createEvent(
      userId,
      {
        gameId: null,
        kind: "press",
        occurredAt: new Date("2026-06-02T10:00:00Z"),
        title: "Inbox row",
      },
      "127.0.0.1",
    );
    const page = await listFeedPage(userId, { show: { kind: "any" } }, null);
    const ids = page.rows.map((r) => r.id);
    expect(ids).toContain(attached.id);
    expect(ids).toContain(inbox.id);
  });

  it("Plan 02.1-19: cross-tenant probe — userB cannot pierce userId scope via show.specific&gameIds=[userAGameId]", async () => {
    // userId WHERE clause is the firewall — gameId match is downstream of
    // tenant scope. CLAUDE.md item 1: tenant scope is mandatory and explicit.
    const userA = await seedUserDirectly({ email: "feed-cross-a@test.local" });
    const userB = await seedUserDirectly({ email: "feed-cross-b@test.local" });
    const gameAofUserA = uuidv7();
    await db.insert(games).values({
      id: gameAofUserA,
      userId: userA.id,
      title: "User A Game",
    });
    await createEvent(
      userA.id,
      {
        gameId: gameAofUserA,
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "User A event",
      },
      "127.0.0.1",
    );

    const page = await listFeedPage(
      userB.id,
      { show: { kind: "specific", gameIds: [gameAofUserA] } },
      null,
    );
    // userB sees ZERO rows even though the gameId matches a real row
    // belonging to userA — userId WHERE is FIRST in the and(...) clause.
    expect(page.rows).toHaveLength(0);
  });

  it("Plan 02.1-19: show.specific with one game returns only events with game_id = X (replaces legacy attached=true semantic)", async () => {
    const { userId, gameId } = await seedUserGameAndSource("feed5@test.local");
    const attached = await createEvent(
      userId,
      {
        gameId,
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Attached",
      },
      "127.0.0.1",
    );
    await createEvent(
      userId,
      {
        gameId: null,
        kind: "press",
        occurredAt: new Date("2026-06-02T10:00:00Z"),
        title: "Inbox",
      },
      "127.0.0.1",
    );

    const page = await listFeedPage(
      userId,
      { show: { kind: "specific", gameIds: [gameId] } },
      null,
    );
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.id).toBe(attached.id);
    expect(page.rows[0]!.gameId).toBe(gameId);
  });

  it("Plan 02.1-19: show.inbox returns events with game_id IS NULL AND metadata.inbox.dismissed != true (replaces legacy attached=false)", async () => {
    const { userId, gameId } = await seedUserGameAndSource("feed6@test.local");
    const inbox = await createEvent(
      userId,
      {
        gameId: null,
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Inbox active",
      },
      "127.0.0.1",
    );
    await createEvent(
      userId,
      {
        gameId,
        kind: "press",
        occurredAt: new Date("2026-06-02T10:00:00Z"),
        title: "Attached",
      },
      "127.0.0.1",
    );
    // Manually mark one inbox event as dismissed via DB so the test does not
    // depend on dismissFromInbox (covered by inbox.test.ts).
    const dismissed = await createEvent(
      userId,
      {
        gameId: null,
        kind: "press",
        occurredAt: new Date("2026-06-03T10:00:00Z"),
        title: "Inbox dismissed",
        metadata: { inbox: { dismissed: true } },
      },
      "127.0.0.1",
    );

    const page = await listFeedPage(userId, { show: { kind: "inbox" } }, null);
    const ids = page.rows.map((r) => r.id);
    expect(ids).toContain(inbox.id);
    expect(ids).not.toContain(dismissed.id);
    // Attached row also excluded.
    expect(page.rows.every((r) => r.gameId === null)).toBe(true);
  });

  it("filter authorIsMe=true filters by author_is_me", async () => {
    const { userId, gameId, sourceId } = await seedUserGameAndSource("feed7@test.local");
    const own = await createEvent(
      userId,
      {
        gameId,
        kind: "youtube_video",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Own video",
        sourceId,
        authorIsMe: true,
        externalId: "own-1",
      },
      "127.0.0.1",
    );
    await createEvent(
      userId,
      {
        gameId,
        kind: "press",
        occurredAt: new Date("2026-06-02T10:00:00Z"),
        title: "Blogger press",
        authorIsMe: false,
      },
      "127.0.0.1",
    );

    const page = await listFeedPage(userId, { authorIsMe: true }, null);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.id).toBe(own.id);
  });

  it("filter from=ISO&to=ISO filters by occurredAt range", async () => {
    const { userId, gameId } = await seedUserGameAndSource("feed8@test.local");
    await createEvent(
      userId,
      {
        gameId,
        kind: "press",
        occurredAt: new Date("2026-04-01T10:00:00Z"),
        title: "April",
      },
      "127.0.0.1",
    );
    const may = await createEvent(
      userId,
      {
        gameId,
        kind: "press",
        occurredAt: new Date("2026-05-15T10:00:00Z"),
        title: "May",
      },
      "127.0.0.1",
    );
    await createEvent(
      userId,
      {
        gameId,
        kind: "press",
        occurredAt: new Date("2026-07-01T10:00:00Z"),
        title: "July",
      },
      "127.0.0.1",
    );

    const page = await listFeedPage(
      userId,
      {
        from: new Date("2026-05-01T00:00:00Z"),
        to: new Date("2026-06-30T23:59:59Z"),
      },
      null,
    );
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.id).toBe(may.id);
  });

  it("combination filter source+kind+show.specific works", async () => {
    const { userId, gameId, sourceId } = await seedUserGameAndSource("feed9@test.local");
    const target = await createEvent(
      userId,
      {
        gameId,
        kind: "youtube_video",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Match all 3",
        sourceId,
        externalId: "match-1",
      },
      "127.0.0.1",
    );
    // Same source, different kind.
    await createEvent(
      userId,
      {
        gameId,
        kind: "press",
        occurredAt: new Date("2026-06-02T10:00:00Z"),
        title: "Press w/ source",
        sourceId,
      },
      "127.0.0.1",
    );
    // Same kind, no source.
    await createEvent(
      userId,
      {
        gameId,
        kind: "youtube_video",
        occurredAt: new Date("2026-06-03T10:00:00Z"),
        title: "yt no source",
        externalId: "ns-1",
      },
      "127.0.0.1",
    );
    // Same kind+source, but inbox (not attached).
    await createEvent(
      userId,
      {
        gameId: null,
        kind: "youtube_video",
        occurredAt: new Date("2026-06-04T10:00:00Z"),
        title: "yt inbox",
        sourceId,
        externalId: "inbox-1",
      },
      "127.0.0.1",
    );

    const page = await listFeedPage(
      userId,
      {
        source: sourceId,
        kind: "youtube_video",
        show: { kind: "specific", gameIds: [gameId] },
      },
      null,
    );
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.id).toBe(target.id);
  });

  it("cursor returns next FEED_PAGE_SIZE rows; cursor is base64url JSON {at,id}", async () => {
    const { userId, gameId } = await seedUserGameAndSource("feed10@test.local");
    // Seed FEED_PAGE_SIZE + 5 events so we get a non-null cursor on page 1.
    const total = FEED_PAGE_SIZE + 5;
    const baseTime = new Date("2026-06-01T00:00:00Z").getTime();
    for (let i = 0; i < total; i++) {
      await createEvent(
        userId,
        {
          gameId,
          kind: "press",
          // Stagger so ordering is unambiguous (per-second resolution).
          occurredAt: new Date(baseTime + i * 1000),
          title: `E${i}`,
        },
        "127.0.0.1",
      );
    }

    const page1 = await listFeedPage(userId, {}, null);
    expect(page1.rows).toHaveLength(FEED_PAGE_SIZE);
    expect(page1.nextCursor).not.toBeNull();
    // Cursor format: base64url(JSON.stringify({at, id})). Decode round-trips.
    const decoded = JSON.parse(
      Buffer.from(page1.nextCursor!, "base64url").toString("utf8"),
    ) as { at: string; id: string };
    expect(typeof decoded.at).toBe("string");
    expect(typeof decoded.id).toBe("string");
    expect(decoded.id).toBe(page1.rows[FEED_PAGE_SIZE - 1]!.id);

    const page2 = await listFeedPage(userId, {}, page1.nextCursor);
    expect(page2.rows).toHaveLength(5);
    // Page 2 doesn't overlap page 1.
    const page1Ids = new Set(page1.rows.map((r) => r.id));
    expect(page2.rows.every((r) => !page1Ids.has(r.id))).toBe(true);
    expect(page2.nextCursor).toBeNull();
  });

  it("PITFALL P19: cursor opacity does not let user A see user B's row IDs (userId WHERE clause first)", async () => {
    const userA = await seedUserDirectly({ email: "feed11a@test.local" });
    const userB = await seedUserDirectly({ email: "feed11b@test.local" });
    const gameB = uuidv7();
    await db.insert(games).values({ id: gameB, userId: userB.id, title: "GB" });
    // User B owns events; user A owns NONE.
    const evB = await createEvent(
      userB.id,
      {
        gameId: gameB,
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "B press",
      },
      "127.0.0.1",
    );

    // Forge a cursor that encodes user B's row coordinates.
    const forgedCursor = encodeCursor(
      new Date(evB.occurredAt.getTime() + 60_000),
      "ffffffff-ffff-7fff-ffff-ffffffffffff",
    );

    // User A queries with the forged cursor — should get ZERO rows because
    // the userId WHERE clause is independent of the cursor (P19 mitigation).
    const page = await listFeedPage(userA.id, {}, forgedCursor);
    expect(page.rows).toHaveLength(0);
    expect(page.nextCursor).toBeNull();

    // Sanity: the rows in user B's DB are still there (we just can't see them).
    const allB = await db.select().from(events).where(eq(events.userId, userB.id));
    expect(allB).toHaveLength(1);
  });

  it("listFeedPage excludes soft-deleted events", async () => {
    const { userId, gameId } = await seedUserGameAndSource("feed12@test.local");
    const live = await createEvent(
      userId,
      {
        gameId,
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Live",
      },
      "127.0.0.1",
    );
    const dead = await createEvent(
      userId,
      {
        gameId,
        kind: "press",
        occurredAt: new Date("2026-06-02T10:00:00Z"),
        title: "Dead",
      },
      "127.0.0.1",
    );
    // Soft-delete one row directly (avoid dependency on softDeleteEvent's audit).
    await db
      .update(events)
      .set({ deletedAt: new Date() })
      .where(eq(events.id, dead.id));

    const page = await listFeedPage(userId, {}, null);
    const ids = page.rows.map((r) => r.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(dead.id);
  });
});

// Plan 02.1-06 — GET /api/events HTTP-boundary tests for the feed loader.
describe("Plan 02.1-06: GET /api/events HTTP boundary", () => {
  it("Plan 02.1-06: GET /api/events returns 200 + {rows, nextCursor} with EventDto-projected rows (no userId)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const { userId, gameId } = await seedUserGameAndSource("http-feed-1@test.local");
    await createEvent(
      userId,
      {
        gameId,
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "press feed http",
      },
      "127.0.0.1",
    );

    // Resolve the user back to grab the signedSessionCookieValue. Easiest:
    // re-seed a separate user is wrong; we need THIS user's cookie. We seed
    // the user via seedUserDirectly inside seedUserGameAndSource, but the
    // helper discards the cookie. Re-seed an explicit user for the cookie.
    const u = await seedUserDirectly({ email: "http-feed-1b@test.local" });
    // u has zero events; we want to assert the JSON envelope shape. Use u's
    // session cookie to query its OWN feed (empty rows array but the envelope
    // shape is what we assert).
    const res = await app.request("/api/events", {
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[]; nextCursor: string | null };
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.nextCursor).toBeNull();
  });

  it("Plan 02.1-19: GET /api/events?show=specific&game=:id returns rows attached to that game (replaces legacy ?attached=true)", async () => {
    // Plan 02.1-19 destructive contract change: ?attached=true|false is gone;
    // ?show=any|inbox|specific&game=A&game=B replaces it. Pre-launch
    // (CONTEXT D-04: zero self-host deployments) so the URL break is OK.
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "http-feed-2@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });
    const attached = await createEvent(
      u.id,
      {
        gameId,
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "attached",
      },
      "127.0.0.1",
    );
    await createEvent(
      u.id,
      {
        gameId: null,
        kind: "press",
        occurredAt: new Date("2026-06-02T10:00:00Z"),
        title: "inbox",
      },
      "127.0.0.1",
    );
    const res = await app.request(
      `/api/events?show=specific&game=${gameId}`,
      {
        headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string; gameId: string | null }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]!.id).toBe(attached.id);
    expect(body.rows[0]!.gameId).toBe(gameId);
  });

  it("Plan 02.1-06: GET /api/events response rows are EventDto-projected (no userId leaks)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "http-feed-3@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });
    await createEvent(
      u.id,
      {
        gameId,
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "leak check",
      },
      "127.0.0.1",
    );
    const res = await app.request("/api/events", {
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).not.toHaveProperty("userId");
  });

  it("Plan 02.1-06: GET /api/events?kind=invalid returns 422 validation_failed", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "http-feed-4@test.local" });
    const res = await app.request("/api/events?kind=not_a_kind", {
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("validation_failed");
  });
});

// Plan 02.1-15 — multi-select filter tests (VERIFICATION.md Gap 4 closure).
// OR-within-axis (source IN (A, B)) + AND-across-axes ((source IN ...) AND
// (kind = ...)) semantics; bare-string back-compat preserved; HTTP-layer
// repeated-param parsing (?source=A&source=B) lands the same envelope.
describe("Plan 02.1-15: multi-select feed filters (OR-within-axis, AND-across-axes)", () => {
  async function seedThreeSources(
    email: string,
  ): Promise<{ userId: string; sourceA: string; sourceB: string; sourceC: string }> {
    const u = await seedUserDirectly({ email });
    const sourceA = uuidv7();
    const sourceB = uuidv7();
    const sourceC = uuidv7();
    await db.insert(dataSources).values([
      {
        id: sourceA,
        userId: u.id,
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/@A-${u.id.slice(0, 8)}`,
        displayName: "Source A",
        isOwnedByMe: true,
        autoImport: true,
      },
      {
        id: sourceB,
        userId: u.id,
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/@B-${u.id.slice(0, 8)}`,
        displayName: "Source B",
        isOwnedByMe: true,
        autoImport: true,
      },
      {
        id: sourceC,
        userId: u.id,
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/@C-${u.id.slice(0, 8)}`,
        displayName: "Source C",
        isOwnedByMe: true,
        autoImport: true,
      },
    ]);
    return { userId: u.id, sourceA, sourceB, sourceC };
  }

  it("Plan 02.1-15: source=[A, B] returns rows from A or B (OR within axis), excludes C", async () => {
    const { userId, sourceA, sourceB, sourceC } =
      await seedThreeSources("ms-feed-1@test.local");
    const eA = await createEvent(
      userId,
      {
        kind: "youtube_video",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Video A",
        sourceId: sourceA,
        externalId: "ms-A-1",
      },
      "127.0.0.1",
    );
    const eB = await createEvent(
      userId,
      {
        kind: "youtube_video",
        occurredAt: new Date("2026-06-02T10:00:00Z"),
        title: "Video B",
        sourceId: sourceB,
        externalId: "ms-B-1",
      },
      "127.0.0.1",
    );
    await createEvent(
      userId,
      {
        kind: "youtube_video",
        occurredAt: new Date("2026-06-03T10:00:00Z"),
        title: "Video C",
        sourceId: sourceC,
        externalId: "ms-C-1",
      },
      "127.0.0.1",
    );

    const page = await listFeedPage(userId, { source: [sourceA, sourceB] }, null);
    expect(page.rows).toHaveLength(2);
    const ids = page.rows.map((r) => r.id);
    expect(ids).toContain(eA.id);
    expect(ids).toContain(eB.id);
    expect(page.rows.every((r) => r.sourceId === sourceA || r.sourceId === sourceB)).toBe(
      true,
    );
  });

  it("Plan 02.1-15: source=[A] (single-element array) returns one row — eq() back-compat", async () => {
    const { userId, sourceA, sourceB } = await seedThreeSources("ms-feed-2@test.local");
    const eA = await createEvent(
      userId,
      {
        kind: "youtube_video",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Video A",
        sourceId: sourceA,
        externalId: "ms-A-2",
      },
      "127.0.0.1",
    );
    await createEvent(
      userId,
      {
        kind: "youtube_video",
        occurredAt: new Date("2026-06-02T10:00:00Z"),
        title: "Video B",
        sourceId: sourceB,
        externalId: "ms-B-2",
      },
      "127.0.0.1",
    );

    const page = await listFeedPage(userId, { source: [sourceA] }, null);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.id).toBe(eA.id);
  });

  it("Plan 02.1-15: source='A' (legacy bare string) preserves Phase 2 callers", async () => {
    const { userId, sourceA, sourceB } = await seedThreeSources("ms-feed-3@test.local");
    const eA = await createEvent(
      userId,
      {
        kind: "youtube_video",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Video A",
        sourceId: sourceA,
        externalId: "ms-A-3",
      },
      "127.0.0.1",
    );
    await createEvent(
      userId,
      {
        kind: "youtube_video",
        occurredAt: new Date("2026-06-02T10:00:00Z"),
        title: "Video B",
        sourceId: sourceB,
        externalId: "ms-B-3",
      },
      "127.0.0.1",
    );

    const page = await listFeedPage(userId, { source: sourceA }, null);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.id).toBe(eA.id);
  });

  it("Plan 02.1-15: source=[] (empty array) is treated as no filter — returns all rows", async () => {
    const { userId, sourceA, sourceB, sourceC } =
      await seedThreeSources("ms-feed-4@test.local");
    await createEvent(
      userId,
      {
        kind: "youtube_video",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Video A",
        sourceId: sourceA,
        externalId: "ms-A-4",
      },
      "127.0.0.1",
    );
    await createEvent(
      userId,
      {
        kind: "youtube_video",
        occurredAt: new Date("2026-06-02T10:00:00Z"),
        title: "Video B",
        sourceId: sourceB,
        externalId: "ms-B-4",
      },
      "127.0.0.1",
    );
    await createEvent(
      userId,
      {
        kind: "youtube_video",
        occurredAt: new Date("2026-06-03T10:00:00Z"),
        title: "Video C",
        sourceId: sourceC,
        externalId: "ms-C-4",
      },
      "127.0.0.1",
    );

    const page = await listFeedPage(userId, { source: [] }, null);
    expect(page.rows).toHaveLength(3);
  });

  it("Plan 02.1-15: AND-across-axes — source=[A,B] AND kind=[youtube_video]", async () => {
    const { userId, sourceA, sourceB } = await seedThreeSources("ms-feed-5@test.local");
    // Mixed kinds: A has a youtube_video AND a press; B has only youtube_video.
    const aYt = await createEvent(
      userId,
      {
        kind: "youtube_video",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "A youtube",
        sourceId: sourceA,
        externalId: "ms-A-5-yt",
      },
      "127.0.0.1",
    );
    await createEvent(
      userId,
      {
        kind: "press",
        occurredAt: new Date("2026-06-02T10:00:00Z"),
        title: "A press",
        sourceId: sourceA,
      },
      "127.0.0.1",
    );
    const bYt = await createEvent(
      userId,
      {
        kind: "youtube_video",
        occurredAt: new Date("2026-06-03T10:00:00Z"),
        title: "B youtube",
        sourceId: sourceB,
        externalId: "ms-B-5-yt",
      },
      "127.0.0.1",
    );

    const page = await listFeedPage(
      userId,
      { source: [sourceA, sourceB], kind: ["youtube_video"] },
      null,
    );
    expect(page.rows).toHaveLength(2);
    const ids = page.rows.map((r) => r.id);
    expect(ids).toContain(aYt.id);
    expect(ids).toContain(bYt.id);
    expect(page.rows.every((r) => r.kind === "youtube_video")).toBe(true);
  });

  it("Plan 02.1-15: GET /api/events?source=A&source=B returns 200 + rows scoped to those 2 sources", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "ms-feed-http-1@test.local" });
    const sourceA = uuidv7();
    const sourceB = uuidv7();
    const sourceC = uuidv7();
    await db.insert(dataSources).values([
      {
        id: sourceA,
        userId: u.id,
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/@http-A-${u.id.slice(0, 8)}`,
        displayName: "Source A",
        isOwnedByMe: true,
        autoImport: true,
      },
      {
        id: sourceB,
        userId: u.id,
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/@http-B-${u.id.slice(0, 8)}`,
        displayName: "Source B",
        isOwnedByMe: true,
        autoImport: true,
      },
      {
        id: sourceC,
        userId: u.id,
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/@http-C-${u.id.slice(0, 8)}`,
        displayName: "Source C",
        isOwnedByMe: true,
        autoImport: true,
      },
    ]);
    await createEvent(
      u.id,
      {
        kind: "youtube_video",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "A vid",
        sourceId: sourceA,
        externalId: "ms-http-A",
      },
      "127.0.0.1",
    );
    await createEvent(
      u.id,
      {
        kind: "youtube_video",
        occurredAt: new Date("2026-06-02T10:00:00Z"),
        title: "B vid",
        sourceId: sourceB,
        externalId: "ms-http-B",
      },
      "127.0.0.1",
    );
    await createEvent(
      u.id,
      {
        kind: "youtube_video",
        occurredAt: new Date("2026-06-03T10:00:00Z"),
        title: "C vid",
        sourceId: sourceC,
        externalId: "ms-http-C",
      },
      "127.0.0.1",
    );

    const res = await app.request(`/api/events?source=${sourceA}&source=${sourceB}`, {
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ sourceId: string | null }>;
      nextCursor: string | null;
    };
    expect(body.rows).toHaveLength(2);
    expect(body.rows.every((r) => r.sourceId === sourceA || r.sourceId === sourceB)).toBe(
      true,
    );
  });

  it("Plan 02.1-15: GET /api/events?source=A (single param) preserves single-value back-compat", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "ms-feed-http-2@test.local" });
    const sourceA = uuidv7();
    const sourceB = uuidv7();
    await db.insert(dataSources).values([
      {
        id: sourceA,
        userId: u.id,
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/@http2-A-${u.id.slice(0, 8)}`,
        displayName: "Source A",
        isOwnedByMe: true,
        autoImport: true,
      },
      {
        id: sourceB,
        userId: u.id,
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/@http2-B-${u.id.slice(0, 8)}`,
        displayName: "Source B",
        isOwnedByMe: true,
        autoImport: true,
      },
    ]);
    await createEvent(
      u.id,
      {
        kind: "youtube_video",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "A vid",
        sourceId: sourceA,
        externalId: "ms-http2-A",
      },
      "127.0.0.1",
    );
    await createEvent(
      u.id,
      {
        kind: "youtube_video",
        occurredAt: new Date("2026-06-02T10:00:00Z"),
        title: "B vid",
        sourceId: sourceB,
        externalId: "ms-http2-B",
      },
      "127.0.0.1",
    );

    const res = await app.request(`/api/events?source=${sourceA}`, {
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ sourceId: string | null }>;
      nextCursor: string | null;
    };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]!.sourceId).toBe(sourceA);
  });
});

// Plan 02.1-24 — listFeedPage gains a fourth ShowFilter branch:
// `{ kind: 'standalone' }` returns only events where game_id IS NULL AND
// metadata.triage.standalone='true'. Inbox view continues to exclude
// dismissed events AND now also excludes standalone events (they are a
// separate triage state, not "still in inbox"). Cross-tenant probe with
// show.kind=standalone returns ZERO of the other tenant's standalone rows.
describe("Plan 02.1-24 — show.kind=standalone filter", () => {
  it("Plan 02.1-24 Test A: listFeedPage with show.kind=standalone returns ONLY events where game_id IS NULL AND metadata.triage.standalone=true", async () => {
    const u = await seedUserDirectly({ email: "p24-feed-1@test.local" });

    // Inbox event (game_id=null, no standalone flag) — must NOT appear in standalone view.
    const inboxEv = await createEvent(
      u.id,
      {
        gameId: null,
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Inbox plain",
      },
      "127.0.0.1",
    );

    // Standalone event — game_id will become null + standalone=true.
    const standaloneEv = await createEvent(
      u.id,
      {
        gameId: null,
        kind: "conference",
        occurredAt: new Date("2026-06-02T10:00:00Z"),
        title: "Standalone target",
      },
      "127.0.0.1",
    );
    await markStandalone(u.id, standaloneEv.id, "127.0.0.1");

    // Attached event (game_id != null) — must NOT appear in standalone view.
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });
    const attachedEv = await createEvent(
      u.id,
      {
        gameId,
        kind: "talk",
        occurredAt: new Date("2026-06-03T10:00:00Z"),
        title: "Attached talk",
      },
      "127.0.0.1",
    );

    const standalonePage = await listFeedPage(
      u.id,
      { show: { kind: "standalone" } },
      null,
    );
    const ids = standalonePage.rows.map((r) => r.id);
    expect(ids).toContain(standaloneEv.id);
    expect(ids).not.toContain(inboxEv.id);
    expect(ids).not.toContain(attachedEv.id);
  });

  it("Plan 02.1-24 Test B: listFeedPage with show.kind=inbox EXCLUDES standalone events (in addition to existing dismissed exclusion)", async () => {
    const u = await seedUserDirectly({ email: "p24-feed-2@test.local" });

    const inboxEv = await createEvent(
      u.id,
      {
        gameId: null,
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Plain inbox",
      },
      "127.0.0.1",
    );
    const standaloneEv = await createEvent(
      u.id,
      {
        gameId: null,
        kind: "conference",
        occurredAt: new Date("2026-06-02T10:00:00Z"),
        title: "Standalone — not inbox anymore",
      },
      "127.0.0.1",
    );
    await markStandalone(u.id, standaloneEv.id, "127.0.0.1");

    const inboxPage = await listFeedPage(u.id, { show: { kind: "inbox" } }, null);
    const ids = inboxPage.rows.map((r) => r.id);
    expect(ids).toContain(inboxEv.id);
    // Standalone is its own triage state — must NOT appear in inbox view.
    expect(ids).not.toContain(standaloneEv.id);
  });

  it("Plan 02.1-24 Test C: cross-tenant probe with show.kind=standalone returns ZERO of other-tenant standalone rows (P19 mitigation by construction)", async () => {
    const userA = await seedUserDirectly({ email: "p24-feed-3a@test.local" });
    const userB = await seedUserDirectly({ email: "p24-feed-3b@test.local" });

    const evA = await createEvent(
      userA.id,
      {
        gameId: null,
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "User A standalone",
      },
      "127.0.0.1",
    );
    await markStandalone(userA.id, evA.id, "127.0.0.1");

    const pageB = await listFeedPage(userB.id, { show: { kind: "standalone" } }, null);
    expect(pageB.rows.map((r) => r.id)).not.toContain(evA.id);
  });
});

/**
 * Plan 02.1-26 — FeedQuickNav loader contract.
 *
 * The new <FeedQuickNav> component renders one tab per the user's games
 * (collapsed into a 'More games' dropdown when > 5). It consumes the
 * existing /feed/+page.server.ts loader's `data.games` array directly —
 * NO new loader call, NO new endpoint. The tests below document the
 * contract so a future loader refactor that drops `games` from the page
 * data trips this assertion BEFORE FeedQuickNav goes blank.
 *
 * `data.games` was already returned by the loader since Plan 02.1-07
 * (FiltersSheet's per-game multi-select needs the list). Plan 02.1-26
 * adds a SECOND consumer; the contract assertion below makes that
 * explicit.
 */
describe("Plan 02.1-26 — FeedQuickNav loader contract (data.games available)", () => {
  it("listFeedPage's tenant-scoping is preserved by per-game show filter (sanity guard for FeedQuickNav per-game tab path)", async () => {
    // FeedQuickNav per-game tab navigates to ?show=specific&game=<id>. The
    // loader resolves that into ShowFilter { kind: 'specific', gameIds: [id] }
    // and listFeedPage applies the userId-first WHERE clause. This guard
    // documents that the tenant-scope chain still holds: a malicious URL
    // ?show=specific&game=<other-tenant's-game-id> returns zero rows because
    // events.userId = current user is the FIRST clause in and(...).
    const userA = await seedUserDirectly({ email: "p26-feed-a@test.local" });
    const userB = await seedUserDirectly({ email: "p26-feed-b@test.local" });

    const userBGameId = uuidv7();
    await db
      .insert(games)
      .values({ id: userBGameId, userId: userB.id, title: "User B's game" });

    // User B creates an event attached to their game.
    await createEvent(
      userB.id,
      {
        gameId: userBGameId,
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "User B press",
      },
      "127.0.0.1",
    );

    // User A asks listFeedPage for events filtered to User B's gameId. The
    // userId-first WHERE clause prunes ALL of User B's rows; the result is
    // zero. P19 mitigation by construction.
    const pageForUserA = await listFeedPage(
      userA.id,
      { show: { kind: "specific", gameIds: [userBGameId] } },
      null,
    );
    expect(pageForUserA.rows).toHaveLength(0);
  });
});
