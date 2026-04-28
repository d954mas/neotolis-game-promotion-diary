import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createEvent,
  updateEvent,
  softDeleteEvent,
  listEventsForGame,
  listFeedPage,
  VALID_EVENT_KINDS,
} from "../../src/lib/server/services/events.js";
import { db } from "../../src/lib/server/db/client.js";
import { games } from "../../src/lib/server/db/schema/games.js";
import { events, eventKindEnum } from "../../src/lib/server/db/schema/events.js";
import { auditLog } from "../../src/lib/server/db/schema/audit-log.js";
import { uuidv7 } from "../../src/lib/server/ids.js";
import { seedUserDirectly } from "./helpers.js";
import { AppError, NotFoundError } from "../../src/lib/server/services/errors.js";

/**
 * Phase 2.1 Wave 1B (Plan 02.1-05) — unified events service tests.
 *
 * Replaces the Phase 2 events.test.ts which exercised listTimelineForGame's
 * JS-merge of events + tracked_youtube_videos. The unified table makes the
 * merge unnecessary; listEventsForGame is the new per-game curated view.
 *
 * EVENTS-01 covers create + the closed-enum kind validation (now 9 kinds).
 * EVENTS-02 covers listEventsForGame (replaces Phase 2 listTimelineForGame).
 * EVENTS-03 covers audit on create / update / delete.
 *
 * Pitfall 6 (defense-in-depth): VALID_EVENT_KINDS const list mirrors the
 * pgEnum's enumValues; assert equality so a schema change forces a service
 * update in lock-step.
 */

describe("events CRUD (EVENTS-01..03 — unified table)", () => {
  it("VALID_EVENT_KINDS mirrors the pgEnum eventKindEnum.enumValues exactly (Pitfall 6)", () => {
    // Sorted comparison so order in either the const or the enum doesn't matter.
    const fromConst = [...VALID_EVENT_KINDS].sort();
    const fromEnum = [...eventKindEnum.enumValues].sort();
    expect(fromConst).toEqual(fromEnum);
  });

  it("EVENTS-01 create conference event with gameId", async () => {
    const u = await seedUserDirectly({ email: "ev1@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });

    const ev = await createEvent(
      u.id,
      {
        gameId,
        kind: "conference",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "GDC 2026",
      },
      "127.0.0.1",
    );

    expect(ev.kind).toBe("conference");
    expect(ev.title).toBe("GDC 2026");
    expect(ev.userId).toBe(u.id);
    expect(ev.gameId).toBe(gameId);
    expect(ev.deletedAt).toBeNull();
    // Phase 2.1 defaults.
    expect(ev.authorIsMe).toBe(false);
    expect(ev.sourceId).toBeNull();
    expect(ev.metadata).toEqual({});

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, "event.created")));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const meta = audits[0]!.metadata as { event_id?: string } | null;
    expect(meta?.event_id).toBe(ev.id);
  });

  it("EVENTS-01 create event with kind=youtube_video and gameId=null lands in inbox view (sanity for unified table)", async () => {
    const u = await seedUserDirectly({ email: "ev2@test.local" });
    const ev = await createEvent(
      u.id,
      {
        gameId: null,
        kind: "youtube_video",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Manual paste",
        externalId: "yt-manual-1",
      },
      "127.0.0.1",
    );
    expect(ev.kind).toBe("youtube_video");
    expect(ev.gameId).toBeNull();

    // Surfaces in attached=false (inbox) view.
    const inbox = await listFeedPage(u.id, { attached: false }, null);
    expect(inbox.rows.map((r) => r.id)).toContain(ev.id);
  });

  it("EVENTS-01 create with kind not in VALID_EVENT_KINDS throws AppError 'validation_failed' (422)", async () => {
    const u = await seedUserDirectly({ email: "ev3@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });

    await expect(
      createEvent(
        u.id,
        {
          gameId,
          kind: "not-a-kind" as unknown as "conference",
          occurredAt: new Date(),
          title: "X",
        },
        "127.0.0.1",
      ),
    ).rejects.toMatchObject({ code: "validation_failed", status: 422 });

    // Validate-first invariant: NO row written.
    const rows = await db.select().from(events).where(eq(events.userId, u.id));
    expect(rows).toHaveLength(0);
  });

  it("EVENTS-01 create with cross-tenant gameId throws NotFoundError (Pitfall 4)", async () => {
    const userA = await seedUserDirectly({ email: "ev4a@test.local" });
    const userB = await seedUserDirectly({ email: "ev4b@test.local" });
    const gameB = uuidv7();
    await db.insert(games).values({ id: gameB, userId: userB.id, title: "GB" });

    await expect(
      createEvent(
        userA.id,
        {
          gameId: gameB,
          kind: "press",
          occurredAt: new Date(),
          title: "X",
        },
        "127.0.0.1",
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    // No row written for either user.
    const rowsA = await db.select().from(events).where(eq(events.userId, userA.id));
    expect(rowsA).toHaveLength(0);
  });

  it("EVENTS-02 listEventsForGame returns events filtered to the game (replaces Phase 2 listTimelineForGame)", async () => {
    const u = await seedUserDirectly({ email: "ev5@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });
    const otherGame = uuidv7();
    await db.insert(games).values({ id: otherGame, userId: u.id, title: "Other" });

    // Seed a YouTube video event under the unified table (NOT tracked_youtube_videos).
    const yt = await createEvent(
      u.id,
      {
        gameId,
        kind: "youtube_video",
        occurredAt: new Date("2026-04-01T12:00:00Z"),
        title: "YT video",
        externalId: "yt-game-1",
      },
      "127.0.0.1",
    );
    const press = await createEvent(
      u.id,
      {
        gameId,
        kind: "press",
        occurredAt: new Date("2026-06-15T09:00:00Z"),
        title: "Press hit",
      },
      "127.0.0.1",
    );
    // Different game — not in the curated view.
    await createEvent(
      u.id,
      {
        gameId: otherGame,
        kind: "talk",
        occurredAt: new Date("2026-05-15T09:00:00Z"),
        title: "Other-game talk",
      },
      "127.0.0.1",
    );

    const tl = await listEventsForGame(u.id, gameId);
    expect(tl).toHaveLength(2);
    const kinds = tl.map((r) => r.kind);
    expect(kinds).toContain("youtube_video");
    expect(kinds).toContain("press");
    // Sorted DESC: press(Jun) → yt(Apr).
    expect(tl[0]!.id).toBe(press.id);
    expect(tl[1]!.id).toBe(yt.id);
  });

  it("EVENTS-02 listEventsForGame cross-tenant gameId throws NotFoundError", async () => {
    const userA = await seedUserDirectly({ email: "ev6a@test.local" });
    const userB = await seedUserDirectly({ email: "ev6b@test.local" });
    const gameB = uuidv7();
    await db.insert(games).values({ id: gameB, userId: userB.id, title: "GB" });

    await expect(listEventsForGame(userA.id, gameB)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("Plan 02.1-09: free-form event with kind=conference and gameId=null lands in inbox view", async () => {
    // Phase 2.1 /events/new free-form path. Free-form events with no game
    // attach drop into the inbox (game_id IS NULL). The unified-table reach
    // means a kind=conference row co-exists with the kind=youtube_video
    // rows of /games/[id] curated views.
    const u = await seedUserDirectly({ email: "ev09a@test.local" });
    const ev = await createEvent(
      u.id,
      {
        gameId: null,
        kind: "conference",
        occurredAt: new Date("2026-06-12T14:00:00Z"),
        title: "GDC 2026 — solo-dev meetup",
      },
      "127.0.0.1",
    );
    expect(ev.kind).toBe("conference");
    expect(ev.gameId).toBeNull();

    // Inbox view (attached=false) surfaces the row.
    const inbox = await listFeedPage(u.id, { attached: false }, null);
    expect(inbox.rows.map((r) => r.id)).toContain(ev.id);
    // The row also shows up in the global feed (no filter).
    const all = await listFeedPage(u.id, {}, null);
    expect(all.rows.map((r) => r.id)).toContain(ev.id);
  });

  it("Plan 02.1-09: free-form event with kind=youtube_video and gameId=:game lands in /games/:id curated view via listEventsForGame", async () => {
    // Phase 2.1 unified-table reach: kind=youtube_video can be created
    // free-form (without going through the paste flow / oEmbed). The /games
    // /[id] curated panel surfaces it via listEventsForGame, which is what
    // Plan 02.1-09's loader fetches. Validates the unified events table is
    // happy serving both paste-flow and free-form youtube_video rows.
    const u = await seedUserDirectly({ email: "ev09b@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "Hades" });

    const ev = await createEvent(
      u.id,
      {
        gameId,
        kind: "youtube_video",
        occurredAt: new Date("2026-04-15T09:00:00Z"),
        title: "IGN Hades 2 Preview",
        url: "https://www.youtube.com/watch?v=community",
        externalId: "yt-community-1",
      },
      "127.0.0.1",
    );

    // Curated view returns the row (replaces Phase 2 listTimelineForGame).
    const curated = await listEventsForGame(u.id, gameId);
    expect(curated.map((r) => r.id)).toContain(ev.id);
    expect(curated.find((r) => r.id === ev.id)?.kind).toBe("youtube_video");
  });

  it("EVENTS-03 audit on edit and delete; soft-delete idempotency", async () => {
    const u = await seedUserDirectly({ email: "ev7@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });
    const ev = await createEvent(
      u.id,
      {
        gameId,
        kind: "talk",
        occurredAt: new Date("2026-05-10T15:00:00Z"),
        title: "Original",
      },
      "127.0.0.1",
    );

    await updateEvent(
      u.id,
      ev.id,
      { title: "Edited", notes: "added notes" },
      "127.0.0.1",
    );
    await softDeleteEvent(u.id, ev.id, "127.0.0.1");

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.userId, u.id));
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("event.created");
    expect(actions).toContain("event.edited");
    expect(actions).toContain("event.deleted");

    const editedEntry = audits.find((a) => a.action === "event.edited");
    const editedMeta = editedEntry?.metadata as
      | { event_id?: string; fields?: string[] }
      | null;
    expect(editedMeta?.event_id).toBe(ev.id);
    expect(editedMeta?.fields).toEqual(expect.arrayContaining(["title", "notes"]));

    // Soft-delete idempotency: a second softDeleteEvent throws.
    await expect(
      softDeleteEvent(u.id, ev.id, "127.0.0.1"),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("02.1-12: createEvent accepts kind='post' and persists round-trip", async () => {
    // Plan 02.1-12 (Gap 12) — generic platform-agnostic kind for Mastodon /
    // LinkedIn / Bluesky / Threads / unmapped platforms. Service must accept
    // the value and round-trip it through SELECT.
    const u = await seedUserDirectly({ email: "ev12post@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });

    const ev = await createEvent(
      u.id,
      {
        gameId,
        kind: "post",
        occurredAt: new Date("2026-04-28T12:00:00Z"),
        title: "Bluesky launch",
      },
      "127.0.0.1",
    );
    expect(ev.kind).toBe("post");

    const [row] = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, u.id), eq(events.id, ev.id)))
      .limit(1);
    expect(row?.kind).toBe("post");
    expect(row?.title).toBe("Bluesky launch");
  });
});
