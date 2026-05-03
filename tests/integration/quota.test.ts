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
//   - createGame   -> withQuotaGuard(userId, "games", ipAddress, ...)
//   - createSource -> withQuotaGuard(userId, "data_sources", ipAddress, ...)
//   - createEvent  -> withQuotaGuard(userId, "events_per_day", ipAddress, ...)
// On exceedance: throws AppError 429 quota_exceeded with metadata
// {kind, limit, current}; writeAudit fires `quota.limit_hit` AFTER the tx
// releases its pool connection (Codex post-P2.1 deadlock fix — see header
// in services/quota.ts).
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

  // Phase 02.2 review (Codex P2.1): the quota guard must be race-free under
  // concurrent same-user requests. Before the fix, count() ran outside the
  // INSERT's transaction so two requests at limit-1 both saw "limit-1" and
  // both INSERTed, ending at limit+1. The fix (withQuotaGuard) wraps the
  // per-user advisory lock + count + INSERT in one db.transaction; same-user
  // concurrent requests serialize on the lock key.
  //
  // Test contract: at limit-1, fire 5 createGame calls in parallel via
  // Promise.allSettled. Exactly ONE must succeed; the rest must reject with
  // AppError quota_exceeded. After all settle, active-games count = limit
  // (NOT limit+4).
  it("Plan 02.2-02 (Codex P2.1): concurrent createGame at limit-1 stays at limit, never exceeds (advisory-lock contract)", async () => {
    const userA = await seedUserDirectly({
      email: `quota-race-g-${Math.random().toString(36).slice(2, 10)}@test.local`,
    });
    const limit = env.LIMIT_GAMES_PER_USER;

    // Seed the user to exactly limit-1 active games.
    const seedRows = Array.from({ length: limit - 1 }, (_, i) => ({
      userId: userA.id,
      title: `seed-${i}`,
    }));
    await db.insert(games).values(seedRows);

    // Fire 5 concurrent createGame requests. The advisory lock + tx inside
    // createGame forces them to serialize per-user; only the first wins.
    const N_CONCURRENT = 5;
    const results = await Promise.allSettled(
      Array.from({ length: N_CONCURRENT }, (_, i) =>
        createGame(userA.id, { title: `race-${i}` }, "127.0.0.1"),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(N_CONCURRENT - 1);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(AppError);
      expect((r as PromiseRejectedResult).reason).toMatchObject({
        code: "quota_exceeded",
        status: 429,
      });
    }

    // DB invariant: exactly `limit` active games — not limit+1, not limit+N.
    const active = await db.select({ id: games.id }).from(games).where(eq(games.userId, userA.id));
    expect(active.length).toBe(limit);
  });

  // Phase 02.2 review (Codex post-P2.1 deadlock fix): when the quota fires,
  // the audit row MUST be emitted AFTER the surrounding transaction releases
  // its pool connection. Otherwise N concurrent over-limit same-user requests
  // (where N >= pool max) deadlock — every tx-held connection waits for an
  // audit-write connection that the pool can never provide.
  //
  // This test fires more concurrent over-limit requests than the app pool's
  // `max` (10 — see db/client.ts POOL_MAX_BY_ROLE.app). Pre-fix this hung
  // indefinitely. Post-fix it completes promptly because the audit-write
  // happens in `finally` AFTER `db.transaction` resolves and the connection
  // is back in the pool.
  it("Plan 02.2-02 (Codex post-fix): N>pool over-limit concurrent requests do NOT deadlock the pool", async () => {
    const userA = await seedUserDirectly({
      email: `quota-pool-deadlock-${Math.random().toString(36).slice(2, 10)}@test.local`,
    });
    const limit = env.LIMIT_GAMES_PER_USER;

    // Seed at exactly the limit so every concurrent request is over-limit
    // and every one of them takes the audit-write path. Pre-fix this would
    // exhaust the connection pool waiting on audit connections.
    const seedRows = Array.from({ length: limit }, (_, i) => ({
      userId: userA.id,
      title: `seed-${i}`,
    }));
    await db.insert(games).values(seedRows);

    // 12 concurrent over-limit requests. Pool max for `app` role is 10, so
    // the pre-fix design would have at least 2 of these starve indefinitely
    // on the audit-write connection while holding the tx connection.
    const N = 12;
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        createGame(userA.id, { title: `over-limit-${i}` }, "127.0.0.1"),
      ),
    );

    // All N requests REJECTED (we're already at the limit) — none hung.
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(N);
    for (const r of results) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(AppError);
      expect((r as PromiseRejectedResult).reason).toMatchObject({
        code: "quota_exceeded",
        status: 429,
      });
    }

    // Every request that hit the limit should have written ONE audit row.
    // (Independent fresh-connection writes — they don't contend with each
    // other or with the tx connections.)
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, userA.id), eq(auditLog.action, "quota.limit_hit")));
    expect(audits.length).toBe(N);
  }, 30_000);
});
