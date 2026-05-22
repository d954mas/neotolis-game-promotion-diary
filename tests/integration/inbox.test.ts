import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createEvent,
  listFeedPage,
  dismissFromInbox,
  markStandalone,
  unmarkStandalone,
} from "../../src/lib/server/services/events.js";
import { db } from "../../src/lib/server/db/client.js";
import { games } from "../../src/lib/server/db/schema/games.js";
import { events as events28 } from "../../src/lib/server/db/schema/events.js";
import { auditLog } from "../../src/lib/server/db/schema/audit-log.js";
import { uuidv7 } from "../../src/lib/server/ids.js";
import { seedUserDirectly } from "./helpers.js";
import { AppError, NotFoundError } from "../../src/lib/server/services/errors.js";

/**
 * dismissFromInbox service-level tests.
 */

describe("INBOX-01: inbox flow + dismissal", () => {
  it("an event created via paste with no attached game has game_id=NULL and surfaces in attached=false filter", async () => {
    const u = await seedUserDirectly({ email: "inbox1@test.local" });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Paste with no game",
      },
      "127.0.0.1",
    );
    // The gameId column is gone; the inbox criterion is "zero junction
    // rows", which the listFeedPage NOT EXISTS subquery surfaces below.

    const page = await listFeedPage(u.id, { show: { kind: "inbox" } }, null);
    const ids = page.rows.map((r) => r.id);
    expect(ids).toContain(ev.id);
  });

  it("dismissFromInbox sets metadata.inbox.dismissed=true, returns updated row", async () => {
    const u = await seedUserDirectly({ email: "inbox2@test.local" });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Inbox row",
      },
      "127.0.0.1",
    );

    const updated = await dismissFromInbox(u.id, ev.id, "127.0.0.1");
    expect(updated.id).toBe(ev.id);
    const meta = updated.metadata as { inbox?: { dismissed?: unknown } };
    expect(meta.inbox?.dismissed).toBe(true);
  });

  it("dismissed event no longer appears in attached=false (still in DB; not in inbox view)", async () => {
    const u = await seedUserDirectly({ email: "inbox3@test.local" });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Will be dismissed",
      },
      "127.0.0.1",
    );

    await dismissFromInbox(u.id, ev.id, "127.0.0.1");

    const page = await listFeedPage(u.id, { show: { kind: "inbox" } }, null);
    expect(page.rows.map((r) => r.id)).not.toContain(ev.id);

    // The row still exists; it's just out of the inbox view. Advanced
    // filter "show all dismissed" is deferred polish. We assert existence
    // via the unfiltered listing (no attached filter).
    const all = await listFeedPage(u.id, {}, null);
    expect(all.rows.map((r) => r.id)).toContain(ev.id);
  });

  it("dismissFromInbox on event with game_id IS NOT NULL throws AppError 'not_in_inbox' (422)", async () => {
    const u = await seedUserDirectly({ email: "inbox4@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [gameId],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Attached event",
      },
      "127.0.0.1",
    );

    await expect(dismissFromInbox(u.id, ev.id, "127.0.0.1")).rejects.toMatchObject({
      code: "not_in_inbox",
      status: 422,
    });
  });

  it("cross-tenant dismissFromInbox returns NotFoundError (404, never 403)", async () => {
    const userA = await seedUserDirectly({ email: "inbox5a@test.local" });
    const userB = await seedUserDirectly({ email: "inbox5b@test.local" });
    const evA = await createEvent(
      userA.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "User A inbox",
      },
      "127.0.0.1",
    );

    // User B tries to dismiss user A's event — must throw NotFoundError, not
    // ForbiddenError. Body MUST NOT contain "forbidden" or "permission".
    let threw: unknown;
    try {
      await dismissFromInbox(userB.id, evA.id, "127.0.0.1");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(NotFoundError);
    expect((threw as AppError).status).toBe(404);
    expect((threw as AppError).code).toBe("not_found");
    expect((threw as AppError).message.toLowerCase()).not.toContain("forbidden");
    expect((threw as AppError).message.toLowerCase()).not.toContain("permission");
  });

  it("dismissFromInbox writes audit_action='event.dismissed_from_inbox'", async () => {
    const u = await seedUserDirectly({ email: "inbox6@test.local" });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Audit me",
      },
      "127.0.0.1",
    );

    await dismissFromInbox(u.id, ev.id, "10.20.30.40", "ua-test");

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, "event.dismissed_from_inbox")));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const meta = audits[0]!.metadata as { event_id?: string; kind?: string } | null;
    expect(meta?.event_id).toBe(ev.id);
    expect(meta?.kind).toBe("press");
    expect(audits[0]!.ipAddress).toBe("10.20.30.40");
    expect(audits[0]!.userAgent).toBe("ua-test");
  });

  it.skip(
    "auto-imported events arrive with source_id != NULL AND game_id=NULL — covered in smoke (deferred)",
  );
});

// PATCH /api/events/:id/dismiss-inbox HTTP boundary.
describe("PATCH /api/events/:id/dismiss-inbox HTTP boundary", () => {
  it("PATCH /api/events/:id/dismiss-inbox returns 200 with metadata.inbox.dismissed=true", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "http-inbox-1@test.local" });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Dismiss me HTTP",
      },
      "127.0.0.1",
    );
    const res = await app.request(`/api/events/${ev.id}/dismiss-inbox`, {
      method: "PATCH",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      metadata: { inbox?: { dismissed?: boolean } };
    };
    expect(body.id).toBe(ev.id);
    expect(body.metadata.inbox?.dismissed).toBe(true);
  });

  it("PATCH /api/events/:id/dismiss-inbox on attached event returns 422 not_in_inbox", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "http-inbox-2@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [gameId],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Attached, cannot dismiss",
      },
      "127.0.0.1",
    );
    const res = await app.request(`/api/events/${ev.id}/dismiss-inbox`, {
      method: "PATCH",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("not_in_inbox");
  });

  it("PATCH /api/events/:id/dismiss-inbox cross-tenant returns 404 not_found", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const userA = await seedUserDirectly({ email: "http-inbox-3a@test.local" });
    const userB = await seedUserDirectly({ email: "http-inbox-3b@test.local" });
    const evA = await createEvent(
      userA.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "User A inbox",
      },
      "127.0.0.1",
    );
    const res = await app.request(`/api/events/${evA.id}/dismiss-inbox`, {
      method: "PATCH",
      headers: { cookie: `neotolis.session_token=${userB.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "not_found" });
    expect(JSON.stringify(body)).not.toMatch(/forbidden|permission/i);
  });
});

// markStandalone + unmarkStandalone service contract. The user asked
// for two changes:
//   (a) inbox cards get an inline "Standalone" button (exception to the
//       read-only contract);
//   (b) standalone events render dimmed in /feed so they don't distract.
// The service uses audit-after-success ordering — non-destructive
// triage actions write audit AFTER the UPDATE succeeds, so cross-tenant
// NotFoundError does not generate misleading audit rows.
describe("markStandalone + unmarkStandalone", () => {
  it("markStandalone sets metadata.triage.offTopic=true + game_id=null + writes event.marked_standalone audit", async () => {
    const u = await seedUserDirectly({ email: "standalone1@test.local" });
    // Seed an inbox event (game_id=null, kind=conference — author_is_me
    // implicit false, no source).
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "conference",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Industry talk",
      },
      "127.0.0.1",
    );

    const updated = await markStandalone(u.id, ev.id, "10.20.30.40", "ua-test");
    expect(updated.id).toBe(ev.id);
    // The gameId column is gone; standalone events are guaranteed
    // junction-empty by the conflict guard (verified separately below).
    const meta = updated.metadata as { triage?: { offTopic?: unknown } };
    expect(meta.triage?.offTopic).toBe(true);

    // Audit row written with the correct action + metadata + ip + ua.
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, "event.marked_standalone")));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const auditMeta = audits[0]!.metadata as { event_id?: string; kind?: string } | null;
    expect(auditMeta?.event_id).toBe(ev.id);
    expect(auditMeta?.kind).toBe("conference");
    expect(audits[0]!.ipAddress).toBe("10.20.30.40");
    expect(audits[0]!.userAgent).toBe("ua-test");
  });

  it("markStandalone on event with attached games SUCCEEDS — off-topic and games are independent axes", async () => {
    // After the GAME-axis multi-select refactor (Plan 03.4-10), off-topic
    // is just another tag on the GAME axis (alongside game IDs). An event
    // can carry BOTH a game attachment AND the off-topic flag — the filter
    // expresses "attached to game OR marked off-topic" as an OR union, so
    // they're no longer mutually exclusive triage decisions.
    const uniqId = Math.random().toString(36).slice(2, 10);
    const u = await seedUserDirectly({ email: `standalone2-${uniqId}@test.local` });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "Some game" });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [gameId],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Off-topic press piece linked to a game",
      },
      "127.0.0.1",
    );

    await markStandalone(u.id, ev.id, "127.0.0.1");

    // Junction unchanged — event is still attached to the game.
    const { eventGames: eg28 } = await import("../../src/lib/server/db/schema/event-games.js");
    const junction = await db
      .select()
      .from(eg28)
      .where(and(eq(eg28.userId, u.id), eq(eg28.eventId, ev.id)));
    expect(junction).toHaveLength(1);
    expect(junction[0]!.gameId).toBe(gameId);

    // Metadata.triage.offTopic now set — both states coexist.
    const [row] = await db
      .select()
      .from(events28)
      .where(and(eq(events28.userId, u.id), eq(events28.id, ev.id)))
      .limit(1);
    const md = row?.metadata as { triage?: { offTopic?: boolean } } | null;
    expect(md?.triage?.offTopic).toBe(true);
  });

  it("cross-tenant markStandalone throws NotFoundError (404, never 403); no audit row written", async () => {
    const userA = await seedUserDirectly({ email: "standalone3a@test.local" });
    const userB = await seedUserDirectly({ email: "standalone3b@test.local" });
    const evA = await createEvent(
      userA.id,
      {
        gameIds: [],
        kind: "conference",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "User A inbox",
      },
      "127.0.0.1",
    );

    let threw: unknown;
    try {
      await markStandalone(userB.id, evA.id, "127.0.0.1");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(NotFoundError);
    expect((threw as AppError).status).toBe(404);
    expect((threw as AppError).code).toBe("not_found");
    expect((threw as AppError).message.toLowerCase()).not.toContain("forbidden");
    expect((threw as AppError).message.toLowerCase()).not.toContain("permission");

    // No audit row for user B (the failed cross-tenant probe must NOT
    // generate an audit row — the audit-after-success ordering preserves
    // this by construction).
    const auditsB = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, userB.id), eq(auditLog.action, "event.marked_standalone")));
    expect(auditsB.length).toBe(0);

    // userA's event is untouched (UPDATE matched 0 rows under userB's userId).
    const aMeta = evA.metadata as { triage?: { offTopic?: unknown } } | null;
    expect(aMeta?.triage?.offTopic).toBeUndefined();
  });

  it("unmarkStandalone clears metadata.triage.offTopic=false + writes event.unmarked_standalone audit", async () => {
    const u = await seedUserDirectly({ email: "standalone4@test.local" });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "talk",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Indie talk",
      },
      "127.0.0.1",
    );
    await markStandalone(u.id, ev.id, "127.0.0.1");

    const reverted = await unmarkStandalone(u.id, ev.id, "127.0.0.1");
    const meta = reverted.metadata as { triage?: { offTopic?: unknown } };
    expect(meta.triage?.offTopic).toBe(false);

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, "event.unmarked_standalone")));
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it("idempotency — markStandalone twice in a row both succeed and both write fresh audit rows", async () => {
    const u = await seedUserDirectly({ email: "standalone5@test.local" });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Press piece",
      },
      "127.0.0.1",
    );

    await markStandalone(u.id, ev.id, "127.0.0.1");
    await markStandalone(u.id, ev.id, "127.0.0.1");

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, "event.marked_standalone")));
    // Idempotent UPDATE → same final state; two audit rows because each
    // call writes one (matches dismissFromInbox precedent).
    expect(audits.length).toBe(2);
  });
});

// PATCH /api/events/:id/mark-standalone + /unmark-standalone HTTP
// boundary. Mirrors the dismiss-inbox / restore HTTP tests.
describe("PATCH /api/events/:id/mark-standalone + unmark-standalone HTTP boundary", () => {
  it("PATCH /api/events/:id/mark-standalone returns 200 with metadata.triage.offTopic=true", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "http-standalone-1@test.local" });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "conference",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Mark standalone HTTP",
      },
      "127.0.0.1",
    );
    const res = await app.request(`/api/events/${ev.id}/mark-standalone`, {
      method: "PATCH",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      gameIds: string[];
      metadata: { triage?: { offTopic?: boolean } };
    };
    expect(body.id).toBe(ev.id);
    // The gameId column is gone; standalone events have ZERO junction
    // rows (the conflict guard refuses to standalone an attached event).
    expect(body.gameIds).toEqual([]);
    expect(body.metadata.triage?.offTopic).toBe(true);
  });

  it("PATCH /api/events/:id/mark-standalone cross-tenant returns 404 not_found (no forbidden/permission leak)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const userA = await seedUserDirectly({ email: "http-standalone-2a@test.local" });
    const userB = await seedUserDirectly({ email: "http-standalone-2b@test.local" });
    const evA = await createEvent(
      userA.id,
      {
        gameIds: [],
        kind: "conference",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "User A inbox",
      },
      "127.0.0.1",
    );
    const res = await app.request(`/api/events/${evA.id}/mark-standalone`, {
      method: "PATCH",
      headers: { cookie: `neotolis.session_token=${userB.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "not_found" });
    expect(JSON.stringify(body)).not.toMatch(/forbidden|permission/i);
  });

  it("PATCH /api/events/:id/unmark-standalone returns 200 with metadata.triage.offTopic=false", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "http-standalone-3@test.local" });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Will be standalone then unmarked",
      },
      "127.0.0.1",
    );
    await markStandalone(u.id, ev.id, "127.0.0.1");

    const res = await app.request(`/api/events/${ev.id}/unmark-standalone`, {
      method: "PATCH",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      metadata: { triage?: { offTopic?: boolean } };
    };
    expect(body.metadata.triage?.offTopic).toBe(false);
  });
});

/**
 * Standalone conflict guard at the service layer.
 *
 * After Plan 03.4-10 GAME-axis multi-select refactor: off-topic and games
 * are INDEPENDENT axes. An event can freely carry both — the prior mutual-
 * exclusion 422 guard is gone. These tests assert the new contract.
 */
describe("off-topic + games coexist freely (independent axes)", () => {
  const uniq = () => Math.random().toString(36).slice(2, 10);

  it("markStandalone on event with attached games SUCCEEDS — both states coexist + audit row written", async () => {
    const { eventGames: eg } = await import("../../src/lib/server/db/schema/event-games.js");
    const u = await seedUserDirectly({ email: `inbox28-1-${uniq()}@test.local` });
    const gA = uuidv7();
    await db.insert(games).values({ id: gA, userId: u.id, title: "A" });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [gA],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Attached and off-topic at the same time",
      },
      "127.0.0.1",
    );

    await markStandalone(u.id, ev.id, "127.0.0.1");

    // Junction preserved — event still attached to the game.
    const junction = await db
      .select()
      .from(eg)
      .where(and(eq(eg.userId, u.id), eq(eg.eventId, ev.id)));
    expect(junction).toHaveLength(1);

    // metadata.triage.offTopic now set.
    const [row] = await db
      .select()
      .from(events28)
      .where(and(eq(events28.userId, u.id), eq(events28.id, ev.id)))
      .limit(1);
    const md = row?.metadata as { triage?: { offTopic?: boolean } } | null;
    expect(md?.triage?.offTopic).toBe(true);

    // Audit row written for the off-topic transition.
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, "event.marked_standalone")));
    expect(audits).toHaveLength(1);
  });

  it("attachEventToGames(non-empty) on off-topic event SUCCEEDS — both states coexist", async () => {
    const { attachEventToGames: attach28 } =
      await import("../../src/lib/server/services/events.js");
    const { eventGames: eg } = await import("../../src/lib/server/db/schema/event-games.js");
    const u = await seedUserDirectly({ email: `inbox28-2-${uniq()}@test.local` });
    const gA = uuidv7();
    await db.insert(games).values({ id: gA, userId: u.id, title: "A" });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Off-topic then attach a game",
      },
      "127.0.0.1",
    );
    await markStandalone(u.id, ev.id, "127.0.0.1");

    await attach28(u.id, ev.id, [gA], "127.0.0.1");

    // Junction populated — game attached.
    const junction = await db
      .select()
      .from(eg)
      .where(and(eq(eg.userId, u.id), eq(eg.eventId, ev.id)));
    expect(junction).toHaveLength(1);
    expect(junction[0]!.gameId).toBe(gA);

    // Off-topic flag preserved.
    const [row] = await db
      .select()
      .from(events28)
      .where(and(eq(events28.userId, u.id), eq(events28.id, ev.id)))
      .limit(1);
    const md = row?.metadata as { triage?: { offTopic?: boolean } } | null;
    expect(md?.triage?.offTopic).toBe(true);
  });

  it("attachEventToGames([]) on standalone event SUCCEEDS — empty target set is the no-op detach path", async () => {
    // The mutual-exclusion guard only fires for NON-EMPTY gameIds. Empty
    // gameIds is the "move to inbox" affordance; calling it on a
    // standalone event is a no-op (zero junction rows + zero
    // added/removed → zero audit rows). This is the path the UI wires
    // up to "I changed my mind, this isn't standalone after all"
    // (followed by an explicit
    // unmarkStandalone).
    const { attachEventToGames: attach28 } =
      await import("../../src/lib/server/services/events.js");
    const u = await seedUserDirectly({ email: `inbox28-3-${uniq()}@test.local` });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Standalone empty-attach",
      },
      "127.0.0.1",
    );
    await markStandalone(u.id, ev.id, "127.0.0.1");

    // Should NOT throw — empty target set bypasses the guard.
    const result = await attach28(u.id, ev.id, [], "127.0.0.1");
    expect(result.id).toBe(ev.id);
  });
});
