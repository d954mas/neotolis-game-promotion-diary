/**
 * Integration tests for /api/events/bulk PATCH + DELETE.
 *
 * Wave 1 Plan 05 shipped the bulkEdit / bulkDelete / bulkDeleteForever
 * service functions; Wave 2 Plan 06 mounts the Hono route. Both layers are
 * exercised here via app.request (full HTTP path: tenant-scope middleware
 * → zod validator → handler → service → DB → mapErr → response). The
 * service-level invariants (D-12 tri-state, D-13 cross-tenant filter, D-14
 * one-audit-row, D-21 force-flag) live as one test per contract anchor;
 * the route layer adds the bulk-endpoint registration + path-precedence
 * guarantee.
 *
 * Contract anchors:
 *   - D-12 — tri-state {gameStates, offTopicState} apply in single tx
 *   - D-13 — cross-tenant ids silently filtered (NOT 403/404)
 *   - D-14 — ONE audit row per bulk operation (NOT N per event)
 *   - D-15 — bulk DELETE doesn't count against events_per_day
 *   - D-21 — ?force=true hard-deletes already-soft-deleted only
 */

import { describe, it, expect } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { createApp } from "../../src/lib/server/http/app.js";
import { db } from "../../src/lib/server/db/client.js";
import { games } from "../../src/lib/server/db/schema/games.js";
import { events } from "../../src/lib/server/db/schema/events.js";
import { eventGames } from "../../src/lib/server/db/schema/event-games.js";
import { auditLog } from "../../src/lib/server/db/schema/audit-log.js";
import { uuidv7 } from "../../src/lib/server/ids.js";
import { createEvent } from "../../src/lib/server/services/events.js";
import { seedUserDirectly } from "./helpers.js";

const uniq = (): string => Math.random().toString(36).slice(2, 10);

async function seedUserWithGames(prefix: string): Promise<{
  userId: string;
  cookie: string;
  game1: string;
  game2: string;
}> {
  const u = await seedUserDirectly({ email: `${prefix}-${uniq()}@test.local` });
  const game1 = uuidv7();
  const game2 = uuidv7();
  await db.insert(games).values({ id: game1, userId: u.id, title: `G1-${uniq()}` });
  await db.insert(games).values({ id: game2, userId: u.id, title: `G2-${uniq()}` });
  return {
    userId: u.id,
    cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
    game1,
    game2,
  };
}

async function seedEvent(userId: string, gameIds: string[] = []): Promise<string> {
  const ev = await createEvent(
    userId,
    {
      gameIds,
      kind: "twitter_post",
      occurredAt: new Date(),
      title: `T-${uniq()}`,
    },
    "127.0.0.1",
  );
  return ev.id;
}

describe("PATCH /api/events/bulk (Wave 2 Plan 06)", () => {
  const app = createApp();

  it("D-12 — tri-state gameStates {on, off, mixed} apply per event in single tx", async () => {
    const fx = await seedUserWithGames("bulk-edit-tri");
    // ev1: starts attached to game1 only. ev2: starts attached to game1 + game2.
    const ev1 = await seedEvent(fx.userId, [fx.game1]);
    const ev2 = await seedEvent(fx.userId, [fx.game1, fx.game2]);

    // gameStates: game1='off' → detach where present; game2='on' → attach where missing.
    const res = await app.request("/api/events/bulk", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: fx.cookie },
      body: JSON.stringify({
        ids: [ev1, ev2],
        gameStates: { [fx.game1]: "off", [fx.game2]: "on" },
        offTopicState: "mixed",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[]; affected_count: number };
    expect(body.affected_count).toBe(2);
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBe(2);

    // ev1: game1 removed, game2 added → ends attached to game2 only.
    const ev1Junction = await db
      .select({ gameId: eventGames.gameId })
      .from(eventGames)
      .where(and(eq(eventGames.userId, fx.userId), eq(eventGames.eventId, ev1)));
    expect(ev1Junction.map((r) => r.gameId).sort()).toEqual([fx.game2]);

    // ev2: game1 removed, game2 already attached (mixed-effect) → ends with game2 only.
    const ev2Junction = await db
      .select({ gameId: eventGames.gameId })
      .from(eventGames)
      .where(and(eq(eventGames.userId, fx.userId), eq(eventGames.eventId, ev2)));
    expect(ev2Junction.map((r) => r.gameId).sort()).toEqual([fx.game2]);
  });

  it("D-12 — offTopicState='on' sets metadata.triage.offTopic=true for all affected ids", async () => {
    const fx = await seedUserWithGames("bulk-edit-offtopic");
    const ev1 = await seedEvent(fx.userId);
    const ev2 = await seedEvent(fx.userId);

    const res = await app.request("/api/events/bulk", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: fx.cookie },
      body: JSON.stringify({
        ids: [ev1, ev2],
        gameStates: {},
        offTopicState: "on",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { affected_count: number };
    expect(body.affected_count).toBe(2);

    const rows = await db
      .select({ id: events.id, metadata: events.metadata })
      .from(events)
      .where(and(eq(events.userId, fx.userId), inArray(events.id, [ev1, ev2])));
    for (const row of rows) {
      const md = row.metadata as { triage?: { offTopic?: boolean } } | null;
      expect(md?.triage?.offTopic).toBe(true);
    }
  });

  // Plan 03.4-10 — regression test for the JSONB field-name unification.
  // Before the fix, bulkEdit wrote `triage.offTopic` while the feed filter
  // read `triage.standalone`, so off-topic events toggled via GamesPicker
  // were invisible to the show=standalone filter. Asserts the end-to-end
  // bug-fix: bulkEdit({offTopicState:'on'}) → listFeedPage({show:{kind:
  // 'standalone'}}) returns the event.
  it("Plan 03.4-10 — bulkEdit offTopicState='on' surfaces event in listFeedPage show.kind='standalone'", async () => {
    const { listFeedPage } = await import("../../src/lib/server/services/events.js");
    const fx = await seedUserWithGames("bulk-edit-offtopic-feed");
    const ev1 = await seedEvent(fx.userId);

    // Sanity: before the bulkEdit, ev1 has no triage marker → standalone
    // filter must NOT include it.
    const beforePage = await listFeedPage(fx.userId, { show: { kind: "standalone" } }, null);
    expect(beforePage.rows.map((r) => r.id)).not.toContain(ev1);

    const res = await app.request("/api/events/bulk", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: fx.cookie },
      body: JSON.stringify({
        ids: [ev1],
        gameStates: {},
        offTopicState: "on",
      }),
    });
    expect(res.status).toBe(200);

    // After: the standalone filter MUST include ev1. Pre-fix this was the
    // failing assertion — bulkEdit wrote `triage.offTopic` but the filter
    // read `triage.standalone`, so the result was empty.
    const afterPage = await listFeedPage(fx.userId, { show: { kind: "standalone" } }, null);
    expect(afterPage.rows.map((r) => r.id)).toContain(ev1);
  });

  it("D-13 — cross-tenant ids silently filtered; affected_count reflects owned subset only", async () => {
    const fxA = await seedUserWithGames("bulk-edit-xtA");
    const fxB = await seedUserWithGames("bulk-edit-xtB");
    const evA = await seedEvent(fxA.userId);
    const evB = await seedEvent(fxB.userId);

    // userA submits its own evA + userB's evB. Service-layer WHERE clause
    // drops evB silently; affected_count === 1. NEVER 403, NEVER 404.
    const res = await app.request("/api/events/bulk", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: fxA.cookie },
      body: JSON.stringify({
        ids: [evA, evB],
        gameStates: {},
        offTopicState: "on",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { affected_count: number };
    expect(body.affected_count).toBe(1);

    // userB's event untouched.
    const [evBRow] = await db
      .select({ metadata: events.metadata })
      .from(events)
      .where(eq(events.id, evB));
    const mdB = evBRow!.metadata as { triage?: { offTopic?: boolean } } | null;
    expect(mdB?.triage?.offTopic).not.toBe(true);
  });

  it("D-14 — writes EXACTLY ONE audit row events.bulk_edit with affected_ids in metadata", async () => {
    const fx = await seedUserWithGames("bulk-edit-audit");
    const ev1 = await seedEvent(fx.userId);
    const ev2 = await seedEvent(fx.userId);

    const res = await app.request("/api/events/bulk", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: fx.cookie },
      body: JSON.stringify({
        ids: [ev1, ev2],
        gameStates: {},
        offTopicState: "on",
      }),
    });
    expect(res.status).toBe(200);

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, fx.userId), eq(auditLog.action, "events.bulk_edit")));
    expect(audits.length).toBe(1);
    const meta = audits[0]!.metadata as {
      affected_ids?: string[];
      affected_count?: number;
      requested_count?: number;
    } | null;
    expect(meta?.affected_count).toBe(2);
    expect(meta?.requested_count).toBe(2);
    expect((meta?.affected_ids ?? []).sort()).toEqual([ev1, ev2].sort());
  });

  it("empty-diff PATCH (all 'mixed' / no changes) returns affected_count=0 + writes no audit row", async () => {
    const fx = await seedUserWithGames("bulk-edit-noop");
    const ev1 = await seedEvent(fx.userId);

    const res = await app.request("/api/events/bulk", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: fx.cookie },
      body: JSON.stringify({
        ids: [ev1],
        gameStates: { [fx.game1]: "mixed" },
        offTopicState: "mixed",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { affected_count: number; events: unknown[] };
    expect(body.affected_count).toBe(0);
    expect(body.events).toEqual([]);

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, fx.userId), eq(auditLog.action, "events.bulk_edit")));
    expect(audits.length).toBe(0);
  });

  it("PATCH with cross-tenant gameId in gameStates silently dropped; no NotFoundError leak", async () => {
    const fxA = await seedUserWithGames("bulk-edit-xtgameA");
    const fxB = await seedUserWithGames("bulk-edit-xtgameB");
    const evA = await seedEvent(fxA.userId);

    // userA sends a gameStates key for userB's game. checkGameOwnership
    // returns false → silently dropped before the tx. The offTopicState
    // still applies (causing affected_count=1).
    const res = await app.request("/api/events/bulk", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: fxA.cookie },
      body: JSON.stringify({
        ids: [evA],
        gameStates: { [fxB.game1]: "on" },
        offTopicState: "on",
      }),
    });
    expect(res.status).toBe(200);

    // userA's event evA is NOT attached to userB's game1.
    const junction = await db
      .select({ gameId: eventGames.gameId })
      .from(eventGames)
      .where(and(eq(eventGames.userId, fxA.userId), eq(eventGames.eventId, evA)));
    expect(junction).toEqual([]);
  });

  it("invalid body (no ids) returns 422 validation_failed", async () => {
    const fx = await seedUserWithGames("bulk-edit-invalid");
    const res = await app.request("/api/events/bulk", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: fx.cookie },
      body: JSON.stringify({ ids: [], gameStates: {}, offTopicState: "mixed" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation_failed");
  });

  it("invalid body (>500 ids) returns 422 validation_failed", async () => {
    const fx = await seedUserWithGames("bulk-edit-overflow");
    const tooMany = Array.from({ length: 501 }, () => uuidv7());
    const res = await app.request("/api/events/bulk", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: fx.cookie },
      body: JSON.stringify({ ids: tooMany, gameStates: {}, offTopicState: "mixed" }),
    });
    expect(res.status).toBe(422);
  });
});

describe("DELETE /api/events/bulk (Wave 2 Plan 06)", () => {
  const app = createApp();

  it("D-13 — soft-deletes N owned events; cross-tenant ids untouched", async () => {
    const fxA = await seedUserWithGames("bulk-del-A");
    const fxB = await seedUserWithGames("bulk-del-B");
    const evA1 = await seedEvent(fxA.userId);
    const evA2 = await seedEvent(fxA.userId);
    const evB = await seedEvent(fxB.userId);

    const res = await app.request("/api/events/bulk", {
      method: "DELETE",
      headers: { "content-type": "application/json", cookie: fxA.cookie },
      body: JSON.stringify({ ids: [evA1, evA2, evB] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { affected_count: number };
    expect(body.affected_count).toBe(2);

    // userA's events are soft-deleted (deletedAt non-null).
    const aRows = await db
      .select({ deletedAt: events.deletedAt })
      .from(events)
      .where(and(eq(events.userId, fxA.userId), inArray(events.id, [evA1, evA2])));
    for (const r of aRows) expect(r.deletedAt).not.toBeNull();

    // userB's event still live (deletedAt null).
    const [bRow] = await db
      .select({ deletedAt: events.deletedAt })
      .from(events)
      .where(eq(events.id, evB));
    expect(bRow!.deletedAt).toBeNull();
  });

  it("D-14 — writes ONE audit row events.bulk_delete with affected_ids", async () => {
    const fx = await seedUserWithGames("bulk-del-audit");
    const ev1 = await seedEvent(fx.userId);
    const ev2 = await seedEvent(fx.userId);

    const res = await app.request("/api/events/bulk", {
      method: "DELETE",
      headers: { "content-type": "application/json", cookie: fx.cookie },
      body: JSON.stringify({ ids: [ev1, ev2] }),
    });
    expect(res.status).toBe(200);

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, fx.userId), eq(auditLog.action, "events.bulk_delete")));
    expect(audits.length).toBe(1);
    const meta = audits[0]!.metadata as {
      affected_ids?: string[];
      affected_count?: number;
    } | null;
    expect(meta?.affected_count).toBe(2);
    expect((meta?.affected_ids ?? []).sort()).toEqual([ev1, ev2].sort());
  });

  it("DELETE on already-soft-deleted events skips them (isNull deletedAt filter)", async () => {
    const fx = await seedUserWithGames("bulk-del-already");
    const ev1 = await seedEvent(fx.userId);

    // Pre-soft-delete ev1 directly.
    await db
      .update(events)
      .set({ deletedAt: new Date() })
      .where(and(eq(events.userId, fx.userId), eq(events.id, ev1)));

    const res = await app.request("/api/events/bulk", {
      method: "DELETE",
      headers: { "content-type": "application/json", cookie: fx.cookie },
      body: JSON.stringify({ ids: [ev1] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { affected_count: number };
    expect(body.affected_count).toBe(0);

    // No audit row for the no-op call.
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, fx.userId), eq(auditLog.action, "events.bulk_delete")));
    expect(audits.length).toBe(0);
  });
});

describe("DELETE /api/events/bulk?force=true (Wave 2 Plan 06)", () => {
  const app = createApp();

  it("D-21 — hard-deletes only already-soft-deleted owned ids", async () => {
    const fx = await seedUserWithGames("bulk-force-A");
    const evLive = await seedEvent(fx.userId);
    const evTrash = await seedEvent(fx.userId);

    // Pre-soft-delete evTrash.
    await db
      .update(events)
      .set({ deletedAt: new Date() })
      .where(and(eq(events.userId, fx.userId), eq(events.id, evTrash)));

    const res = await app.request("/api/events/bulk?force=true", {
      method: "DELETE",
      headers: { "content-type": "application/json", cookie: fx.cookie },
      body: JSON.stringify({ ids: [evLive, evTrash] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { affected_count: number };
    // Only evTrash (already-soft-deleted) hard-deleted. evLive silently filtered.
    expect(body.affected_count).toBe(1);

    // evTrash gone from DB.
    const trashRow = await db.select().from(events).where(eq(events.id, evTrash));
    expect(trashRow.length).toBe(0);

    // evLive still present + still live.
    const [liveRow] = await db
      .select({ deletedAt: events.deletedAt })
      .from(events)
      .where(eq(events.id, evLive));
    expect(liveRow).toBeDefined();
    expect(liveRow!.deletedAt).toBeNull();
  });

  it("D-21 — force=true on live (not-yet-soft-deleted) event silently filtered out", async () => {
    const fx = await seedUserWithGames("bulk-force-live-only");
    const evLive = await seedEvent(fx.userId);

    const res = await app.request("/api/events/bulk?force=true", {
      method: "DELETE",
      headers: { "content-type": "application/json", cookie: fx.cookie },
      body: JSON.stringify({ ids: [evLive] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { affected_count: number };
    expect(body.affected_count).toBe(0);

    // evLive still present + still live.
    const [row] = await db
      .select({ deletedAt: events.deletedAt })
      .from(events)
      .where(eq(events.id, evLive));
    expect(row).toBeDefined();
    expect(row!.deletedAt).toBeNull();
  });

  it("D-14 — force=true writes audit row events.delete_forever", async () => {
    const fx = await seedUserWithGames("bulk-force-audit");
    const evTrash = await seedEvent(fx.userId);
    await db
      .update(events)
      .set({ deletedAt: new Date() })
      .where(and(eq(events.userId, fx.userId), eq(events.id, evTrash)));

    const res = await app.request("/api/events/bulk?force=true", {
      method: "DELETE",
      headers: { "content-type": "application/json", cookie: fx.cookie },
      body: JSON.stringify({ ids: [evTrash] }),
    });
    expect(res.status).toBe(200);

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, fx.userId), eq(auditLog.action, "events.delete_forever")));
    expect(audits.length).toBe(1);
    const meta = audits[0]!.metadata as {
      affected_ids?: string[];
      affected_count?: number;
    } | null;
    expect(meta?.affected_count).toBe(1);
    expect(meta?.affected_ids).toEqual([evTrash]);
  });
});
