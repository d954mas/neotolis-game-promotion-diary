import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createEvent,
  attachToGame,
} from "../../src/lib/server/services/events.js";
import { db } from "../../src/lib/server/db/client.js";
import { games } from "../../src/lib/server/db/schema/games.js";
import { auditLog } from "../../src/lib/server/db/schema/audit-log.js";
import { uuidv7 } from "../../src/lib/server/ids.js";
import { seedUserDirectly } from "./helpers.js";
import { AppError, NotFoundError } from "../../src/lib/server/services/errors.js";

/**
 * Phase 2.1 Wave 1B (Plan 02.1-05) — attachToGame service-level tests.
 *
 * The placeholders (Plan 02.1-02) named `Plan 02.1-06: PATCH /api/events/:id/attach ...`.
 * Route layer is Plan 02.1-06; here we flip them to live SERVICE-level tests
 * against attachToGame. The PITFALL P-4 mitigation (validate gameId BEFORE
 * UPDATE; cross-tenant attach returns 404 not 500) lives at the SERVICE
 * layer, which is what we assert.
 *
 * The "anonymous PATCH /api/events/:id/attach returns 401" placeholder is a
 * route-layer concern (Plan 02.1-06's middleware) — kept as a behavioral
 * note: the service has no concept of an anonymous caller (userId is required
 * by the type system). We assert the SERVICE contract directly.
 */

describe("GAMES-04a (reframed): per-event game attachment", () => {
  it("attachToGame { gameId } sets events.game_id and returns updated row", async () => {
    const u = await seedUserDirectly({ email: "attach1@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });
    const ev = await createEvent(
      u.id,
      {
        gameId: null,
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Inbox event",
      },
      "127.0.0.1",
    );

    const updated = await attachToGame(u.id, ev.id, gameId, "127.0.0.1");
    expect(updated.id).toBe(ev.id);
    expect(updated.gameId).toBe(gameId);
  });

  it("attachToGame { gameId: null } clears events.game_id (move-to-inbox)", async () => {
    const u = await seedUserDirectly({ email: "attach2@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });
    const ev = await createEvent(
      u.id,
      {
        gameId,
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Attached event",
      },
      "127.0.0.1",
    );
    expect(ev.gameId).toBe(gameId);

    const cleared = await attachToGame(u.id, ev.id, null, "127.0.0.1");
    expect(cleared.gameId).toBeNull();
  });

  it("PITFALL P-4: attachToGame validates gameId belongs to userId BEFORE the UPDATE; cross-tenant gameId returns 404 not 500", async () => {
    const userA = await seedUserDirectly({ email: "attach3a@test.local" });
    const userB = await seedUserDirectly({ email: "attach3b@test.local" });
    // User A's event.
    const evA = await createEvent(
      userA.id,
      {
        gameId: null,
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "User A event",
      },
      "127.0.0.1",
    );
    // User B's game — belongs to user B, not user A.
    const gameB = uuidv7();
    await db.insert(games).values({ id: gameB, userId: userB.id, title: "B's game" });

    // User A tries to attach their event to user B's game. The PITFALL P-4
    // mitigation calls assertGameOwnedByUser FIRST → NotFoundError (404), so
    // the bare PG FK error (500) never surfaces.
    let threw: unknown;
    try {
      await attachToGame(userA.id, evA.id, gameB, "127.0.0.1");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(NotFoundError);
    expect((threw as AppError).status).toBe(404);
    expect((threw as AppError).status).not.toBe(500);
    expect((threw as AppError).code).toBe("not_found");

    // The event row is unchanged (no half-write).
    const [row] = await db.select().from(games).where(eq(games.id, gameB));
    expect(row?.userId).toBe(userB.id);
  });

  it("cross-tenant attachToGame on another tenant's event returns 404 not_found (NotFoundError)", async () => {
    const userA = await seedUserDirectly({ email: "attach4a@test.local" });
    const userB = await seedUserDirectly({ email: "attach4b@test.local" });
    const evA = await createEvent(
      userA.id,
      {
        gameId: null,
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "User A event",
      },
      "127.0.0.1",
    );
    const gameB = uuidv7();
    await db.insert(games).values({ id: gameB, userId: userB.id, title: "GB" });

    // User B tries to attach user A's event to their (B's) own game.
    // Even though gameB belongs to userB, the EVENT belongs to userA — so
    // the UPDATE matches no rows and NotFoundError fires.
    let threw: unknown;
    try {
      await attachToGame(userB.id, evA.id, gameB, "127.0.0.1");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(NotFoundError);
    expect((threw as AppError).status).toBe(404);
    expect((threw as AppError).message.toLowerCase()).not.toContain("forbidden");
    expect((threw as AppError).message.toLowerCase()).not.toContain("permission");
  });

  it("attachToGame writes audit_action='event.attached_to_game' with metadata.event_id + metadata.game_id", async () => {
    const u = await seedUserDirectly({ email: "attach5@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });
    const ev = await createEvent(
      u.id,
      {
        gameId: null,
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "audit me",
      },
      "127.0.0.1",
    );

    await attachToGame(u.id, ev.id, gameId, "10.20.30.40", "ua-attach");

    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.userId, u.id),
          eq(auditLog.action, "event.attached_to_game"),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const meta = audits[0]!.metadata as
      | { event_id?: string; game_id?: string; kind?: string }
      | null;
    expect(meta?.event_id).toBe(ev.id);
    expect(meta?.game_id).toBe(gameId);
    expect(meta?.kind).toBe("press");
    expect(audits[0]!.ipAddress).toBe("10.20.30.40");
    expect(audits[0]!.userAgent).toBe("ua-attach");
  });

  it("attachToGame on non-existent eventId returns 404 not_found", async () => {
    const u = await seedUserDirectly({ email: "attach6@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });
    const fakeEventId = uuidv7();

    await expect(
      attachToGame(u.id, fakeEventId, gameId, "127.0.0.1"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("attachToGame on non-existent gameId returns 404 not_found (Pitfall P-4 path)", async () => {
    const u = await seedUserDirectly({ email: "attach7@test.local" });
    const ev = await createEvent(
      u.id,
      {
        gameId: null,
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "ev",
      },
      "127.0.0.1",
    );
    const fakeGameId = uuidv7();

    await expect(
      attachToGame(u.id, ev.id, fakeGameId, "127.0.0.1"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
