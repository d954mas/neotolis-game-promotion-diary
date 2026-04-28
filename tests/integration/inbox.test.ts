import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createEvent,
  listFeedPage,
  dismissFromInbox,
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

    const page = await listFeedPage(u.id, { attached: false }, null);
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

    const page = await listFeedPage(u.id, { attached: false }, null);
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
