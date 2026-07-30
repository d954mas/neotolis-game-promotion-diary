import { describe, it, expect, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  createEvent,
  listFeedPage,
  dismissFromInbox,
} from "../../src/lib/server/services/events.js";
import { db } from "../../src/lib/server/db/client.js";
import { games } from "../../src/lib/server/db/schema/games.js";
import { events as events28 } from "../../src/lib/server/db/schema/events.js";
import { auditLog } from "../../src/lib/server/db/schema/audit-log.js";
import { uuidv7 } from "../../src/lib/server/ids.js";
import { seedUserDirectly } from "./helpers.js";
import { AppError, NotFoundError } from "../../src/lib/server/services/errors.js";

// Helper: flip metadata.triage.offTopic on an owned event row directly,
// bypassing the (now-deleted) markStandalone service. The off-topic write
// path proper goes through bulkEdit — tested in its own integration suite.
// Here we only need the post-state for setup of other behavior under test.
async function setOffTopicDirectly(userId: string, eventId: string): Promise<void> {
  await db
    .update(events28)
    .set({
      metadata: sql`jsonb_set(
        jsonb_set(
          COALESCE(${events28.metadata}, '{}'::jsonb),
          '{triage}',
          COALESCE(${events28.metadata}->'triage', '{}'::jsonb),
          true
        ),
        '{triage,offTopic}',
        'true'::jsonb,
        true
      )`,
    })
    .where(and(eq(events28.userId, userId), eq(events28.id, eventId)));
}

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

  it("dismissFromInbox uses the PostgreSQL clock when the Node clock is ahead", async () => {
    const u = await seedUserDirectly({ email: "inbox-db-clock@test.local" });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Database clock",
      },
      "127.0.0.1",
    );

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2099-01-01T00:00:00Z"));
    let updated: Awaited<ReturnType<typeof dismissFromInbox>>;
    try {
      updated = await dismissFromInbox(u.id, ev.id, "127.0.0.1");
    } finally {
      vi.useRealTimers();
    }

    const clockResult = await db.execute<{ now: Date | string }>(sql`SELECT NOW() AS now`);
    const clock = clockResult.rows[0]!;
    expect(Math.abs(updated.updatedAt.getTime() - new Date(clock.now).getTime())).toBeLessThan(
      5_000,
    );
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

/**
 * Off-topic + games coexist freely (independent axes).
 *
 * After Plan 03.4-10 GAME-axis multi-select refactor: off-topic and games
 * are INDEPENDENT axes. An event can freely carry both — the prior
 * mutual-exclusion 422 guard is gone. These tests assert the new contract
 * via attachEventToGames; the off-topic write path proper (bulkEdit) is
 * covered in its own integration suite.
 */
describe("off-topic + games coexist freely (independent axes)", () => {
  const uniq = () => Math.random().toString(36).slice(2, 10);

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
    await setOffTopicDirectly(u.id, ev.id);

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

  it("attachEventToGames([]) on off-topic event SUCCEEDS — empty target set is the no-op detach path", async () => {
    // Empty gameIds is the "move to inbox" affordance; calling it on an
    // off-topic event is a no-op (zero junction rows + zero added/removed
    // → zero audit rows). The off-topic flag survives untouched.
    const { attachEventToGames: attach28 } =
      await import("../../src/lib/server/services/events.js");
    const u = await seedUserDirectly({ email: `inbox28-3-${uniq()}@test.local` });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "Off-topic empty-attach",
      },
      "127.0.0.1",
    );
    await setOffTopicDirectly(u.id, ev.id);

    // Should NOT throw — empty target set is a no-op.
    const result = await attach28(u.id, ev.id, [], "127.0.0.1");
    expect(result.id).toBe(ev.id);
  });
});
