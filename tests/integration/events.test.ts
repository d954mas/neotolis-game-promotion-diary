import { describe, it, expect, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createEvent,
  updateEvent,
  softDeleteEvent,
  listEventsForGame,
  listFeedPage,
  listDeletedEvents,
  restoreEvent,
  enrichFromUrl,
  VALID_EVENT_KINDS,
} from "../../src/lib/server/services/events.js";
import { db } from "../../src/lib/server/db/client.js";
import { games } from "../../src/lib/server/db/schema/games.js";
import { events, eventKindEnum } from "../../src/lib/server/db/schema/events.js";
import { auditLog } from "../../src/lib/server/db/schema/audit-log.js";
import { env } from "../../src/lib/server/config/env.js";
import { uuidv7 } from "../../src/lib/server/ids.js";
import { seedUserDirectly } from "./helpers.js";
import { AppError, NotFoundError } from "../../src/lib/server/services/errors.js";

/**
 * Unified events service tests.
 *
 * listEventsForGame is the per-game curated view. Three groups of
 * assertions:
 *   - create + the closed-enum kind validation (9 kinds)
 *   - listEventsForGame
 *   - audit on create / update / delete
 *
 * VALID_EVENT_KINDS const list mirrors the pgEnum's enumValues; assert
 * equality so a schema change forces a service update in lock-step.
 */

describe("events CRUD — unified table", () => {
  it("VALID_EVENT_KINDS mirrors the pgEnum eventKindEnum.enumValues exactly", () => {
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
        gameIds: [gameId],
        kind: "conference",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "GDC 2026",
      },
      "127.0.0.1",
    );

    expect(ev.kind).toBe("conference");
    expect(ev.title).toBe("GDC 2026");
    expect(ev.userId).toBe(u.id);
    expect(ev.deletedAt).toBeNull();
    // Defaults.
    expect(ev.authorIsMe).toBe(false);
    expect(ev.sourceId).toBeNull();
    expect(ev.metadata).toEqual({});
    // Junction-based attachment replaces events.gameId. Query event_games
    // to verify the gameId is attached.
    const { eventGames: eg28 } = await import("../../src/lib/server/db/schema/event-games.js");
    const junction1 = await db
      .select()
      .from(eg28)
      .where(and(eq(eg28.userId, u.id), eq(eg28.eventId, ev.id)));
    expect(junction1.map((r) => r.gameId)).toEqual([gameId]);

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
        gameIds: [],
        kind: "youtube_video",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Manual paste",
        externalId: "yt-manual-1",
      },
      "127.0.0.1",
    );
    expect(ev.kind).toBe("youtube_video");
    // The gameId column is gone; "no game attached" === zero junction
    // rows. Surfaces in inbox view via the NOT EXISTS subquery in listFeedPage.

    // Surfaces in attached=false (inbox) view.
    const inbox = await listFeedPage(u.id, { show: { kind: "inbox" } }, null);
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
          gameIds: [gameId],
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

  it("EVENTS-01 create with cross-tenant gameId throws NotFoundError", async () => {
    const userA = await seedUserDirectly({ email: "ev4a@test.local" });
    const userB = await seedUserDirectly({ email: "ev4b@test.local" });
    const gameB = uuidv7();
    await db.insert(games).values({ id: gameB, userId: userB.id, title: "GB" });

    await expect(
      createEvent(
        userA.id,
        {
          gameIds: [gameB],
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

  it("EVENTS-02 listEventsForGame returns events filtered to the game", async () => {
    const u = await seedUserDirectly({ email: "ev5@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });
    const otherGame = uuidv7();
    await db.insert(games).values({ id: otherGame, userId: u.id, title: "Other" });

    // Seed a YouTube video event under the unified table (NOT tracked_youtube_videos).
    const yt = await createEvent(
      u.id,
      {
        gameIds: [gameId],
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
        gameIds: [gameId],
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
        gameIds: [otherGame],
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

    await expect(listEventsForGame(userA.id, gameB)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("free-form event with kind=conference and gameId=null lands in inbox view", async () => {
    // /events/new free-form path. Free-form events with no game
    // attach drop into the inbox (game_id IS NULL). The unified-table reach
    // means a kind=conference row co-exists with the kind=youtube_video
    // rows of /games/[id] curated views.
    const u = await seedUserDirectly({ email: "ev09a@test.local" });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "conference",
        occurredAt: new Date("2026-06-12T14:00:00Z"),
        title: "GDC 2026 — solo-dev meetup",
      },
      "127.0.0.1",
    );
    expect(ev.kind).toBe("conference");
    // The gameId column is gone; inbox criterion is "zero junction rows".

    // Inbox view (attached=false) surfaces the row.
    const inbox = await listFeedPage(u.id, { show: { kind: "inbox" } }, null);
    expect(inbox.rows.map((r) => r.id)).toContain(ev.id);
    // The row also shows up in the global feed (no filter).
    const all = await listFeedPage(u.id, {}, null);
    expect(all.rows.map((r) => r.id)).toContain(ev.id);
  });

  it("free-form event with kind=youtube_video and gameId=:game lands in /games/:id curated view via listEventsForGame", async () => {
    // Unified-table reach: kind=youtube_video can be created free-form
    // (without going through the paste flow / oEmbed). The /games/[id]
    // curated panel surfaces it via listEventsForGame, which is what the
    // loader fetches. Validates the unified events table is happy serving
    // both paste-flow and free-form youtube_video rows.
    const u = await seedUserDirectly({ email: "ev09b@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "Hades" });

    const ev = await createEvent(
      u.id,
      {
        gameIds: [gameId],
        kind: "youtube_video",
        occurredAt: new Date("2026-04-15T09:00:00Z"),
        title: "IGN Hades 2 Preview",
        url: "https://www.youtube.com/watch?v=community",
        externalId: "yt-community-1",
      },
      "127.0.0.1",
    );

    // Curated view returns the row.
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
        gameIds: [gameId],
        kind: "talk",
        occurredAt: new Date("2026-05-10T15:00:00Z"),
        title: "Original",
      },
      "127.0.0.1",
    );

    await updateEvent(u.id, ev.id, { title: "Edited", notes: "added notes" }, "127.0.0.1");
    await softDeleteEvent(u.id, ev.id, "127.0.0.1");

    const audits = await db.select().from(auditLog).where(eq(auditLog.userId, u.id));
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("event.created");
    expect(actions).toContain("event.edited");
    expect(actions).toContain("event.deleted");

    const editedEntry = audits.find((a) => a.action === "event.edited");
    const editedMeta = editedEntry?.metadata as { event_id?: string; fields?: string[] } | null;
    expect(editedMeta?.event_id).toBe(ev.id);
    expect(editedMeta?.fields).toEqual(expect.arrayContaining(["title", "notes"]));

    // Soft-delete idempotency: a second softDeleteEvent throws.
    await expect(softDeleteEvent(u.id, ev.id, "127.0.0.1")).rejects.toBeInstanceOf(AppError);
  });

  it("createEvent accepts kind='post' and persists round-trip", async () => {
    // Generic platform-agnostic kind for Mastodon / LinkedIn / Bluesky /
    // Threads / unmapped platforms. Service must accept the value and
    // round-trip it through SELECT.
    const u = await seedUserDirectly({ email: "ev12post@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });

    const ev = await createEvent(
      u.id,
      {
        gameIds: [gameId],
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

/**
 * Soft-delete event recovery.
 *
 * `confirm_event_delete` promises a 60-day restore window. The service
 * layer is the load-bearing tier: the UPDATE's WHERE clause encodes
 * tenant scoping + retention window + idempotency by construction, so
 * cross-tenant attempts, restore-on-never-deleted, and
 * past-retention-window all collapse to NotFoundError.
 */
describe("event soft-delete recovery", () => {
  it("restore round-trips deletedAt to null and audits event.restored", async () => {
    const u = await seedUserDirectly({ email: "ev14a@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });

    const ev = await createEvent(
      u.id,
      {
        gameIds: [gameId],
        kind: "talk",
        occurredAt: new Date("2026-05-10T15:00:00Z"),
        title: "Restorable talk",
      },
      "127.0.0.1",
    );
    await softDeleteEvent(u.id, ev.id, "127.0.0.1");

    // Sanity: the row IS soft-deleted before restore.
    const [beforeRow] = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, u.id), eq(events.id, ev.id)))
      .limit(1);
    expect(beforeRow?.deletedAt).not.toBeNull();

    const restored = await restoreEvent(u.id, ev.id, "127.0.0.1");
    expect(restored.id).toBe(ev.id);
    expect(restored.deletedAt).toBeNull();

    const [afterRow] = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, u.id), eq(events.id, ev.id)))
      .limit(1);
    expect(afterRow?.deletedAt).toBeNull();

    // Audit chain: event.created → event.deleted → event.restored, in order.
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.userId, u.id))
      .orderBy(auditLog.createdAt);
    const actions = audits.map((a) => a.action);
    // Three or more rows (signin from seed may add session.signin); the three
    // event.* rows must appear in order.
    const eventActions = actions.filter((a) => a.startsWith("event."));
    expect(eventActions).toEqual(["event.created", "event.deleted", "event.restored"]);

    const restoredEntry = audits.find((a) => a.action === "event.restored");
    const restoredMeta = restoredEntry?.metadata as { event_id?: string; kind?: string } | null;
    expect(restoredMeta?.event_id).toBe(ev.id);
    expect(restoredMeta?.kind).toBe("talk");
  });

  it("cross-tenant restore throws NotFoundError", async () => {
    const userA = await seedUserDirectly({ email: "ev14b1@test.local" });
    const userB = await seedUserDirectly({ email: "ev14b2@test.local" });
    const gameA = uuidv7();
    await db.insert(games).values({ id: gameA, userId: userA.id, title: "A" });

    const evA = await createEvent(
      userA.id,
      {
        gameIds: [gameA],
        kind: "press",
        occurredAt: new Date("2026-05-10T15:00:00Z"),
        title: "A's press",
      },
      "127.0.0.1",
    );
    await softDeleteEvent(userA.id, evA.id, "127.0.0.1");

    // userB attempts to restore userA's deleted event — must 404 by construction.
    await expect(restoreEvent(userB.id, evA.id, "127.0.0.1")).rejects.toBeInstanceOf(NotFoundError);

    // A's row remains soft-deleted (NOT silently restored by the cross-tenant call).
    const [row] = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, userA.id), eq(events.id, evA.id)))
      .limit(1);
    expect(row?.deletedAt).not.toBeNull();
  });

  it("02.1-14: restore on never-deleted event throws NotFoundError", async () => {
    const u = await seedUserDirectly({ email: "ev14c@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });

    const ev = await createEvent(
      u.id,
      {
        gameIds: [gameId],
        kind: "conference",
        occurredAt: new Date("2026-05-10T15:00:00Z"),
        title: "Live",
      },
      "127.0.0.1",
    );

    // The event was never soft-deleted — restore is a no-op-as-NotFoundError
    // (idempotency: not-yet-deleted == not findable in the deleted-events scope).
    await expect(restoreEvent(u.id, ev.id, "127.0.0.1")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("02.1-14: restore on past-retention-window event throws NotFoundError", async () => {
    const u = await seedUserDirectly({ email: "ev14d@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });

    const expiredEventId = uuidv7();
    const pastDeleted = new Date(Date.now() - (env.RETENTION_DAYS + 1) * 86_400_000);
    // Direct INSERT with a deleted_at older than the retention window.
    await db.insert(events).values({
      id: expiredEventId,
      userId: u.id,
      kind: "talk",
      title: "Past retention",
      occurredAt: pastDeleted,
      deletedAt: pastDeleted,
    });

    // Past-retention rows are pending purge; restore returns 404
    // (same null-result semantics as cross-tenant / never-deleted).
    await expect(restoreEvent(u.id, expiredEventId, "127.0.0.1")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("listDeletedEvents returns recent soft-deletes only, tenant-scoped", async () => {
    const userA = await seedUserDirectly({ email: "ev14e1@test.local" });
    const userB = await seedUserDirectly({ email: "ev14e2@test.local" });
    const gameA = uuidv7();
    await db.insert(games).values({ id: gameA, userId: userA.id, title: "A" });

    // Two recent deletes for userA.
    const recent1 = await createEvent(
      userA.id,
      {
        gameIds: [gameA],
        kind: "talk",
        occurredAt: new Date("2026-05-10T15:00:00Z"),
        title: "Recent 1",
      },
      "127.0.0.1",
    );
    await softDeleteEvent(userA.id, recent1.id, "127.0.0.1");
    const recent2 = await createEvent(
      userA.id,
      {
        gameIds: [gameA],
        kind: "press",
        occurredAt: new Date("2026-05-11T15:00:00Z"),
        title: "Recent 2",
      },
      "127.0.0.1",
    );
    await softDeleteEvent(userA.id, recent2.id, "127.0.0.1");

    // One past-retention soft-delete for userA — should NOT surface.
    const expiredId = uuidv7();
    const past = new Date(Date.now() - (env.RETENTION_DAYS + 1) * 86_400_000);
    await db.insert(events).values({
      id: expiredId,
      userId: userA.id,
      kind: "other",
      title: "Past retention",
      occurredAt: past,
      deletedAt: past,
    });

    // One live (non-deleted) event for userA — should NOT surface.
    await createEvent(
      userA.id,
      {
        gameIds: [gameA],
        kind: "conference",
        occurredAt: new Date("2026-05-12T15:00:00Z"),
        title: "Live",
      },
      "127.0.0.1",
    );

    // userB has their own recent soft-delete — must NOT appear in userA's list.
    const gameB = uuidv7();
    await db.insert(games).values({ id: gameB, userId: userB.id, title: "B" });
    const userBEvent = await createEvent(
      userB.id,
      {
        gameIds: [gameB],
        kind: "talk",
        occurredAt: new Date("2026-05-10T15:00:00Z"),
        title: "B's talk",
      },
      "127.0.0.1",
    );
    await softDeleteEvent(userB.id, userBEvent.id, "127.0.0.1");

    const aDeleted = await listDeletedEvents(userA.id);
    const aIds = aDeleted.map((r) => r.id);

    // Tenant scoping: userB's event MUST NOT appear in userA's list.
    expect(aIds).not.toContain(userBEvent.id);
    // Retention window: past-retention row MUST NOT appear.
    expect(aIds).not.toContain(expiredId);
    // Recent soft-deletes appear.
    expect(aIds).toContain(recent1.id);
    expect(aIds).toContain(recent2.id);
    // Sorted by deletedAt DESC — recent2 was deleted second, so it comes first.
    const idx1 = aIds.indexOf(recent1.id);
    const idx2 = aIds.indexOf(recent2.id);
    expect(idx2).toBeLessThan(idx1);

    // Cross-tenant call construction: userB sees their own event, never userA's.
    const bDeleted = await listDeletedEvents(userB.id);
    const bIds = bDeleted.map((r) => r.id);
    expect(bIds).toContain(userBEvent.id);
    expect(bIds).not.toContain(recent1.id);
    expect(bIds).not.toContain(recent2.id);
  });
});

/**
 * HTTP-boundary tests for the restore + deleted-list routes. The
 * service-layer tests above prove the contract; these tests confirm the
 * wire-format projection (toEventDto strips userId, deletedAt round-trips
 * to null on restore, cross-tenant returns 404).
 */
describe("event soft-delete recovery routes", () => {
  it("authenticated PATCH /api/events/:id/restore returns 200 + EventDto with deletedAt: null", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "ev14r1@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });

    const ev = await createEvent(
      u.id,
      {
        gameIds: [gameId],
        kind: "talk",
        occurredAt: new Date("2026-05-10T15:00:00Z"),
        title: "HTTP restore round-trip",
      },
      "127.0.0.1",
    );
    await softDeleteEvent(u.id, ev.id, "127.0.0.1");

    const res = await app.request(`/api/events/${ev.id}/restore`, {
      method: "PATCH",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(ev.id);
    expect(body.deletedAt).toBeNull();
    // DTO discipline: userId MUST NOT cross the wire.
    expect(body).not.toHaveProperty("userId");
  });

  it("authenticated GET /api/events/deleted returns {rows: EventDto[]} scoped to RETENTION_DAYS", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "ev14r2@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });

    const recent = await createEvent(
      u.id,
      {
        gameIds: [gameId],
        kind: "talk",
        occurredAt: new Date("2026-05-10T15:00:00Z"),
        title: "Recent deleted",
      },
      "127.0.0.1",
    );
    await softDeleteEvent(u.id, recent.id, "127.0.0.1");

    // Past-retention row — should NOT surface in the list.
    const expiredId = uuidv7();
    const past = new Date(Date.now() - (env.RETENTION_DAYS + 1) * 86_400_000);
    await db.insert(events).values({
      id: expiredId,
      userId: u.id,
      kind: "press",
      title: "Past retention",
      occurredAt: past,
      deletedAt: past,
    });

    const res = await app.request("/api/events/deleted", {
      method: "GET",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ id: string; deletedAt: string | null }>;
    };
    const ids = body.rows.map((r) => r.id);
    expect(ids).toContain(recent.id);
    expect(ids).not.toContain(expiredId);
    // DTO discipline: every row carries deletedAt (kept by toEventDto for the
    // restore UI's RetentionBadge), but no userId.
    for (const row of body.rows) {
      expect(row).not.toHaveProperty("userId");
      expect(row.deletedAt).not.toBeNull();
    }
  });
});

/**
 * createEvent kind-aware enrichment + enrichFromUrl helper.
 *
 * The manual-create path (POST /api/events with kind=youtube_video + url)
 * parses the URL and persists the canonical YouTube videoId so FeedCard
 * thumbnails render end-to-end. Idempotent: explicit input.externalId
 * wins.
 *
 * enrichFromUrl is the shared helper backing POST /api/events/preview-url
 * — pure URL parse + oEmbed fetch, no DB write.
 */
describe("createEvent kind-aware enrichment", () => {
  // Parallel-execution coordination: random suffixes on test emails avoid
  // unique-key collisions when parallel test agents reach this DB between
  // our truncate and our insert.
  const uniq = () => Math.random().toString(36).slice(2, 10);

  it("createEvent kind=youtube_video + url derives external_id from canonical YouTube videoId", async () => {
    const u = await seedUserDirectly({ email: `ev17t1-${uniq()}@test.local` });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "youtube_video",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        title: "any",
        occurredAt: new Date("2026-04-28T12:00:00Z"),
      },
      "127.0.0.1",
    );
    expect(ev.externalId).toBe("dQw4w9WgXcQ");
    expect(ev.kind).toBe("youtube_video");
  });

  it("explicit input.externalId overrides URL-parsed value (caller wins)", async () => {
    const u = await seedUserDirectly({ email: `ev17t2-${uniq()}@test.local` });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "youtube_video",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        externalId: "ABC123EXPLI",
        title: "any",
        occurredAt: new Date("2026-04-28T12:00:00Z"),
      },
      "127.0.0.1",
    );
    expect(ev.externalId).toBe("ABC123EXPLI");
  });

  it("kind=youtube_video with null url leaves external_id NULL (route-layer catches the missing url; service is opportunistic)", async () => {
    const u = await seedUserDirectly({ email: `ev17t3-${uniq()}@test.local` });
    // Service-layer is opportunistic — the route-layer superRefine catches the
    // missing-url case BEFORE service is called. Direct service call without
    // url leaves externalId null.
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "youtube_video",
        url: null,
        title: "manual-no-url",
        occurredAt: new Date("2026-04-28T12:00:00Z"),
      },
      "127.0.0.1",
    );
    expect(ev.externalId).toBeNull();
  });

  it("kind=conference + YouTube URL does NOT set external_id (parsing only fires for kind=youtube_video)", async () => {
    const u = await seedUserDirectly({ email: `ev17t4-${uniq()}@test.local` });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "conference",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        title: "GDC stream",
        occurredAt: new Date("2026-04-28T12:00:00Z"),
      },
      "127.0.0.1",
    );
    expect(ev.externalId).toBeNull();
  });

  it("enrichFromUrl returns full enrichment shape for YouTube URL (no DB write)", async () => {
    const u = await seedUserDirectly({ email: `ev17t5-${uniq()}@test.local` });

    // Mock the oEmbed fetch — same pattern as the paste-flow tests.
    const youtubeOembed = await import("../../src/lib/server/integrations/youtube-oembed.js");
    const spy = vi.spyOn(youtubeOembed, "fetchYoutubeOembed").mockResolvedValue({
      kind: "ok",
      data: {
        title: "Never Gonna Give You Up",
        authorName: "Rick Astley",
        authorUrl: "https://www.youtube.com/@RickAstleyYT",
        thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      },
    });

    try {
      const result = await enrichFromUrl(u.id, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
      expect(result.kind).toBe("youtube_video");
      expect(result.externalId).toBe("dQw4w9WgXcQ");
      expect(result.title).toBe("Never Gonna Give You Up");
      expect(result.thumbnailUrl).toBe("https://img.youtube.com/vi/dQw4w9WgXcQ/mqdefault.jpg");
      expect(result.occurredAt).toBeNull(); // Filled later via YouTube Data API key

      // No event row written.
      const rows = await db.select().from(events).where(eq(events.userId, u.id));
      expect(rows).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("enrichFromUrl with garbage URL throws AppError 'unsupported_url' 422", async () => {
    const u = await seedUserDirectly({ email: `ev17t6-${uniq()}@test.local` });
    await expect(enrichFromUrl(u.id, "not-a-url-at-all")).rejects.toMatchObject({
      code: "unsupported_url",
      status: 422,
    });
  });
});

// Feed UX: discriminated 'show' axis URL contract. Backend FeedFilters
// collapse the legacy `attached?: boolean` + `game?: string | string[]`
// into a single `show: ShowFilter` discriminator. HTTP query-string is
// ?show=any|inbox|specific&game=A&game=B.
describe("?show=any|inbox|specific URL contract over /api/events", () => {
  it("GET /api/events?show=any returns ALL rows for that user (default)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "ev19-a@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });
    const attached = await createEvent(
      u.id,
      {
        gameIds: [gameId],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Attached",
      },
      "127.0.0.1",
    );
    const inbox = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-02T10:00:00Z"),
        title: "Inbox",
      },
      "127.0.0.1",
    );

    const res = await app.request("/api/events?show=any", {
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    const ids = body.rows.map((r) => r.id);
    expect(ids).toContain(attached.id);
    expect(ids).toContain(inbox.id);
  });

  it("GET /api/events?show=inbox returns ONLY inbox rows (game_id IS NULL AND not dismissed)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "ev19-b@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });
    await createEvent(
      u.id,
      {
        gameIds: [gameId],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Attached",
      },
      "127.0.0.1",
    );
    const inbox = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-02T10:00:00Z"),
        title: "Inbox active",
      },
      "127.0.0.1",
    );
    const dismissed = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-03T10:00:00Z"),
        title: "Dismissed",
        metadata: { inbox: { dismissed: true } },
      },
      "127.0.0.1",
    );

    const res = await app.request("/api/events?show=inbox", {
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ id: string; gameIds: string[] }>;
    };
    const ids = body.rows.map((r) => r.id);
    expect(ids).toContain(inbox.id);
    expect(ids).not.toContain(dismissed.id);
    // Inbox events have ZERO junction rows; the EventDto surfaces this
    // via gameIds: [].
    expect(body.rows.every((r) => r.gameIds.length === 0)).toBe(true);
  });

  it("GET /api/events?show=specific&game=A&game=B returns rows attached to A or B", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "ev19-c@test.local" });
    const gA = uuidv7();
    const gB = uuidv7();
    const gC = uuidv7();
    await db.insert(games).values({ id: gA, userId: u.id, title: "A" });
    await db.insert(games).values({ id: gB, userId: u.id, title: "B" });
    await db.insert(games).values({ id: gC, userId: u.id, title: "C" });
    const evA = await createEvent(
      u.id,
      {
        gameIds: [gA],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "A",
      },
      "127.0.0.1",
    );
    const evB = await createEvent(
      u.id,
      {
        gameIds: [gB],
        kind: "press",
        occurredAt: new Date("2026-06-02T10:00:00Z"),
        title: "B",
      },
      "127.0.0.1",
    );
    const evC = await createEvent(
      u.id,
      {
        gameIds: [gC],
        kind: "press",
        occurredAt: new Date("2026-06-03T10:00:00Z"),
        title: "C",
      },
      "127.0.0.1",
    );

    const res = await app.request(`/api/events?show=specific&game=${gA}&game=${gB}`, {
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    const ids = body.rows.map((r) => r.id);
    expect(ids).toContain(evA.id);
    expect(ids).toContain(evB.id);
    expect(ids).not.toContain(evC.id);
  });

  it("GET /api/events with no ?show param defaults to 'any' (returns all rows)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "ev19-d@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });
    const attached = await createEvent(
      u.id,
      {
        gameIds: [gameId],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Attached",
      },
      "127.0.0.1",
    );
    const inbox = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-02T10:00:00Z"),
        title: "Inbox",
      },
      "127.0.0.1",
    );

    const res = await app.request("/api/events", {
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    const ids = body.rows.map((r) => r.id);
    expect(ids).toContain(attached.id);
    expect(ids).toContain(inbox.id);
  });

  it("GET /api/events?show=garbage returns 422 validation_failed (zod enum)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "ev19-e@test.local" });
    const res = await app.request("/api/events?show=garbage", {
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("validation_failed");
  });

  it("GET /api/events?game=X with no ?show treats as 'any' (bare ?game without ?show=specific is ignored)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "ev19-f@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });
    const attached = await createEvent(
      u.id,
      {
        gameIds: [gameId],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Attached",
      },
      "127.0.0.1",
    );
    const inbox = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-02T10:00:00Z"),
        title: "Inbox",
      },
      "127.0.0.1",
    );

    // Bare ?game=X without ?show=specific is ignored — server treats this
    // as ?show=any. The UI never produces this combo.
    const res = await app.request(`/api/events?game=${gameId}`, {
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    const ids = body.rows.map((r) => r.id);
    expect(ids).toContain(attached.id);
    expect(ids).toContain(inbox.id);
  });
});

/**
 * createEventSchema authorIsMe + url-required-for-youtube superRefine;
 * POST /api/events/preview-url endpoint.
 *
 * The 12 test cases assert the HTTP-boundary contract for
 * "kind=youtube_video → url required validation", "author_is_me toggle
 * restoration on backend", and "POST /api/events/preview-url". The
 * service-layer contract is already covered above.
 */
describe("createEventSchema + preview-url", () => {
  // Same parallel-execution coordination pattern as above.
  const uniq = () => Math.random().toString(36).slice(2, 10);

  it("POST /api/events kind=youtube_video + url=null → 422 'validation_failed' field='url'", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `ev17t2t1-${uniq()}@test.local` });

    const res = await app.request("/api/events", {
      method: "POST",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "youtube_video",
        url: null,
        title: "x",
        occurredAt: "2026-04-28T12:00:00.000Z",
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: string;
      details: Array<{ path: string[] }>;
    };
    expect(body.error).toBe("validation_failed");
    // superRefine attaches the issue to path: ["url"].
    const fields = body.details.map((d) => d.path?.[0]);
    expect(fields).toContain("url");
  });

  it("POST /api/events kind=youtube_video + non-YouTube url → 422 'validation_failed'", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `ev17t2t2-${uniq()}@test.local` });

    const res = await app.request("/api/events", {
      method: "POST",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "youtube_video",
        url: "https://example.com/not-a-youtube-url",
        title: "x",
        occurredAt: "2026-04-28T12:00:00.000Z",
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation_failed");
  });

  it("POST /api/events kind=youtube_video + valid YouTube url → 201 + body.externalId set", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `ev17t2t3-${uniq()}@test.local` });

    const res = await app.request("/api/events", {
      method: "POST",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "youtube_video",
        url: "https://www.youtube.com/watch?v=ABCDEFGHIJK",
        title: "x",
        occurredAt: "2026-04-28T12:00:00.000Z",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { externalId: string };
    expect(body.externalId).toBe("ABCDEFGHIJK");
  });

  it("POST /api/events kind=post + url=null → 201 (kind-aware rule fires only for youtube_video)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `ev17t2t4-${uniq()}@test.local` });

    const res = await app.request("/api/events", {
      method: "POST",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "post",
        url: null,
        title: "Bluesky launch",
        occurredAt: "2026-04-28T12:00:00.000Z",
      }),
    });
    expect(res.status).toBe(201);
  });

  it("POST /api/events with authorIsMe=true → 201 + body.authorIsMe===true (round-trip)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `ev17t2t5-${uniq()}@test.local` });

    const res = await app.request("/api/events", {
      method: "POST",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "conference",
        title: "GDC 2026",
        occurredAt: "2026-04-28T12:00:00.000Z",
        authorIsMe: true,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { authorIsMe: boolean };
    expect(body.authorIsMe).toBe(true);
  });

  it("POST /api/events without authorIsMe → 201 + body.authorIsMe===false (default)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `ev17t2t6-${uniq()}@test.local` });

    const res = await app.request("/api/events", {
      method: "POST",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "conference",
        title: "GDC 2026",
        occurredAt: "2026-04-28T12:00:00.000Z",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { authorIsMe: boolean };
    expect(body.authorIsMe).toBe(false);
  });

  it("POST /api/events/preview-url with valid YouTube URL → 200 + enrichment shape", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `ev17t2t7-${uniq()}@test.local` });

    // Mock the oEmbed fetch — same pattern as paste-flow tests.
    const youtubeOembed = await import("../../src/lib/server/integrations/youtube-oembed.js");
    const spy = vi.spyOn(youtubeOembed, "fetchYoutubeOembed").mockResolvedValue({
      kind: "ok",
      data: {
        title: "Never Gonna Give You Up",
        authorName: "Rick Astley",
        authorUrl: "https://www.youtube.com/@RickAstleyYT",
        thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      },
    });

    try {
      const res = await app.request("/api/events/preview-url", {
        method: "POST",
        headers: {
          cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        kind: string;
        externalId: string;
        title: string;
        thumbnailUrl: string;
        occurredAt: string | null;
      };
      expect(body.kind).toBe("youtube_video");
      expect(body.externalId).toBe("dQw4w9WgXcQ");
      expect(body.title).toBe("Never Gonna Give You Up");
      expect(body.thumbnailUrl).toBe("https://img.youtube.com/vi/dQw4w9WgXcQ/mqdefault.jpg");
      expect(body.occurredAt).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("POST /api/events/preview-url with garbage URL → 422 'unsupported_url'", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `ev17t2t8-${uniq()}@test.local` });

    const res = await app.request("/api/events/preview-url", {
      method: "POST",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ url: "https://example.com/not-supported" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unsupported_url");
  });

  it("anonymous POST /api/events/preview-url → 401 unauthorized (sweep complement)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();

    const res = await app.request("/api/events/preview-url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("POST /api/events/preview-url is read-only — both userA and userB get same shape from same URL", async () => {
    // /api/events/preview-url is read-only — pure URL parse + oEmbed fetch.
    // No tenant-owned data is read. Cross-tenant invariant: both users get
    // the same enrichment shape from the same URL.
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const userA = await seedUserDirectly({ email: `ev17t2t10a-${uniq()}@test.local` });
    const userB = await seedUserDirectly({ email: `ev17t2t10b-${uniq()}@test.local` });

    const youtubeOembed = await import("../../src/lib/server/integrations/youtube-oembed.js");
    const spy = vi.spyOn(youtubeOembed, "fetchYoutubeOembed").mockResolvedValue({
      kind: "ok",
      data: {
        title: "Cross-tenant test",
        authorName: "Author",
        authorUrl: "",
        thumbnailUrl: "",
      },
    });

    try {
      const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

      const resA = await app.request("/api/events/preview-url", {
        method: "POST",
        headers: {
          cookie: `neotolis.session_token=${userA.signedSessionCookieValue}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url }),
      });
      expect(resA.status).toBe(200);
      const bodyA = (await resA.json()) as {
        kind: string;
        externalId: string;
        title: string;
      };

      const resB = await app.request("/api/events/preview-url", {
        method: "POST",
        headers: {
          cookie: `neotolis.session_token=${userB.signedSessionCookieValue}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url }),
      });
      expect(resB.status).toBe(200);
      const bodyB = (await resB.json()) as {
        kind: string;
        externalId: string;
        title: string;
      };

      // Same URL → same enrichment shape (no tenant-owned data is touched).
      expect(bodyA.externalId).toBe(bodyB.externalId);
      expect(bodyA.kind).toBe(bodyB.kind);
      expect(bodyA.title).toBe(bodyB.title);
    } finally {
      spy.mockRestore();
    }
  });

  it("PATCH /api/events/:id with authorIsMe=true → 200 + body.authorIsMe===true (updateEventSchema round-trip)", async () => {
    // Without this test, partial-ship risk is real (createEventSchema
    // gets authorIsMe but updateEventSchema silently doesn't, edit form
    // fails at runtime). The edit form depends on this contract.
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `ev17t2t11-${uniq()}@test.local` });

    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "conference",
        occurredAt: new Date("2026-04-28T12:00:00Z"),
        title: "Initial",
      },
      "127.0.0.1",
    );
    expect(ev.authorIsMe).toBe(false);

    const res = await app.request(`/api/events/${ev.id}`, {
      method: "PATCH",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ authorIsMe: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorIsMe: boolean };
    expect(body.authorIsMe).toBe(true);
  });

  it("PATCH /api/events/:id changing kind=youtube_video without url → 422 'kind_url_inconsistent'", async () => {
    // Catches a kind-change PATCH that drops the url. The validator
    // lives in the service layer (merged-state check). The error is
    // `{error: 'kind_url_inconsistent', metadata}` with status 422. This
    // kind-change PATCH (kind=youtube_video, url=null) on a row whose
    // existing url is null falls into the youtube_video_requires_url
    // branch.
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `ev17t2t12-${uniq()}@test.local` });

    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "conference",
        occurredAt: new Date("2026-04-28T12:00:00Z"),
        title: "Was a conference",
      },
      "127.0.0.1",
    );

    const res = await app.request(`/api/events/${ev.id}`, {
      method: "PATCH",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ kind: "youtube_video", url: null }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: string;
      metadata?: { reason?: string };
    };
    expect(body.error).toBe("kind_url_inconsistent");
    expect(body.metadata?.reason).toBe("youtube_video_requires_url");
  });
});

/**
 * Edit-flow via /events/[id] detail page.
 *
 * Service-layer + HTTP-boundary tests for:
 *   - getEventById opts.includeSoftDeleted toggle (Restore flow needs to
 *     surface soft-deleted rows; default behavior unchanged for existing
 *     callers; cross-tenant scope MUST NOT relax under the opts flag)
 *   - PATCH /api/events/:id round-trips authorIsMe through
 *     updateEventSchema + service-layer updateEvent patch builder
 */
describe("detail loader + edit + author_is_me round-trip", () => {
  // Same parallel-execution coordination pattern as above.
  const uniq = () => Math.random().toString(36).slice(2, 10);

  it("getEventById opts.includeSoftDeleted=true returns soft-deleted row", async () => {
    const { getEventById } = await import("../../src/lib/server/services/events.js");
    const u = await seedUserDirectly({ email: `ev18t1-${uniq()}@test.local` });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "conference",
        occurredAt: new Date("2026-04-28T12:00:00Z"),
        title: "Event soon to be soft-deleted",
      },
      "127.0.0.1",
    );
    await softDeleteEvent(u.id, ev.id, "127.0.0.1");

    // Default behavior: throws NotFoundError on soft-deleted rows.
    await expect(getEventById(u.id, ev.id)).rejects.toBeInstanceOf(NotFoundError);
    // Opt-in surfaces the soft-deleted row.
    const row = await getEventById(u.id, ev.id, { includeSoftDeleted: true });
    expect(row.id).toBe(ev.id);
    expect(row.deletedAt).not.toBeNull();
  });

  it("getEventById opts.includeSoftDeleted=true cross-tenant still throws NotFoundError", async () => {
    // The opts flag MUST NOT bypass the userId WHERE clause. Privacy
    // invariants are encoded by query construction, not by the opts.
    const { getEventById } = await import("../../src/lib/server/services/events.js");
    const a = await seedUserDirectly({ email: `ev18t2a-${uniq()}@test.local` });
    const b = await seedUserDirectly({ email: `ev18t2b-${uniq()}@test.local` });
    const ev = await createEvent(
      a.id,
      {
        gameIds: [],
        kind: "conference",
        occurredAt: new Date("2026-04-28T12:00:00Z"),
        title: "User A's event",
      },
      "127.0.0.1",
    );
    await softDeleteEvent(a.id, ev.id, "127.0.0.1");

    // User B asks for user A's row with includeSoftDeleted=true: still 404.
    await expect(getEventById(b.id, ev.id, { includeSoftDeleted: true })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("PATCH /api/events/:id { authorIsMe: true } persists author_is_me=true on the row", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `ev18t3-${uniq()}@test.local` });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "conference",
        occurredAt: new Date("2026-04-28T12:00:00Z"),
        title: "Conference notes",
        authorIsMe: false,
      },
      "127.0.0.1",
    );
    expect(ev.authorIsMe).toBe(false);

    const res = await app.request(`/api/events/${ev.id}`, {
      method: "PATCH",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ authorIsMe: true }),
    });
    expect(res.status).toBe(200);

    // Verify the row in the DB carries the new value (not just the response).
    const [row] = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, u.id), eq(events.id, ev.id)))
      .limit(1);
    expect(row?.authorIsMe).toBe(true);
  });

  it("PATCH /api/events/:id authorIsMe round-trips: response body matches request", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `ev18t4-${uniq()}@test.local` });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "talk",
        occurredAt: new Date("2026-04-28T12:00:00Z"),
        title: "My GDC talk",
        authorIsMe: false,
      },
      "127.0.0.1",
    );

    const res = await app.request(`/api/events/${ev.id}`, {
      method: "PATCH",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ authorIsMe: true, title: "My GDC talk (revised)" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorIsMe: boolean; title: string };
    expect(body.authorIsMe).toBe(true);
    expect(body.title).toBe("My GDC talk (revised)");
  });
});

/**
 * createEvent / updateEvent gameIds[] semantics.
 *
 * Events relate to ZERO-or-MORE games via the event_games junction;
 * gameIds=[] === inbox; non-empty gameIds[] populates one junction row
 * per id; updateEvent.gameIds is a SET-replacement (not an additive
 * append) per attachEventToGames diff semantics.
 */
describe("M:N gameIds", () => {
  // Parallel-execution coordination: random suffix on test emails avoids
  // unique-key collisions when sibling agents hit the same DB between
  // truncate cycles (see top of file).
  const uniq = () => Math.random().toString(36).slice(2, 10);

  it("createEvent with gameIds=[A, B] populates 2 event_games rows + audit metadata.game_ids matches", async () => {
    const { eventGames: eg } = await import("../../src/lib/server/db/schema/event-games.js");
    const u = await seedUserDirectly({ email: `ev28-create-multi-${uniq()}@test.local` });
    const gA = uuidv7();
    const gB = uuidv7();
    await db.insert(games).values({ id: gA, userId: u.id, title: "A" });
    await db.insert(games).values({ id: gB, userId: u.id, title: "B" });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [gA, gB],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "M:N create",
      },
      "127.0.0.1",
    );

    const junction = await db
      .select({ gameId: eg.gameId })
      .from(eg)
      .where(and(eq(eg.userId, u.id), eq(eg.eventId, ev.id)));
    const gids = junction.map((r) => r.gameId).sort();
    expect(gids).toEqual([gA, gB].sort());

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, "event.created")));
    const meta = audits[0]!.metadata as { game_ids?: string[] } | null;
    expect((meta?.game_ids ?? []).sort()).toEqual([gA, gB].sort());
  });

  it("createEvent with no gameIds creates event in inbox (zero junction rows)", async () => {
    const { eventGames: eg } = await import("../../src/lib/server/db/schema/event-games.js");
    const u = await seedUserDirectly({ email: `ev28-create-inbox-${uniq()}@test.local` });
    const ev = await createEvent(
      u.id,
      {
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Inbox via omission",
      },
      "127.0.0.1",
    );
    const junction = await db
      .select()
      .from(eg)
      .where(and(eq(eg.userId, u.id), eq(eg.eventId, ev.id)));
    expect(junction).toHaveLength(0);
  });

  it("createEvent with cross-tenant gameId throws NotFoundError; events row NOT inserted (validate-first)", async () => {
    const u1 = uniq();
    const u2 = uniq();
    const userA = await seedUserDirectly({ email: `ev28-create-xt-a-${u1}@test.local` });
    const userB = await seedUserDirectly({ email: `ev28-create-xt-b-${u2}@test.local` });
    const gB = uuidv7();
    await db.insert(games).values({ id: gB, userId: userB.id, title: "B's game" });

    await expect(
      createEvent(
        userA.id,
        {
          gameIds: [gB],
          kind: "press",
          occurredAt: new Date(),
          title: "Should not insert",
        },
        "127.0.0.1",
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    // No row written — validate-first invariant.
    const rowsA = await db.select().from(events).where(eq(events.userId, userA.id));
    expect(rowsA).toHaveLength(0);
  });

  it("updateEvent.gameIds replaces the attached set atomically (set-replacement)", async () => {
    const { eventGames: eg } = await import("../../src/lib/server/db/schema/event-games.js");
    const u = await seedUserDirectly({ email: `ev28-update-replace-${uniq()}@test.local` });
    const gA = uuidv7();
    const gB = uuidv7();
    await db.insert(games).values({ id: gA, userId: u.id, title: "A" });
    await db.insert(games).values({ id: gB, userId: u.id, title: "B" });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [gA],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Replace test",
      },
      "127.0.0.1",
    );
    // Sanity: junction has [A].
    const before = await db
      .select({ gameId: eg.gameId })
      .from(eg)
      .where(and(eq(eg.userId, u.id), eq(eg.eventId, ev.id)));
    expect(before.map((r) => r.gameId)).toEqual([gA]);

    // Replace [A] → [B] via updateEvent.
    await updateEvent(u.id, ev.id, { gameIds: [gB] }, "127.0.0.1");

    const after = await db
      .select({ gameId: eg.gameId })
      .from(eg)
      .where(and(eq(eg.userId, u.id), eq(eg.eventId, ev.id)));
    expect(after.map((r) => r.gameId)).toEqual([gB]);

    // Audit chain: createEvent writes ONE attached_to_game(A) audit row
    // (createEvent issues the audit per-junction-row when it inserts the
    // initial set; updateEvent → attachEventToGames then writes
    // attached_to_game(B) + detached_from_game(A) for the diff).
    // Note: createEvent inserts the junction directly (no
    // attachEventToGames roundtrip), so the initial audit is from
    // createEvent's writeAudit({ action: 'event.created', metadata:
    // { game_ids: [...] } }) — NOT a per-game attached_to_game row.
    // So adds === 1 (from updateEvent only) and removes === 1 (the diff).
    const adds = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, "event.attached_to_game")));
    const removes = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, "event.detached_from_game")));
    expect(adds.length).toBeGreaterThanOrEqual(1);
    expect(removes.length).toBeGreaterThanOrEqual(1);
    const addedIds = adds.map((r) => (r.metadata as { game_id?: string } | null)?.game_id);
    expect(addedIds).toContain(gB);
    const removedIds = removes.map((r) => (r.metadata as { game_id?: string } | null)?.game_id);
    expect(removedIds).toContain(gA);
  });
});

/**
 * /events/[id]/edit standalone toggle round-trip.
 *
 * Asserts the round-trip behavior the form relies on:
 *   1. PATCH /api/events/:id (main fields) followed by PATCH
 *      /api/events/:id/mark-standalone reaches the desired state
 *      (metadata.triage.standalone === true) AND writes both audit verbs
 *      in order (event.edited, event.marked_standalone).
 *   2. PATCH /api/events/:id/mark-standalone on an event with attached
 *      games returns 422 standalone_conflicts_with_game (defense-in-depth
 *      mirror of the events-attach.test.ts coverage).
 *   3. DELETE /api/events/:id soft-deletes the event; subsequent GET
 *      returns 404 (default loader excludes soft-deleted rows). The
 *      Delete button lives at the /events/[id]/edit form footer.
 */
describe("/events/[id]/edit standalone toggle round-trip", () => {
  // Parallel-executor email-uniqueness coordination:
  const uniq = () => Math.random().toString(36).slice(2, 10);

  it("PATCH /api/events/:id then PATCH /api/events/:id/mark-standalone reaches metadata.triage.standalone=true + audit chain", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `ev32-roundtrip-${uniq()}@test.local` });

    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Round-trip seed",
      },
      "127.0.0.1",
    );

    // Step 1: PATCH the main fields (mirrors the edit-form's first fetch).
    const patchRes = await app.request(`/api/events/${ev.id}`, {
      method: "PATCH",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "press",
        title: "Round-trip after edit",
        occurredAt: new Date("2026-06-02T10:00:00Z").toISOString(),
        url: null,
        notes: null,
        authorIsMe: true,
      }),
    });
    expect(patchRes.status).toBe(200);

    // Step 2: PATCH /mark-standalone (the dedicated route the edit-form's
    // submit handler calls when the standalone toggle differs from loaded).
    const standaloneRes = await app.request(`/api/events/${ev.id}/mark-standalone`, {
      method: "PATCH",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
      },
    });
    expect(standaloneRes.status).toBe(200);
    const standaloneBody = (await standaloneRes.json()) as {
      id: string;
      metadata: { triage?: { standalone?: boolean } } | null;
    };
    expect(standaloneBody.metadata?.triage?.standalone).toBe(true);

    // Audit chain: event.edited (from the PATCH) then event.marked_standalone.
    const audits = await db.select().from(auditLog).where(eq(auditLog.userId, u.id));
    const actions = audits.map((r) => r.action);
    expect(actions).toContain("event.edited");
    expect(actions).toContain("event.marked_standalone");
  });

  it("PATCH /api/events/:id/mark-standalone on event with attached games returns 422 standalone_conflicts_with_game (defense-in-depth)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `ev32-conflict-${uniq()}@test.local` });
    const gA = uuidv7();
    await db.insert(games).values({ id: gA, userId: u.id, title: "A" });

    const ev = await createEvent(
      u.id,
      {
        gameIds: [gA],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Cannot go standalone",
      },
      "127.0.0.1",
    );

    const res = await app.request(`/api/events/${ev.id}/mark-standalone`, {
      method: "PATCH",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("standalone_conflicts_with_game");
  });

  it("DELETE /api/events/:id soft-deletes; subsequent GET /api/events/:id returns 404", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `ev32-delete-${uniq()}@test.local` });

    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "To be deleted from edit footer",
      },
      "127.0.0.1",
    );

    const delRes = await app.request(`/api/events/${ev.id}`, {
      method: "DELETE",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect([200, 204]).toContain(delRes.status);

    // Default GET excludes soft-deleted rows → 404.
    const getRes = await app.request(`/api/events/${ev.id}`, {
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(getRes.status).toBe(404);
  });
});

/**
 * Transactional integrity + inbox.dismissed clear.
 *
 * Asserted behavior:
 * 1. createEvent rolls back the parent events row when the junction INSERT
 *    throws (no orphan parent).
 * 2. attachEventToGames clears `metadata.inbox.dismissed` on any junction
 *    diff (attach OR detach) so the event re-engages with the inbox
 *    triage flow.
 * 3. attachEventToGames preserves metadata on a no-op call (toAdd=[],
 *    toRemove=[]) — the strip is gated on diff > 0.
 *
 * The audit writes stay OUTSIDE the transaction (AGENTS.md item 4 — audit
 * failure must not block the business path); a missing audit row on a
 * successful junction write is a forensics-acceptable failure mode.
 */
describe("transactional integrity + inbox.dismissed clear", () => {
  const uniq = () => Math.random().toString(36).slice(2, 10);

  it("createEvent rolls back parent events row when junction INSERT throws", async () => {
    const { eventGames: eg } = await import("../../src/lib/server/db/schema/event-games.js");
    const u = await seedUserDirectly({ email: `ev35-rollback-${uniq()}@test.local` });
    const gA = uuidv7();
    await db.insert(games).values({ id: gA, userId: u.id, title: "A" });

    // Wrap db.transaction so the inner tx.insert(eventGames) call throws.
    // Drizzle's tx is a separate object from db (different prototype), so
    // spying on db.insert doesn't intercept tx.insert. Wrapping
    // db.transaction lets us proxy the tx parameter and force the failure
    // INSIDE the real Postgres transaction. The thrown error propagates
    // out, the real transaction rolls back, and we observe that the
    // parent events INSERT is gone.
    const realTransaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, "transaction").mockImplementation(((
      cb: (tx: unknown) => Promise<unknown>,
      ...rest: unknown[]
    ) => {
      return realTransaction(
        // Cast the inner callback to Drizzle's strict PgTransaction signature.
        // We treat tx structurally (only need .insert / Reflect.get fall-through);
        // the Proxy preserves runtime behavior while the cast satisfies TS.
        (async (tx: { insert: (t: unknown) => unknown }) => {
          const proxy = new Proxy(tx, {
            get(target, prop, receiver) {
              if (prop === "insert") {
                return (table: unknown) => {
                  if (table === eg) {
                    throw new Error("simulated junction INSERT failure");
                  }
                  return (target as { insert: (t: unknown) => unknown }).insert(table);
                };
              }
              return Reflect.get(target, prop, receiver);
            },
          });
          return cb(proxy);
        }) as Parameters<typeof realTransaction>[0],
        ...(rest as []),
      );
    }) as typeof db.transaction);

    try {
      await expect(
        createEvent(
          u.id,
          {
            gameIds: [gA],
            kind: "press",
            occurredAt: new Date("2026-06-01T10:00:00Z"),
            title: "Should roll back",
          },
          "127.0.0.1",
        ),
      ).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }

    // Assert: zero rows in events for this userId. The transaction rolled the
    // parent INSERT back when the junction INSERT threw.
    const rows = await db.select().from(events).where(eq(events.userId, u.id));
    expect(rows).toHaveLength(0);

    // Assert: zero junction rows.
    const junction = await db.select().from(eg).where(eq(eg.userId, u.id));
    expect(junction).toHaveLength(0);
  });

  it("attachEventToGames clears metadata.inbox.dismissed after attach (diff > 0)", async () => {
    const { dismissFromInbox, attachEventToGames } =
      await import("../../src/lib/server/services/events.js");
    const u = await seedUserDirectly({ email: `ev35-clear-attach-${uniq()}@test.local` });
    const gA = uuidv7();
    await db.insert(games).values({ id: gA, userId: u.id, title: "A" });

    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Inbox event",
      },
      "127.0.0.1",
    );

    // Step 1: dismiss from inbox → metadata.inbox.dismissed=true.
    await dismissFromInbox(u.id, ev.id, "127.0.0.1");
    let [row] = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, u.id), eq(events.id, ev.id)));
    expect((row!.metadata as { inbox?: { dismissed?: boolean } } | null)?.inbox?.dismissed).toBe(
      true,
    );

    // Step 2: attach to a game (toAdd=[gA], diff > 0) → inbox key stripped.
    await attachEventToGames(u.id, ev.id, [gA], "127.0.0.1");
    [row] = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, u.id), eq(events.id, ev.id)));
    expect((row!.metadata as { inbox?: unknown } | null)?.inbox).toBeUndefined();
  });

  it("attachEventToGames clears metadata.inbox.dismissed after detach (diff > 0)", async () => {
    const { dismissFromInbox, attachEventToGames } =
      await import("../../src/lib/server/services/events.js");
    const u = await seedUserDirectly({ email: `ev35-clear-detach-${uniq()}@test.local` });
    const gA = uuidv7();
    await db.insert(games).values({ id: gA, userId: u.id, title: "A" });

    // Start with an attached event.
    const ev = await createEvent(
      u.id,
      {
        gameIds: [gA],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Attached",
      },
      "127.0.0.1",
    );

    // Detach to land in inbox (junction now empty, dismissed not yet set).
    await attachEventToGames(u.id, ev.id, [], "127.0.0.1");
    // Dismiss from inbox → metadata.inbox.dismissed=true.
    await dismissFromInbox(u.id, ev.id, "127.0.0.1");
    let [row] = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, u.id), eq(events.id, ev.id)));
    expect((row!.metadata as { inbox?: { dismissed?: boolean } } | null)?.inbox?.dismissed).toBe(
      true,
    );

    // Re-attach to gA (toAdd=[gA], diff > 0) → inbox stripped.
    await attachEventToGames(u.id, ev.id, [gA], "127.0.0.1");
    [row] = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, u.id), eq(events.id, ev.id)));
    expect((row!.metadata as { inbox?: unknown } | null)?.inbox).toBeUndefined();

    // Re-dismiss to set up the detach round-trip — we need the event back in inbox first.
    await attachEventToGames(u.id, ev.id, [], "127.0.0.1");
    await dismissFromInbox(u.id, ev.id, "127.0.0.1");
    [row] = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, u.id), eq(events.id, ev.id)));
    expect((row!.metadata as { inbox?: { dismissed?: boolean } } | null)?.inbox?.dismissed).toBe(
      true,
    );

    // Attach then detach (toAdd=[gA] then toRemove=[gA] — both diff > 0 ops strip inbox).
    await attachEventToGames(u.id, ev.id, [gA], "127.0.0.1");
    [row] = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, u.id), eq(events.id, ev.id)));
    expect((row!.metadata as { inbox?: unknown } | null)?.inbox).toBeUndefined();
    await attachEventToGames(u.id, ev.id, [], "127.0.0.1");
    [row] = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, u.id), eq(events.id, ev.id)));
    expect((row!.metadata as { inbox?: unknown } | null)?.inbox).toBeUndefined();
  });

  it("attachEventToGames no-op call (diff === 0) preserves metadata.inbox.dismissed", async () => {
    const { dismissFromInbox, attachEventToGames } =
      await import("../../src/lib/server/services/events.js");
    const u = await seedUserDirectly({ email: `ev35-noop-${uniq()}@test.local` });

    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Inbox no-op",
      },
      "127.0.0.1",
    );
    await dismissFromInbox(u.id, ev.id, "127.0.0.1");

    let [row] = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, u.id), eq(events.id, ev.id)));
    expect((row!.metadata as { inbox?: { dismissed?: boolean } } | null)?.inbox?.dismissed).toBe(
      true,
    );
    const updatedAtBefore = row!.updatedAt;

    // Wait a tick so we can detect the updatedAt bump even on the no-op branch.
    await new Promise((r) => setTimeout(r, 10));

    // No-op: target is the current attached set (both empty). diff === 0.
    await attachEventToGames(u.id, ev.id, [], "127.0.0.1");
    [row] = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, u.id), eq(events.id, ev.id)));

    // Inbox.dismissed PRESERVED on no-op (diff===0 branch does NOT strip).
    expect((row!.metadata as { inbox?: { dismissed?: boolean } } | null)?.inbox?.dismissed).toBe(
      true,
    );
    // updatedAt still bumps on the no-op path (preserves existing contract).
    expect(row!.updatedAt.getTime()).toBeGreaterThan(updatedAtBefore.getTime());
  });
});

/**
 * PATCH /api/events/:id youtube invariant (merged-state validator).
 *
 * The route-layer superRefine on updateEventSchema returned early when
 * the body lacked `kind`; a PATCH like {url: null} on an existing
 * kind=youtube_video row would slip past and the UPDATE would write
 * url=null, leaving the row in a kind=youtube_video AND url=null state
 * (an invariant violation).
 *
 * The validator now lives in the service layer so it sees BOTH the
 * request body AND the existing row, computes the merged state, and
 * throws AppError('kind_url_inconsistent', 422) when:
 *   - merged.kind === 'youtube_video' AND merged.url is falsy, OR
 *   - merged.kind === 'youtube_video' AND merged.url does not parse as
 *     a YouTube video URL.
 *
 * The route-layer superRefine on createEventSchema is unchanged (create body
 * is the full state — no partial-update problem).
 *
 * Privacy invariants: cross-tenant /api/events/:id PATCH still surfaces as
 * NotFoundError → 404 (AGENTS.md item 2). The merged-state validator runs
 * AFTER the existing-row load, so a forged eventId from another tenant
 * never reaches it.
 */
describe("PATCH /api/events/:id youtube invariant (merged-state validator)", () => {
  const uniq = () => Math.random().toString(36).slice(2, 10);

  it("PATCH {url: null} on kind=youtube_video event returns 422 with code=kind_url_inconsistent", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `ev37-t1-${uniq()}@test.local` });

    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "youtube_video",
        occurredAt: new Date("2026-04-28T12:00:00Z"),
        title: "YT video",
        url: "https://youtu.be/dQw4w9WgXcQ",
      },
      "127.0.0.1",
    );

    const res = await app.request(`/api/events/${ev.id}`, {
      method: "PATCH",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ url: null }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: string;
      metadata?: { reason?: string; event_id?: string };
    };
    expect(body.error).toBe("kind_url_inconsistent");
    expect(body.metadata?.reason).toBe("youtube_video_requires_url");

    // Defense-in-depth: confirm the row was NOT mutated.
    const [row] = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, u.id), eq(events.id, ev.id)));
    expect(row!.url).toBe("https://youtu.be/dQw4w9WgXcQ");
    expect(row!.kind).toBe("youtube_video");
  });

  it("PATCH {kind: 'youtube_video'} on event with non-YouTube URL returns 422", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `ev37-t2-${uniq()}@test.local` });

    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "other",
        occurredAt: new Date("2026-04-28T12:00:00Z"),
        title: "Not yet a YT video",
        url: "https://example.com/some-page",
      },
      "127.0.0.1",
    );

    const res = await app.request(`/api/events/${ev.id}`, {
      method: "PATCH",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ kind: "youtube_video" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: string;
      metadata?: { reason?: string };
    };
    expect(body.error).toBe("kind_url_inconsistent");
    expect(body.metadata?.reason).toBe("url_not_youtube");

    // Row unchanged.
    const [row] = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, u.id), eq(events.id, ev.id)));
    expect(row!.kind).toBe("other");
  });

  it("PATCH {url: malformed YT (non-11-char videoId)} returns 422 — matches POST strictness", async () => {
    // Regression guard for create-vs-update strictness drift. Pre-fix:
    //   - POST /api/events used parseIngestUrl which validated /^[\w-]{11}$/
    //     for the 11-char YouTube videoId.
    //   - PATCH /api/events used adapter.validateEventInput → youtubeParseUrl
    //     which accepted any non-empty path segment.
    // → A malformed URL POST would reject could be persisted via PATCH.
    // Fix: validateEventInput now applies the same 11-char regex.
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `ev-strict-${uniq()}@test.local` });

    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "youtube_video",
        occurredAt: new Date("2026-04-28T12:00:00Z"),
        title: "Initial valid",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      },
      "127.0.0.1",
    );

    // /shorts/abc — non-11-char id. youtubeParseUrl alone accepted this;
    // post-fix the 11-char regex gate rejects.
    const res = await app.request(`/api/events/${ev.id}`, {
      method: "PATCH",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ url: "https://www.youtube.com/shorts/abc" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; metadata?: { reason?: string } };
    expect(body.error).toBe("kind_url_inconsistent");
    expect(body.metadata?.reason).toBe("youtube_video_id_shape");

    // Row unchanged.
    const [row] = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, u.id), eq(events.id, ev.id)));
    expect(row!.url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("PATCH valid {url: youtube} on existing kind=youtube_video succeeds (sanity — no false-positive)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `ev37-t3-${uniq()}@test.local` });

    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "youtube_video",
        occurredAt: new Date("2026-04-28T12:00:00Z"),
        title: "YT video",
        url: "https://youtu.be/aaa11111111",
      },
      "127.0.0.1",
    );

    const res = await app.request(`/api/events/${ev.id}`, {
      method: "PATCH",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ url: "https://youtu.be/bbb22222222" }),
    });
    expect(res.status).toBe(200);

    const [row] = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, u.id), eq(events.id, ev.id)));
    expect(row!.url).toBe("https://youtu.be/bbb22222222");
  });

  it("cross-tenant PATCH /api/events/:id returns 404 (never reaches merged-state validator) — AGENTS.md item 2", async () => {
    // PRIV-01 invariant: a forged eventId belonging to user A surfaces as 404
    // when user B PATCHes it. The merged-state validator must NOT introduce
    // a new path that leaks resource existence (e.g. by checking kind/url
    // before the userId WHERE clause filters).
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const a = await seedUserDirectly({ email: `ev37-t4a-${uniq()}@test.local` });
    const b = await seedUserDirectly({ email: `ev37-t4b-${uniq()}@test.local` });

    const ev = await createEvent(
      a.id,
      {
        gameIds: [],
        kind: "youtube_video",
        occurredAt: new Date("2026-04-28T12:00:00Z"),
        title: "User A's YT video",
        url: "https://youtu.be/aaa11111111",
      },
      "127.0.0.1",
    );

    // User B PATCHes user A's event with a body that WOULD trigger the
    // merged-state validator if scope leaked (kind=youtube_video + url=null).
    const res = await app.request(`/api/events/${ev.id}`, {
      method: "PATCH",
      headers: {
        cookie: `neotolis.session_token=${b.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ url: null }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
    // Body MUST NOT leak resource existence via 'forbidden' / 'permission'.
    const bodyText = JSON.stringify(body).toLowerCase();
    expect(bodyText).not.toContain("forbidden");
    expect(bodyText).not.toContain("permission");
    expect(bodyText).not.toContain("kind_url_inconsistent");
  });
});
