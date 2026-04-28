import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import {
  createEvent,
  listFeedPage,
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

    const page = await listFeedPage(u.id, { game: gameA }, null);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.id).toBe(evA.id);
  });

  it("filter attached=true returns only events with game_id IS NOT NULL", async () => {
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

    const page = await listFeedPage(userId, { attached: true }, null);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.id).toBe(attached.id);
    expect(page.rows[0]!.gameId).toBe(gameId);
  });

  it("filter attached=false returns events with game_id IS NULL AND not dismissed", async () => {
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

    const page = await listFeedPage(userId, { attached: false }, null);
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

  it("combination filter source+kind+attached works", async () => {
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
      { source: sourceId, kind: "youtube_video", attached: true },
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
