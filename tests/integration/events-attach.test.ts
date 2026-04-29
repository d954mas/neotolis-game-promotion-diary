import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createEvent,
  attachEventToGames,
  markStandalone,
} from "../../src/lib/server/services/events.js";
import { db } from "../../src/lib/server/db/client.js";
import { games } from "../../src/lib/server/db/schema/games.js";
import { eventGames } from "../../src/lib/server/db/schema/event-games.js";
import { auditLog } from "../../src/lib/server/db/schema/audit-log.js";
import { uuidv7 } from "../../src/lib/server/ids.js";
import { seedUserDirectly } from "./helpers.js";
import { AppError, NotFoundError } from "../../src/lib/server/services/errors.js";

/**
 * Phase 2.1 Plan 02.1-28 (UAT-NOTES.md §4.24.G — M:N migration application
 * layer) — attachEventToGames service-level tests.
 *
 * Replaces the Phase 2.1 Plan 02.1-05 attachToGame tests. The legacy
 * attachToGame export is REMOVED in lock-step with the schema change
 * (Plan 02.1-27 dropped events.game_id; Plan 02.1-28 swaps every consumer
 * over to the event_games junction).
 *
 * The PITFALL P-4 mitigation (validate gameIds BEFORE writing the junction;
 * cross-tenant gameId returns 404 not 500) lives at the SERVICE layer, which
 * is what we assert. The route layer (Plan 02.1-06 + 02.1-28) accepts both
 * `{ gameIds: [...] }` (canonical) and `{ gameId: X | null }` (back-compat
 * alias for one round of UAT) — see the HTTP-boundary block below.
 */

describe("Plan 02.1-28 — attachEventToGames (M:N junction service)", () => {
  it("Plan 02.1-28: attachEventToGames(userId, eventId, [A]) on inbox event → 1 junction row + 1 audit", async () => {
    const u = await seedUserDirectly({ email: "attach28-1@test.local" });
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

    await attachEventToGames(u.id, ev.id, [gA], "127.0.0.1");

    const junction = await db
      .select()
      .from(eventGames)
      .where(and(eq(eventGames.userId, u.id), eq(eventGames.eventId, ev.id)));
    expect(junction).toHaveLength(1);
    expect(junction[0]!.gameId).toBe(gA);

    const adds = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.userId, u.id),
          eq(auditLog.action, "event.attached_to_game"),
        ),
      );
    expect(adds.length).toBeGreaterThanOrEqual(1);
    const addMeta = adds[0]!.metadata as
      | { event_id?: string; game_id?: string; kind?: string }
      | null;
    expect(addMeta?.event_id).toBe(ev.id);
    expect(addMeta?.game_id).toBe(gA);
    expect(addMeta?.kind).toBe("press");
  });

  it("Plan 02.1-28: attachEventToGames(userId, eventId, [A, B]) writes 2 junction rows + 2 attached_to_game audits", async () => {
    const u = await seedUserDirectly({ email: "attach28-2@test.local" });
    const gA = uuidv7();
    const gB = uuidv7();
    await db.insert(games).values({ id: gA, userId: u.id, title: "A" });
    await db.insert(games).values({ id: gB, userId: u.id, title: "B" });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Multi-game",
      },
      "127.0.0.1",
    );

    await attachEventToGames(u.id, ev.id, [gA, gB], "127.0.0.1");

    const junction = await db
      .select({ gameId: eventGames.gameId })
      .from(eventGames)
      .where(and(eq(eventGames.userId, u.id), eq(eventGames.eventId, ev.id)));
    const gids = junction.map((r) => r.gameId).sort();
    expect(gids).toEqual([gA, gB].sort());

    const adds = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.userId, u.id),
          eq(auditLog.action, "event.attached_to_game"),
        ),
      );
    // Two attached_to_game audit rows (one per added game).
    expect(adds.length).toBeGreaterThanOrEqual(2);
  });

  it("Plan 02.1-28: attachEventToGames(userId, eventId, []) on attached event detaches all games + writes detached_from_game audit per removed", async () => {
    const u = await seedUserDirectly({ email: "attach28-3@test.local" });
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
        title: "Will be detached",
      },
      "127.0.0.1",
    );
    // Sanity check: junction has both rows.
    const beforeJunction = await db
      .select()
      .from(eventGames)
      .where(and(eq(eventGames.userId, u.id), eq(eventGames.eventId, ev.id)));
    expect(beforeJunction).toHaveLength(2);

    // Detach all.
    await attachEventToGames(u.id, ev.id, [], "127.0.0.1");

    const afterJunction = await db
      .select()
      .from(eventGames)
      .where(and(eq(eventGames.userId, u.id), eq(eventGames.eventId, ev.id)));
    expect(afterJunction).toHaveLength(0);

    const detaches = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.userId, u.id),
          eq(auditLog.action, "event.detached_from_game"),
        ),
      );
    // Two detached_from_game audit rows (one per removed game).
    expect(detaches.length).toBeGreaterThanOrEqual(2);
    const gids = detaches
      .map((a) => (a.metadata as { game_id?: string } | null)?.game_id)
      .sort();
    expect(gids).toEqual([gA, gB].sort());
  });

  it("Plan 02.1-28: attachEventToGames(userId, eventId, [A, A]) is idempotent under input dedup → 1 junction row", async () => {
    const u = await seedUserDirectly({ email: "attach28-4@test.local" });
    const gA = uuidv7();
    await db.insert(games).values({ id: gA, userId: u.id, title: "A" });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Dedup test",
      },
      "127.0.0.1",
    );

    await attachEventToGames(u.id, ev.id, [gA, gA, gA], "127.0.0.1");

    const junction = await db
      .select()
      .from(eventGames)
      .where(and(eq(eventGames.userId, u.id), eq(eventGames.eventId, ev.id)));
    // Composite PK + Set-dedup at the service → exactly one row.
    expect(junction).toHaveLength(1);
  });

  it("Plan 02.1-28: attachEventToGames with cross-tenant gameId throws NotFoundError 404 (Pitfall 4)", async () => {
    const userA = await seedUserDirectly({ email: "attach28-5a@test.local" });
    const userB = await seedUserDirectly({ email: "attach28-5b@test.local" });
    const evA = await createEvent(
      userA.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "User A event",
      },
      "127.0.0.1",
    );
    const gB = uuidv7();
    await db
      .insert(games)
      .values({ id: gB, userId: userB.id, title: "B's game" });

    let threw: unknown;
    try {
      // userA tries to attach their event to userB's game.
      await attachEventToGames(userA.id, evA.id, [gB], "127.0.0.1");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(NotFoundError);
    expect((threw as AppError).status).toBe(404);
    expect((threw as AppError).status).not.toBe(500);
    expect((threw as AppError).message.toLowerCase()).not.toContain("forbidden");
    expect((threw as AppError).message.toLowerCase()).not.toContain("permission");

    // No junction row was written (validate-first; no half-write).
    const junction = await db
      .select()
      .from(eventGames)
      .where(and(eq(eventGames.userId, userA.id), eq(eventGames.eventId, evA.id)));
    expect(junction).toHaveLength(0);
  });

  it("Plan 02.1-28: cross-tenant attachEventToGames on another tenant's event returns 404 (event-ownership wins)", async () => {
    const userA = await seedUserDirectly({ email: "attach28-6a@test.local" });
    const userB = await seedUserDirectly({ email: "attach28-6b@test.local" });
    const evA = await createEvent(
      userA.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "User A event",
      },
      "127.0.0.1",
    );
    const gB = uuidv7();
    await db.insert(games).values({ id: gB, userId: userB.id, title: "GB" });

    let threw: unknown;
    try {
      // userB tries to attach userA's event to userB's own game.
      await attachEventToGames(userB.id, evA.id, [gB], "127.0.0.1");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(NotFoundError);
    expect((threw as AppError).status).toBe(404);
    expect((threw as AppError).message.toLowerCase()).not.toContain("forbidden");
    expect((threw as AppError).message.toLowerCase()).not.toContain("permission");

    // userA's junction unchanged (zero rows).
    const junction = await db
      .select()
      .from(eventGames)
      .where(and(eq(eventGames.userId, userA.id), eq(eventGames.eventId, evA.id)));
    expect(junction).toHaveLength(0);
  });

  it("Plan 02.1-28: attachEventToGames on non-existent eventId returns 404 not_found", async () => {
    const u = await seedUserDirectly({ email: "attach28-7@test.local" });
    const gA = uuidv7();
    await db.insert(games).values({ id: gA, userId: u.id, title: "A" });
    const fakeEventId = uuidv7();

    await expect(
      attachEventToGames(u.id, fakeEventId, [gA], "127.0.0.1"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("Plan 02.1-28: attachEventToGames with non-existent gameId returns 404 not_found (Pitfall 4)", async () => {
    const u = await seedUserDirectly({ email: "attach28-8@test.local" });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "ev",
      },
      "127.0.0.1",
    );
    const fakeGameId = uuidv7();

    await expect(
      attachEventToGames(u.id, ev.id, [fakeGameId], "127.0.0.1"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("Plan 02.1-28: attachEventToGames(non-empty) on a standalone event throws AppError 422 'standalone_conflicts_with_game'", async () => {
    const u = await seedUserDirectly({ email: "attach28-9@test.local" });
    const gA = uuidv7();
    await db.insert(games).values({ id: gA, userId: u.id, title: "A" });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "About to be standalone",
      },
      "127.0.0.1",
    );
    await markStandalone(u.id, ev.id, "127.0.0.1");

    let threw: unknown;
    try {
      await attachEventToGames(u.id, ev.id, [gA], "127.0.0.1");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(AppError);
    expect((threw as AppError).code).toBe("standalone_conflicts_with_game");
    expect((threw as AppError).status).toBe(422);

    // Junction unchanged.
    const junction = await db
      .select()
      .from(eventGames)
      .where(and(eq(eventGames.userId, u.id), eq(eventGames.eventId, ev.id)));
    expect(junction).toHaveLength(0);
  });

  it("Plan 02.1-28: attachEventToGames bumps events.updatedAt", async () => {
    const u = await seedUserDirectly({ email: "attach28-10@test.local" });
    const gA = uuidv7();
    await db.insert(games).values({ id: gA, userId: u.id, title: "A" });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "ts test",
      },
      "127.0.0.1",
    );
    const beforeTs = ev.updatedAt;

    // Wait a bit to let the timestamp advance.
    await new Promise((r) => setTimeout(r, 5));
    const after = await attachEventToGames(u.id, ev.id, [gA], "127.0.0.1");
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(beforeTs.getTime());
  });
});

// Plan 02.1-28 — PATCH /api/events/:id/attach HTTP boundary tests.
// The route schema accepts BOTH the canonical { gameIds: string[] } shape
// AND the deprecated { gameId: string | null } back-compat alias for one
// round of UAT (Plan 02.1-32 retires the alias on the UI side).
describe("Plan 02.1-28: PATCH /api/events/:id/attach HTTP boundary (M:N + back-compat alias)", () => {
  it("Plan 02.1-28: PATCH /api/events/:id/attach { gameIds: [A, B] } returns 200 + EventDto.gameIds with both", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "http-attach28-1@test.local" });
    const gA = uuidv7();
    const gB = uuidv7();
    await db.insert(games).values({ id: gA, userId: u.id, title: "A" });
    await db.insert(games).values({ id: gB, userId: u.id, title: "B" });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "HTTP multi-attach",
      },
      "127.0.0.1",
    );

    const res = await app.request(`/api/events/${ev.id}/attach`, {
      method: "PATCH",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ gameIds: [gA, gB] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; gameIds: string[] };
    expect(body.id).toBe(ev.id);
    expect([...body.gameIds].sort()).toEqual([gA, gB].sort());
  });

  it("Plan 02.1-28: PATCH /api/events/:id/attach { gameIds: [] } detaches all (move-to-inbox)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "http-attach28-2@test.local" });
    const gA = uuidv7();
    await db.insert(games).values({ id: gA, userId: u.id, title: "A" });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [gA],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "HTTP detach",
      },
      "127.0.0.1",
    );

    const res = await app.request(`/api/events/${ev.id}/attach`, {
      method: "PATCH",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ gameIds: [] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; gameIds: string[] };
    expect(body.gameIds).toEqual([]);
  });

  it("Plan 02.1-28: PATCH /api/events/:id/attach { gameId: A } (back-compat alias) attaches single game", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "http-attach28-3@test.local" });
    const gA = uuidv7();
    await db.insert(games).values({ id: gA, userId: u.id, title: "A" });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "HTTP alias attach",
      },
      "127.0.0.1",
    );

    const res = await app.request(`/api/events/${ev.id}/attach`, {
      method: "PATCH",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ gameId: gA }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; gameIds: string[] };
    expect(body.gameIds).toEqual([gA]);
  });

  it("Plan 02.1-28: PATCH /api/events/:id/attach { gameId: null } (back-compat alias) detaches all", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "http-attach28-4@test.local" });
    const gA = uuidv7();
    await db.insert(games).values({ id: gA, userId: u.id, title: "A" });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [gA],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "HTTP alias detach",
      },
      "127.0.0.1",
    );

    const res = await app.request(`/api/events/${ev.id}/attach`, {
      method: "PATCH",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ gameId: null }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; gameIds: string[] };
    expect(body.gameIds).toEqual([]);
  });

  it("Plan 02.1-28: PATCH /api/events/:id/attach with non-existent gameId returns 404 not_found (Pitfall 4 — NEVER 500)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "http-attach28-5@test.local" });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "ev",
      },
      "127.0.0.1",
    );
    const fakeGameId = uuidv7();

    const res = await app.request(`/api/events/${ev.id}/attach`, {
      method: "PATCH",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ gameIds: [fakeGameId] }),
    });
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(500);
    expect((await res.json()).error).toBe("not_found");
  });

  it("Plan 02.1-28: PATCH /api/events/:id/mark-standalone on event with attached games returns 422 'standalone_conflicts_with_game'", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "http-attach28-6@test.local" });
    const gA = uuidv7();
    await db.insert(games).values({ id: gA, userId: u.id, title: "A" });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [gA],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Attached cannot go standalone",
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
});
