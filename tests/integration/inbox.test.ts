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
import { auditLog } from "../../src/lib/server/db/schema/audit-log.js";
import { uuidv7 } from "../../src/lib/server/ids.js";
import { seedUserDirectly } from "./helpers.js";
import { AppError, NotFoundError } from "../../src/lib/server/services/errors.js";

/**
 * Phase 2.1 Wave 1B (Plan 02.1-05) — dismissFromInbox service-level tests.
 *
 * The Plan 02.1-05 line is the inbox semantics on createEvent (game_id=NULL
 * surfaces in attached=false). The Plan 02.1-06 lines test the dismissal
 * service contract that the route layer wraps. The Phase 3 line stays
 * skipped (CONTEXT D-11: auto-import populates inbox naturally in Phase 3).
 */

describe("INBOX-01: inbox flow + dismissal", () => {
  it("Plan 02.1-05: an event created via paste with no attached game has game_id=NULL and surfaces in attached=false filter", async () => {
    const u = await seedUserDirectly({ email: "inbox1@test.local" });
    const ev = await createEvent(
      u.id,
      {
        gameId: null,
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Paste with no game",
      },
      "127.0.0.1",
    );
    expect(ev.gameId).toBeNull();

    const page = await listFeedPage(u.id, { show: { kind: "inbox" } }, null);
    const ids = page.rows.map((r) => r.id);
    expect(ids).toContain(ev.id);
  });

  it("dismissFromInbox sets metadata.inbox.dismissed=true, returns updated row", async () => {
    const u = await seedUserDirectly({ email: "inbox2@test.local" });
    const ev = await createEvent(
      u.id,
      {
        gameId: null,
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
        gameId: null,
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Will be dismissed",
      },
      "127.0.0.1",
    );

    await dismissFromInbox(u.id, ev.id, "127.0.0.1");

    const page = await listFeedPage(u.id, { show: { kind: "inbox" } }, null);
    expect(page.rows.map((r) => r.id)).not.toContain(ev.id);

    // The row still exists; it's just out of the inbox view. Advanced filter
    // "show all dismissed" is Phase 6 polish (RESEARCH §6.2). We assert
    // existence via the unfiltered listing (no attached filter).
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
        gameId,
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
        gameId: null,
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
        gameId: null,
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
      .where(
        and(
          eq(auditLog.userId, u.id),
          eq(auditLog.action, "event.dismissed_from_inbox"),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const meta = audits[0]!.metadata as { event_id?: string; kind?: string } | null;
    expect(meta?.event_id).toBe(ev.id);
    expect(meta?.kind).toBe("press");
    expect(audits[0]!.ipAddress).toBe("10.20.30.40");
    expect(audits[0]!.userAgent).toBe("ua-test");
  });

  it.skip("Phase 3 Plan: auto-imported events arrive with source_id != NULL AND game_id=NULL — covered in Phase 3 smoke (deferred per CONTEXT D-11)");
});

// Plan 02.1-06 — PATCH /api/events/:id/dismiss-inbox HTTP boundary.
describe("Plan 02.1-06: PATCH /api/events/:id/dismiss-inbox HTTP boundary", () => {
  it("Plan 02.1-06: PATCH /api/events/:id/dismiss-inbox returns 200 with metadata.inbox.dismissed=true", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "http-inbox-1@test.local" });
    const ev = await createEvent(
      u.id,
      {
        gameId: null,
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

  it("Plan 02.1-06: PATCH /api/events/:id/dismiss-inbox on attached event returns 422 not_in_inbox", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "http-inbox-2@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "G" });
    const ev = await createEvent(
      u.id,
      {
        gameId,
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

  it("Plan 02.1-06: PATCH /api/events/:id/dismiss-inbox cross-tenant returns 404 not_found", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const userA = await seedUserDirectly({ email: "http-inbox-3a@test.local" });
    const userB = await seedUserDirectly({ email: "http-inbox-3b@test.local" });
    const evA = await createEvent(
      userA.id,
      {
        gameId: null,
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

// Plan 02.1-24 — markStandalone + unmarkStandalone service contract per
// UAT-NOTES.md §6.1-redesign. The user explicitly asked for two changes:
//   (a) inbox cards get an inline "Standalone" button (exception to the
//       Plan 02.1-18 read-only contract);
//   (b) standalone events render dimmed in /feed so they don't distract.
// The service mirrors restoreEvent (Plan 02.1-14) and dismissFromInbox
// (Plan 02.1-05) audit-after-success ordering — non-destructive triage
// actions write audit AFTER the UPDATE succeeds, so cross-tenant
// NotFoundError does not generate misleading audit rows.
describe("Plan 02.1-24 — markStandalone + unmarkStandalone", () => {
  it("Plan 02.1-24: markStandalone sets metadata.triage.standalone=true + game_id=null + writes event.marked_standalone audit", async () => {
    const u = await seedUserDirectly({ email: "standalone1@test.local" });
    // Seed an inbox event (game_id=null, kind=conference — author_is_me
    // implicit false, no source).
    const ev = await createEvent(
      u.id,
      {
        gameId: null,
        kind: "conference",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Industry talk",
      },
      "127.0.0.1",
    );

    const updated = await markStandalone(u.id, ev.id, "10.20.30.40", "ua-test");
    expect(updated.id).toBe(ev.id);
    expect(updated.gameId).toBeNull();
    const meta = updated.metadata as { triage?: { standalone?: unknown } };
    expect(meta.triage?.standalone).toBe(true);

    // Audit row written with the correct action + metadata + ip + ua.
    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.userId, u.id), eq(auditLog.action, "event.marked_standalone")),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const auditMeta = audits[0]!.metadata as { event_id?: string; kind?: string } | null;
    expect(auditMeta?.event_id).toBe(ev.id);
    expect(auditMeta?.kind).toBe("conference");
    expect(audits[0]!.ipAddress).toBe("10.20.30.40");
    expect(audits[0]!.userAgent).toBe("ua-test");
  });

  it("Plan 02.1-24: markStandalone on already-attached event detaches game (game_id=null) AND sets standalone=true", async () => {
    const u = await seedUserDirectly({ email: "standalone2@test.local" });
    const gameId = uuidv7();
    await db.insert(games).values({ id: gameId, userId: u.id, title: "Some game" });
    const ev = await createEvent(
      u.id,
      {
        gameId,
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Press piece I attached by mistake",
      },
      "127.0.0.1",
    );
    expect(ev.gameId).toBe(gameId);

    const updated = await markStandalone(u.id, ev.id, "127.0.0.1");
    // Standalone implies detached from game.
    expect(updated.gameId).toBeNull();
    const meta = updated.metadata as { triage?: { standalone?: unknown } };
    expect(meta.triage?.standalone).toBe(true);
  });

  it("Plan 02.1-24: cross-tenant markStandalone throws NotFoundError (404, never 403); no audit row written", async () => {
    const userA = await seedUserDirectly({ email: "standalone3a@test.local" });
    const userB = await seedUserDirectly({ email: "standalone3b@test.local" });
    const evA = await createEvent(
      userA.id,
      {
        gameId: null,
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
      .where(
        and(eq(auditLog.userId, userB.id), eq(auditLog.action, "event.marked_standalone")),
      );
    expect(auditsB.length).toBe(0);

    // userA's event is untouched (UPDATE matched 0 rows under userB's userId).
    const aMeta = evA.metadata as { triage?: { standalone?: unknown } } | null;
    expect(aMeta?.triage?.standalone).toBeUndefined();
  });

  it("Plan 02.1-24: unmarkStandalone clears metadata.triage.standalone=false + writes event.unmarked_standalone audit", async () => {
    const u = await seedUserDirectly({ email: "standalone4@test.local" });
    const ev = await createEvent(
      u.id,
      {
        gameId: null,
        kind: "talk",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Indie talk",
      },
      "127.0.0.1",
    );
    await markStandalone(u.id, ev.id, "127.0.0.1");

    const reverted = await unmarkStandalone(u.id, ev.id, "127.0.0.1");
    const meta = reverted.metadata as { triage?: { standalone?: unknown } };
    expect(meta.triage?.standalone).toBe(false);

    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.userId, u.id), eq(auditLog.action, "event.unmarked_standalone")),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it("Plan 02.1-24: idempotency — markStandalone twice in a row both succeed and both write fresh audit rows", async () => {
    const u = await seedUserDirectly({ email: "standalone5@test.local" });
    const ev = await createEvent(
      u.id,
      {
        gameId: null,
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
      .where(
        and(eq(auditLog.userId, u.id), eq(auditLog.action, "event.marked_standalone")),
      );
    // Idempotent UPDATE → same final state; two audit rows because each
    // call writes one (matches dismissFromInbox precedent).
    expect(audits.length).toBe(2);
  });
});

// Plan 02.1-24 — PATCH /api/events/:id/mark-standalone + /unmark-standalone
// HTTP boundary. Mirrors the Plan 02.1-06 dismiss-inbox / restore HTTP tests.
describe("Plan 02.1-24: PATCH /api/events/:id/mark-standalone + unmark-standalone HTTP boundary", () => {
  it("Plan 02.1-24: PATCH /api/events/:id/mark-standalone returns 200 with metadata.triage.standalone=true", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "http-standalone-1@test.local" });
    const ev = await createEvent(
      u.id,
      {
        gameId: null,
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
      gameId: string | null;
      metadata: { triage?: { standalone?: boolean } };
    };
    expect(body.id).toBe(ev.id);
    expect(body.gameId).toBeNull();
    expect(body.metadata.triage?.standalone).toBe(true);
  });

  it("Plan 02.1-24: PATCH /api/events/:id/mark-standalone cross-tenant returns 404 not_found (no forbidden/permission leak)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const userA = await seedUserDirectly({ email: "http-standalone-2a@test.local" });
    const userB = await seedUserDirectly({ email: "http-standalone-2b@test.local" });
    const evA = await createEvent(
      userA.id,
      {
        gameId: null,
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

  it("Plan 02.1-24: PATCH /api/events/:id/unmark-standalone returns 200 with metadata.triage.standalone=false", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "http-standalone-3@test.local" });
    const ev = await createEvent(
      u.id,
      {
        gameId: null,
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
      metadata: { triage?: { standalone?: boolean } };
    };
    expect(body.metadata.triage?.standalone).toBe(false);
  });
});
