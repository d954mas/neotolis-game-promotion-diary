import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import { games } from "../../src/lib/server/db/schema/games.js";
import { dataSources } from "../../src/lib/server/db/schema/data-sources.js";
import { events } from "../../src/lib/server/db/schema/events.js";
import { auditLog } from "../../src/lib/server/db/schema/audit-log.js";
import { createGame } from "../../src/lib/server/services/games.js";
import { createSource } from "../../src/lib/server/services/data-sources.js";
import { createEvent } from "../../src/lib/server/services/events.js";
import { AppError } from "../../src/lib/server/services/errors.js";
import { env } from "../../src/lib/server/config/env.js";
import { seedUserDirectly } from "./helpers.js";

// Phase 02.2 Plan 02 — per-user abuse quotas (D-11). Live integration tests
// flipped from the Plan 02.2-01 it.skip placeholders. Each it() name keeps the
// "Plan 02.2-02:" prefix so traceability holds: each placeholder belongs to one
// implementing plan, and each implementing plan fills in the body.
//
// Quota guard contract (services/quota.ts):
//   - createGame   -> assertQuota(userId, "games", ipAddress)
//   - createSource -> assertQuota(userId, "data_sources", ipAddress)
//   - createEvent  -> assertQuota(userId, "events_per_day", ipAddress)
// On exceedance: throws AppError 429 quota_exceeded with metadata
// {kind, limit, current}; writeAudit fires `quota.limit_hit` BEFORE the throw.
// Soft-deleted rows excluded from games / data_sources counts; events use
// rolling 24h (createdAt >= now - 24h).

describe("per-user abuse quotas (Phase 02.2)", () => {
  it("Plan 02.2-02: createGame throws AppError 429 quota_exceeded when active games count >= LIMIT_GAMES_PER_USER", async () => {
    const userA = await seedUserDirectly({ email: "quota-g1@test.local" });
    const limit = env.LIMIT_GAMES_PER_USER;

    // Seed `limit` games for userA via direct db.insert (bypass quota for setup).
    const seedRows = Array.from({ length: limit }, (_, i) => ({
      userId: userA.id,
      title: `seed-${i}`,
    }));
    await db.insert(games).values(seedRows);

    // The (limit+1)th createGame must throw AppError(429 quota_exceeded).
    await expect(createGame(userA.id, { title: "test #51" }, "127.0.0.1")).rejects.toBeInstanceOf(
      AppError,
    );
    await expect(createGame(userA.id, { title: "test #51" }, "127.0.0.1")).rejects.toMatchObject({
      code: "quota_exceeded",
      status: 429,
      metadata: { kind: "games", limit, current: limit },
    });
  });

  it("Plan 02.2-02: 429 body shape is {error:'quota_exceeded', metadata:{kind:'games', limit:50, current:50}}", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();

    const userA = await seedUserDirectly({ email: "quota-g2@test.local" });
    const limit = env.LIMIT_GAMES_PER_USER;

    const seedRows = Array.from({ length: limit }, (_, i) => ({
      userId: userA.id,
      title: `seed-${i}`,
    }));
    await db.insert(games).values(seedRows);

    const res = await app.request("/api/games", {
      method: "POST",
      headers: {
        cookie: `neotolis.session_token=${userA.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "should be 429" }),
    });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toEqual({
      error: "quota_exceeded",
      metadata: { kind: "games", limit, current: limit },
    });
  });

  it("Plan 02.2-02: createSource throws 429 when active data_sources count >= LIMIT_SOURCES_PER_USER", async () => {
    const userA = await seedUserDirectly({ email: "quota-s1@test.local" });
    const limit = env.LIMIT_SOURCES_PER_USER;

    const seedRows = Array.from({ length: limit }, (_, i) => ({
      userId: userA.id,
      kind: "youtube_channel" as const,
      handleUrl: `https://www.youtube.com/@seed-${i}`,
    }));
    await db.insert(dataSources).values(seedRows);

    await expect(
      createSource(
        userA.id,
        { kind: "youtube_channel", handleUrl: "https://www.youtube.com/@over-the-limit" },
        "127.0.0.1",
      ),
    ).rejects.toMatchObject({
      code: "quota_exceeded",
      status: 429,
      metadata: { kind: "data_sources", limit, current: limit },
    });
  });

  it("Plan 02.2-02: createEvent throws 429 when rolling-24h event count >= LIMIT_EVENTS_PER_DAY", async () => {
    const userA = await seedUserDirectly({ email: "quota-e1@test.local" });
    const limit = env.LIMIT_EVENTS_PER_DAY;

    // Seed `limit` events for userA created within the last 24h. Direct
    // db.insert lets createdAt default to now() which is well within window.
    const now = new Date();
    const seedRows = Array.from({ length: limit }, (_, i) => ({
      userId: userA.id,
      kind: "other" as const,
      authorIsMe: false,
      occurredAt: now,
      title: `seed event #${i}`,
    }));
    await db.insert(events).values(seedRows);

    await expect(
      createEvent(
        userA.id,
        { kind: "other", title: "should-be-429", occurredAt: now },
        "127.0.0.1",
      ),
    ).rejects.toMatchObject({
      code: "quota_exceeded",
      status: 429,
      metadata: { kind: "events_per_day", limit, current: limit },
    });
  });

  it("Plan 02.2-02: rolling-24h reset semantics: events older than 24h drop out of the count", async () => {
    const userA = await seedUserDirectly({ email: "quota-e2@test.local" });
    const limit = env.LIMIT_EVENTS_PER_DAY;

    // Seed `limit` events with createdAt = 25h ago — outside the rolling window.
    const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const seedRows = Array.from({ length: limit }, (_, i) => ({
      userId: userA.id,
      kind: "other" as const,
      authorIsMe: false,
      occurredAt: past,
      title: `old event #${i}`,
      createdAt: past,
      updatedAt: past,
    }));
    await db.insert(events).values(seedRows);

    // The (limit+1)th createEvent should SUCCEED — the seeded rows are outside
    // the rolling 24h window so they don't count toward the quota.
    const result = await createEvent(
      userA.id,
      { kind: "other", title: "should-succeed", occurredAt: new Date() },
      "127.0.0.1",
    );
    expect(result.title).toBe("should-succeed");
    expect(result.userId).toBe(userA.id);
  });

  it("Plan 02.2-02: soft-deleted games / sources do NOT count toward the limit (deleted_at IS NOT NULL excluded)", async () => {
    // games branch
    const userA = await seedUserDirectly({ email: "quota-sd-a@test.local" });
    const gameLimit = env.LIMIT_GAMES_PER_USER;
    const deletedAt = new Date();
    const seedDeletedGames = Array.from({ length: gameLimit }, (_, i) => ({
      userId: userA.id,
      title: `deleted-game-${i}`,
      deletedAt,
    }));
    await db.insert(games).values(seedDeletedGames);
    // All `gameLimit` games are soft-deleted → quota shouldn't fire.
    const newGame = await createGame(userA.id, { title: "active-game" }, "127.0.0.1");
    expect(newGame.title).toBe("active-game");

    // data_sources branch
    const userB = await seedUserDirectly({ email: "quota-sd-b@test.local" });
    const sourceLimit = env.LIMIT_SOURCES_PER_USER;
    const seedDeletedSources = Array.from({ length: sourceLimit }, (_, i) => ({
      userId: userB.id,
      kind: "youtube_channel" as const,
      handleUrl: `https://www.youtube.com/@deleted-${i}`,
      deletedAt,
    }));
    await db.insert(dataSources).values(seedDeletedSources);
    // All `sourceLimit` sources are soft-deleted → quota shouldn't fire.
    const newSource = await createSource(
      userB.id,
      { kind: "youtube_channel", handleUrl: "https://www.youtube.com/@active" },
      "127.0.0.1",
    );
    expect(newSource.handleUrl).toBe("https://www.youtube.com/@active");
  });

  it("Plan 02.2-02: quota.limit_hit audit event written with metadata {kind, limit, current} when guard fires", async () => {
    const userA = await seedUserDirectly({ email: "quota-audit@test.local" });
    const limit = env.LIMIT_GAMES_PER_USER;

    const seedRows = Array.from({ length: limit }, (_, i) => ({
      userId: userA.id,
      title: `seed-${i}`,
    }));
    await db.insert(games).values(seedRows);

    // Trigger the quota guard.
    await expect(
      createGame(userA.id, { title: "trigger 429" }, "127.0.0.1"),
    ).rejects.toBeInstanceOf(AppError);

    // Read back exactly one audit row of action='quota.limit_hit'.
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, userA.id), eq(auditLog.action, "quota.limit_hit")));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toEqual({
      kind: "games",
      limit,
      current: limit,
    });
  });
});
