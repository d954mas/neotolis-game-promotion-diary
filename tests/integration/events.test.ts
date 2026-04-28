import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createEvent,
  updateEvent,
  softDeleteEvent,
  listEventsForGame,
  listFeedPage,
  listDeletedEvents,
  restoreEvent,
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

/**
 * Plan 02.1-14 (gap closure) — soft-delete event recovery.
 *
 * Closes VERIFICATION.md Gap 2 (P0 — `confirm_event_delete` promises a 60-day
 * restore but until this plan there was no service / route / UI surface to
 * deliver on the promise). The service layer is the load-bearing tier: the
 * UPDATE's WHERE clause encodes tenant scoping + retention window + idempotency
 * by construction, so cross-tenant attempts, restore-on-never-deleted, and
 * past-retention-window all collapse to NotFoundError.
 */
describe("event soft-delete recovery (Plan 02.1-14 gap closure)", () => {
  it("02.1-14: restore round-trips deletedAt to null and audits event.restored", async () => {
    const u = await seedUserDirectly({ email: "ev14a@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });

    const ev = await createEvent(
      u.id,
      {
        gameId,
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
    const restoredMeta = restoredEntry?.metadata as
      | { event_id?: string; kind?: string }
      | null;
    expect(restoredMeta?.event_id).toBe(ev.id);
    expect(restoredMeta?.kind).toBe("talk");
  });

  it("02.1-14: cross-tenant restore throws NotFoundError", async () => {
    const userA = await seedUserDirectly({ email: "ev14b1@test.local" });
    const userB = await seedUserDirectly({ email: "ev14b2@test.local" });
    const gameA = uuidv7();
    await db.insert(games).values({ id: gameA, userId: userA.id, title: "A" });

    const evA = await createEvent(
      userA.id,
      {
        gameId: gameA,
        kind: "press",
        occurredAt: new Date("2026-05-10T15:00:00Z"),
        title: "A's press",
      },
      "127.0.0.1",
    );
    await softDeleteEvent(userA.id, evA.id, "127.0.0.1");

    // userB attempts to restore userA's deleted event — must 404 by construction.
    await expect(
      restoreEvent(userB.id, evA.id, "127.0.0.1"),
    ).rejects.toBeInstanceOf(NotFoundError);

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
        gameId,
        kind: "conference",
        occurredAt: new Date("2026-05-10T15:00:00Z"),
        title: "Live",
      },
      "127.0.0.1",
    );

    // The event was never soft-deleted — restore is a no-op-as-NotFoundError
    // (idempotency: not-yet-deleted == not findable in the deleted-events scope).
    await expect(restoreEvent(u.id, ev.id, "127.0.0.1")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("02.1-14: restore on past-retention-window event throws NotFoundError", async () => {
    const u = await seedUserDirectly({ email: "ev14d@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });

    const expiredEventId = uuidv7();
    const pastDeleted = new Date(
      Date.now() - (env.RETENTION_DAYS + 1) * 86_400_000,
    );
    // Direct INSERT with a deleted_at older than the retention window.
    await db.insert(events).values({
      id: expiredEventId,
      userId: u.id,
      gameId,
      kind: "talk",
      title: "Past retention",
      occurredAt: pastDeleted,
      deletedAt: pastDeleted,
    });

    // Past-retention rows are pending Phase 6 purge; restore returns 404
    // (same null-result semantics as cross-tenant / never-deleted).
    await expect(
      restoreEvent(u.id, expiredEventId, "127.0.0.1"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("02.1-14: listDeletedEvents returns recent soft-deletes only, tenant-scoped", async () => {
    const userA = await seedUserDirectly({ email: "ev14e1@test.local" });
    const userB = await seedUserDirectly({ email: "ev14e2@test.local" });
    const gameA = uuidv7();
    await db.insert(games).values({ id: gameA, userId: userA.id, title: "A" });

    // Two recent deletes for userA.
    const recent1 = await createEvent(
      userA.id,
      {
        gameId: gameA,
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
        gameId: gameA,
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
      gameId: gameA,
      kind: "other",
      title: "Past retention",
      occurredAt: past,
      deletedAt: past,
    });

    // One live (non-deleted) event for userA — should NOT surface.
    await createEvent(
      userA.id,
      {
        gameId: gameA,
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
        gameId: gameB,
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
 * Plan 02.1-14 Task 2 — HTTP-boundary tests for the new restore + deleted-list
 * routes. The service-layer tests above prove the contract; these tests
 * confirm the wire-format projection (toEventDto strips userId, deletedAt
 * round-trips to null on restore, cross-tenant returns 404).
 */
describe("event soft-delete recovery routes (Plan 02.1-14 gap closure)", () => {
  it("02.1-14: authenticated PATCH /api/events/:id/restore returns 200 + EventDto with deletedAt: null", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "ev14r1@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });

    const ev = await createEvent(
      u.id,
      {
        gameId,
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
    // DTO discipline (PRIV / P3): userId MUST NOT cross the wire.
    expect(body).not.toHaveProperty("userId");
  });

  it("02.1-14: authenticated GET /api/events/deleted returns {rows: EventDto[]} scoped to RETENTION_DAYS", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "ev14r2@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });

    const recent = await createEvent(
      u.id,
      {
        gameId,
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
      gameId,
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
