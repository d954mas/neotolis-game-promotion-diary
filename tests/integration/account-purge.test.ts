// Phase 3.0 Plan 05 — activated suite for purgeAccount + listPurgeEligibleUsers.
//
// Replaces the 4 it.skip stubs Plan 02 instantiated. Plan 08 will add the
// HTTP-level DELETE /api/me/account/purge route + its own integration
// suite; this file covers the SERVICE layer (the contract Plan 09's worker
// + Plan 08's route both depend on).
//
// Cascade chain (FK-respecting order, single tx):
//   api_keys_steam → event_games → events → game_steam_listings →
//   data_sources → games → session → user
//
// Invariants under test:
//   - Eligibility gate: deletedAt null OR within RETENTION_DAYS → no-op.
//   - ignoreRetention=true bypasses the gate (CTA path).
//   - Idempotent: re-run on already-purged user is a no-op (counts all 0).
//   - Audit purge.completed scoped to the PURGED user_id (Open Question 4).
//   - audit_log NOT cascaded (AGENTS.md §4 INSERT-only invariant).
//   - Cross-tenant integrity: user A's purge does not touch user B's rows.
//   - Migration 0011 dropped audit_log.user_id FK so the audit row INSERT
//     succeeds even though the user row is gone.

import { describe, it, expect, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import { auditLog } from "../../src/lib/server/db/schema/audit-log.js";
import { user as userTable, session } from "../../src/lib/server/db/schema/auth.js";
import { games } from "../../src/lib/server/db/schema/games.js";
import { gameSteamListings } from "../../src/lib/server/db/schema/game-steam-listings.js";
import { dataSources } from "../../src/lib/server/db/schema/data-sources.js";
import { events } from "../../src/lib/server/db/schema/events.js";
import { apiKeysSteam } from "../../src/lib/server/db/schema/api-keys-steam.js";
import { eventGames } from "../../src/lib/server/db/schema/event-games.js";
import {
  purgeAccount,
  listPurgeEligibleUsers,
} from "../../src/lib/server/services/purge-account.js";
import { createGame } from "../../src/lib/server/services/games.js";
import { createSource } from "../../src/lib/server/services/data-sources.js";
import { createEvent } from "../../src/lib/server/services/events.js";
import { createSteamKey } from "../../src/lib/server/services/api-keys-steam.js";
import * as SteamApi from "../../src/lib/server/integrations/steam-api.js";
import { seedUserDirectly } from "./helpers.js";
import { env } from "../../src/lib/server/config/env.js";

describe("purgeAccount service (Plan 03.0-05)", () => {
  // Same Steam API mocks as account.test.ts — Plan 02 createSteamKey path
  // calls validateSteamKey + fetchSteamAppDetails internally.
  const validateSpy = vi.spyOn(SteamApi, "validateSteamKey").mockResolvedValue(true);
  const fetchSpy = vi.spyOn(SteamApi, "fetchSteamAppDetails").mockResolvedValue(null);
  void validateSpy;
  void fetchSpy;

  const uniq = () => Math.random().toString(36).slice(2, 10);

  /** Seed a user with one row in each cascade-table so cascade order is exercised. */
  async function seedFullFixture(emailPrefix: string) {
    const u = await seedUserDirectly({ email: `${emailPrefix}-${uniq()}@test.local` });
    const game = await createGame(u.id, { title: `G-${uniq()}` }, "127.0.0.1");
    const [listing] = await db
      .insert(gameSteamListings)
      .values({ userId: u.id, gameId: game.id, appId: 730, label: "L" })
      .returning();
    const source = await createSource(
      u.id,
      { kind: "youtube_channel", handleUrl: `https://www.youtube.com/@u${uniq()}` },
      "127.0.0.1",
    );
    const event = await createEvent(
      u.id,
      {
        gameIds: [game.id],
        kind: "twitter_post",
        occurredAt: new Date(),
        title: `T-${uniq()}`,
      },
      "127.0.0.1",
    );
    await createSteamKey(
      u.id,
      { label: `K-${uniq()}`, plaintext: `STEAM-PURGE-FIXTURE-${uniq()}AB12` },
      "127.0.0.1",
    );
    return { user: u, game, listing: listing!, source, event };
  }

  /**
   * Test 1 — eligibility gate: active user (deletedAt = null) with
   * ignoreRetention=false returns {purged: false} and DOES NOT touch DB.
   */
  it("returns {purged: false} when user.deletedAt is null and ignoreRetention=false", async () => {
    const { user: u, game } = await seedFullFixture("eligibility-active");

    const result = await purgeAccount(u.id);

    expect(result.purged).toBe(false);
    expect(result.rowCounts).toBeUndefined();
    // User row + game still present.
    const [stillThere] = await db.select().from(userTable).where(eq(userTable.id, u.id));
    expect(stillThere?.id).toBe(u.id);
    const [gameStill] = await db.select().from(games).where(eq(games.id, game.id));
    expect(gameStill?.id).toBe(game.id);
    // No purge.completed audit row.
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, "purge.completed")));
    expect(audits).toHaveLength(0);
  });

  /**
   * Test 2 — eligibility gate: deletedAt within RETENTION_DAYS → no-op.
   */
  it("returns {purged: false} when deletedAt is within RETENTION_DAYS", async () => {
    const { user: u } = await seedFullFixture("eligibility-recent");
    // 30d ago — well within the default 60d retention.
    const recent = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await db.update(userTable).set({ deletedAt: recent }).where(eq(userTable.id, u.id));

    const result = await purgeAccount(u.id);

    expect(result.purged).toBe(false);
    const [stillThere] = await db.select().from(userTable).where(eq(userTable.id, u.id));
    expect(stillThere?.id).toBe(u.id); // user row still present
  });

  /**
   * Test 3 — eligibility passes: deletedAt past RETENTION_DAYS → cascade runs.
   */
  it("hard-deletes all cascade rows when deletedAt is past RETENTION_DAYS", async () => {
    const { user: u, game, listing, source, event } = await seedFullFixture("eligibility-old");
    // RETENTION_DAYS + 1d ago.
    const ancient = new Date(Date.now() - (env.RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000);
    await db.update(userTable).set({ deletedAt: ancient }).where(eq(userTable.id, u.id));

    const result = await purgeAccount(u.id);

    expect(result.purged).toBe(true);
    expect(result.rowCounts).toBeDefined();
    expect(result.rowCounts!.user).toBe(1);
    expect(result.rowCounts!.games).toBe(1);
    expect(result.rowCounts!.dataSources).toBe(1);
    expect(result.rowCounts!.events).toBe(1);
    expect(result.rowCounts!.gameSteamListings).toBe(1);
    expect(result.rowCounts!.apiKeysSteam).toBe(1);
    expect(result.rowCounts!.eventGames).toBe(1);
    expect(result.rowCounts!.sessions).toBeGreaterThanOrEqual(1);

    // Every cascade table is empty for this user.
    const u1 = await db.select().from(userTable).where(eq(userTable.id, u.id));
    expect(u1).toHaveLength(0);
    const g1 = await db.select().from(games).where(eq(games.id, game.id));
    expect(g1).toHaveLength(0);
    const l1 = await db
      .select()
      .from(gameSteamListings)
      .where(eq(gameSteamListings.id, listing.id));
    expect(l1).toHaveLength(0);
    const s1 = await db.select().from(dataSources).where(eq(dataSources.id, source.id));
    expect(s1).toHaveLength(0);
    const e1 = await db.select().from(events).where(eq(events.id, event.id));
    expect(e1).toHaveLength(0);
    const k1 = await db.select().from(apiKeysSteam).where(eq(apiKeysSteam.userId, u.id));
    expect(k1).toHaveLength(0);
    const eg1 = await db.select().from(eventGames).where(eq(eventGames.userId, u.id));
    expect(eg1).toHaveLength(0);
    const sess1 = await db.select().from(session).where(eq(session.userId, u.id));
    expect(sess1).toHaveLength(0);
  });

  /**
   * Test 4 — ignoreRetention=true bypasses the 60-day gate. CTA path
   * (Permanent-delete-now button on AccountDeletedBanner — Plan 08).
   */
  it("ignoreRetention=true purges immediately even when deletedAt is null", async () => {
    const { user: u, game } = await seedFullFixture("cta-immediate");
    // user.deletedAt is null — cron path would skip; CTA path proceeds.

    const result = await purgeAccount(u.id, { ignoreRetention: true });

    expect(result.purged).toBe(true);
    expect(result.rowCounts!.user).toBe(1);
    expect(result.rowCounts!.games).toBe(1);

    const u1 = await db.select().from(userTable).where(eq(userTable.id, u.id));
    expect(u1).toHaveLength(0);
    const g1 = await db.select().from(games).where(eq(games.id, game.id));
    expect(g1).toHaveLength(0);
  });

  /**
   * Test 5 — idempotency: re-running on already-purged user is a no-op
   * (all row counts zero) and DOES NOT throw.
   */
  it("is idempotent — re-run on already-purged user returns all-zero counts", async () => {
    const { user: u } = await seedFullFixture("idempotent");
    await purgeAccount(u.id, { ignoreRetention: true });

    // Second invocation — every WHERE clause matches zero rows.
    const result = await purgeAccount(u.id, { ignoreRetention: true });

    expect(result.purged).toBe(true);
    expect(result.rowCounts).toEqual({
      apiKeysSteam: 0,
      events: 0,
      eventGames: 0,
      gameSteamListings: 0,
      dataSources: 0,
      games: 0,
      sessions: 0,
      user: 0,
    });
  });

  /**
   * Test 6 — audit purge.completed row written under purged user_id with
   * metadata.row_counts populated. Open Question 4 contract: scoped to
   * the PURGED user, not an operator.
   */
  it("writes one purge.completed audit row scoped to the purged user_id with row_counts metadata", async () => {
    const { user: u } = await seedFullFixture("audit-row");

    const result = await purgeAccount(u.id, { ignoreRetention: true });
    expect(result.purged).toBe(true);

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, "purge.completed")));
    expect(audits).toHaveLength(1);
    const meta = audits[0]!.metadata as {
      row_counts?: { user?: number; games?: number };
      ignore_retention?: boolean;
      purged_at?: string;
    } | null;
    expect(meta?.row_counts?.user).toBe(1);
    expect(meta?.row_counts?.games).toBe(1);
    expect(meta?.ignore_retention).toBe(true);
    expect(typeof meta?.purged_at).toBe("string");
  });

  /**
   * Test 7 — cross-tenant audit-log integrity: user B's audit rows are
   * untouched by user A's purge. AGENTS.md §4 INSERT-only invariant +
   * audit_log NOT cascaded by user delete (migration 0011 dropped the FK).
   */
  it("cross-tenant: user B's audit rows are intact after user A is purged", async () => {
    const { user: userA } = await seedFullFixture("xt-audit-a");
    const { user: userB } = await seedFullFixture("xt-audit-b");
    // Both users now have multiple audit rows (createGame, createSource,
    // createEvent, createSteamKey each emit at least one).
    const bAuditsBefore = await db.select().from(auditLog).where(eq(auditLog.userId, userB.id));
    expect(bAuditsBefore.length).toBeGreaterThan(0);

    await purgeAccount(userA.id, { ignoreRetention: true });

    const bAuditsAfter = await db.select().from(auditLog).where(eq(auditLog.userId, userB.id));
    // User B's audit log is byte-for-byte intact (count + ids).
    expect(bAuditsAfter.length).toBe(bAuditsBefore.length);
    expect(bAuditsAfter.map((a) => a.id).sort()).toEqual(bAuditsBefore.map((a) => a.id).sort());

    // User A's pre-purge audit rows ALSO survive (audit_log NOT cascaded).
    const aAuditsAfter = await db.select().from(auditLog).where(eq(auditLog.userId, userA.id));
    expect(aAuditsAfter.length).toBeGreaterThan(0);
    // ...and the new purge.completed row is among them.
    expect(aAuditsAfter.some((a) => a.action === "purge.completed")).toBe(true);
  });

  /**
   * Test 8 — cascade order respects FKs: a fully-loaded user (events
   * attached to games via event_games junction, listings under games,
   * source emitting an event etc.) purges without throwing a constraint
   * violation. The cascade chain is the assertion: if the order were
   * wrong, Postgres would raise.
   */
  it("cascade respects FK order — populated fixture purges without constraint violation", async () => {
    const u = await seedUserDirectly({ email: `cascade-order-${uniq()}@test.local` });
    // Two games + two listings + a source + an auto-imported event attached
    // to BOTH games via the junction (event_games is M:N — Plan 02.1-27).
    const g1 = await createGame(u.id, { title: `G1-${uniq()}` }, "127.0.0.1");
    const g2 = await createGame(u.id, { title: `G2-${uniq()}` }, "127.0.0.1");
    await db
      .insert(gameSteamListings)
      .values({ userId: u.id, gameId: g1.id, appId: 100, label: "L1" });
    await db
      .insert(gameSteamListings)
      .values({ userId: u.id, gameId: g2.id, appId: 200, label: "L2" });
    const source = await createSource(
      u.id,
      { kind: "youtube_channel", handleUrl: `https://www.youtube.com/@multi${uniq()}` },
      "127.0.0.1",
    );
    void source;
    const ev = await createEvent(
      u.id,
      {
        gameIds: [g1.id, g2.id], // multi-attach via event_games
        kind: "youtube_video",
        occurredAt: new Date(),
        title: `multi-game video ${uniq()}`,
        externalId: `vid-${uniq()}`,
      },
      "127.0.0.1",
    );
    void ev;
    // event_games junction must have 2 rows for this user.
    const egBefore = await db.select().from(eventGames).where(eq(eventGames.userId, u.id));
    expect(egBefore.length).toBe(2);

    // No throw == cascade order is correct. event_games must be deleted
    // BEFORE events (FK to events.id) — wrong order would raise 23503.
    const result = await purgeAccount(u.id, { ignoreRetention: true });

    expect(result.purged).toBe(true);
    expect(result.rowCounts!.eventGames).toBe(2);
    expect(result.rowCounts!.events).toBe(1);
    expect(result.rowCounts!.games).toBe(2);
    expect(result.rowCounts!.gameSteamListings).toBe(2);
    expect(result.rowCounts!.user).toBe(1);
  });

  /**
   * Test 9 — listPurgeEligibleUsers respects the 60-day cutoff.
   * Active users (deletedAt IS NULL) are excluded by construction.
   */
  it("listPurgeEligibleUsers returns user_ids past RETENTION_DAYS only", async () => {
    const userActive = await seedUserDirectly({
      email: `eligible-active-${uniq()}@test.local`,
    });
    const userRecent = await seedUserDirectly({
      email: `eligible-recent-${uniq()}@test.local`,
    });
    const userOld = await seedUserDirectly({ email: `eligible-old-${uniq()}@test.local` });

    // recent: 30d ago — within retention.
    await db
      .update(userTable)
      .set({ deletedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) })
      .where(eq(userTable.id, userRecent.id));
    // old: RETENTION_DAYS + 1d ago — past retention.
    await db
      .update(userTable)
      .set({
        deletedAt: new Date(Date.now() - (env.RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000),
      })
      .where(eq(userTable.id, userOld.id));

    const eligible = await listPurgeEligibleUsers();

    expect(eligible).toContain(userOld.id);
    expect(eligible).not.toContain(userActive.id);
    expect(eligible).not.toContain(userRecent.id);
  });

  /**
   * Test 10 — cross-tenant data integrity: user A's purge does not delete
   * any of user B's user-owned rows. Tenant scope (AGENTS.md §1) verified
   * at the cascade level.
   */
  it("cross-tenant: user B's rows are intact after user A is purged", async () => {
    const fixA = await seedFullFixture("xt-rows-a");
    const fixB = await seedFullFixture("xt-rows-b");

    await purgeAccount(fixA.user.id, { ignoreRetention: true });

    // user B: every row still present.
    const [uB] = await db.select().from(userTable).where(eq(userTable.id, fixB.user.id));
    expect(uB?.id).toBe(fixB.user.id);
    const [gB] = await db.select().from(games).where(eq(games.id, fixB.game.id));
    expect(gB?.id).toBe(fixB.game.id);
    const [lB] = await db
      .select()
      .from(gameSteamListings)
      .where(eq(gameSteamListings.id, fixB.listing.id));
    expect(lB?.id).toBe(fixB.listing.id);
    const [sB] = await db.select().from(dataSources).where(eq(dataSources.id, fixB.source.id));
    expect(sB?.id).toBe(fixB.source.id);
    const [eB] = await db.select().from(events).where(eq(events.id, fixB.event.id));
    expect(eB?.id).toBe(fixB.event.id);
    const kBs = await db.select().from(apiKeysSteam).where(eq(apiKeysSteam.userId, fixB.user.id));
    expect(kBs.length).toBeGreaterThanOrEqual(1);
  });

  it("Phase 03.0.3 round-8 (Codex P1): purgeAccount deletes outbox rows that reference the purged user via payload.triggerUserId", async () => {
    // Force-deep enqueue lands a row in `outbox` carrying triggerUserId
    // inside the payload. If the user purges before the forwarder has
    // dispatched the row to pg-boss, the dangling row would later
    // enqueue a worker job under a deleted tenant — privacy violation.
    // purgeAccount must scrub user-scoped outbox rows in the same
    // cascade transaction so this race closes by construction.
    const { user: u } = await seedFullFixture("outbox-scrub");

    // Seed two pending outbox rows referencing this user, one
    // referencing a DIFFERENT user (must survive).
    const otherUser = await seedFullFixture("outbox-scrub-other");
    await db.execute(sql`
      INSERT INTO outbox (queue, payload, options) VALUES
        ('youtube.backfill.channel',
         ${JSON.stringify({ kind: "youtube_channel", channelKey: "UCabc", triggerUserId: u.id, depthBoundIso: "1970-01-01T00:00:00.000Z", flow: "historical", forceDeep: true })}::jsonb,
         '{}'::jsonb),
        ('youtube.backfill.channel',
         ${JSON.stringify({ kind: "youtube_channel", channelKey: "UCdef", triggerUserId: u.id, depthBoundIso: "1970-01-01T00:00:00.000Z", flow: "historical", forceDeep: true })}::jsonb,
         '{}'::jsonb),
        ('youtube.backfill.channel',
         ${JSON.stringify({ kind: "youtube_channel", channelKey: "UCxyz", triggerUserId: otherUser.user.id, depthBoundIso: "1970-01-01T00:00:00.000Z", flow: "historical", forceDeep: true })}::jsonb,
         '{}'::jsonb)
    `);

    const result = await purgeAccount(u.id, { ignoreRetention: true });

    expect(result.purged).toBe(true);
    expect(result.rowCounts!.outbox).toBe(2);

    // Purged user's outbox rows are gone.
    const purgedRows = await db.execute(sql`
      SELECT id FROM outbox WHERE payload->>'triggerUserId' = ${u.id}
    `);
    expect(purgedRows.rows.length).toBe(0);

    // Other user's outbox row survives (cross-tenant isolation).
    const otherRows = await db.execute(sql`
      SELECT id FROM outbox WHERE payload->>'triggerUserId' = ${otherUser.user.id}
    `);
    expect(otherRows.rows.length).toBe(1);

    // Cleanup.
    await db.execute(sql`DELETE FROM outbox WHERE payload->>'triggerUserId' = ${otherUser.user.id}`);
  });
});

// Phase 3.0 Plan 08 — DELETE /api/me/account/purge route activation.
//
// The Permanent-delete-now CTA path (DV-6 / D-NEW Purge worker). The route
// operates on c.var.userId only — there is NO :userId path parameter (the
// account-routes precedent from Plan 02.2-03), so cross-tenant access is
// impossible by construction. Calls purgeAccount({ignoreRetention: true})
// from the Plan 05 service so it works whether or not the user has been
// soft-deleted (the soft-deleted variant is the primary CTA target;
// active-user purge is allowed too — the user is permitted to nuke their
// account immediately without going through the soft-delete tripwire).
//
// The HTTP boundary tests below complement Plan 05's service-layer suite.
// The cascade-correctness invariants are owned by the service tests; these
// tests assert the wire format, the auth gate, the audit row presence, and
// the post-purge session invalidation contract.
describe("account purge route (Plan 03.0-08)", () => {
  const uniq = (): string => Math.random().toString(36).slice(2, 10);

  it("Plan 03.0-08: DELETE /api/me/account/purge hard-deletes user rows for an active user (CTA path, ignoreRetention=true)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `ap-active-${uniq()}@test.local` });
    const game = await createGame(u.id, { title: `G-${uniq()}` }, "127.0.0.1");

    const res = await app.request("/api/me/account/purge", {
      method: "DELETE",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      purged: boolean;
      rowCounts?: { user?: number; games?: number };
    };
    expect(body.purged).toBe(true);
    expect(body.rowCounts?.user).toBe(1);
    expect(body.rowCounts?.games).toBe(1);

    // User + game are hard-deleted from the DB.
    const u1 = await db.select().from(userTable).where(eq(userTable.id, u.id));
    expect(u1).toHaveLength(0);
    const g1 = await db.select().from(games).where(eq(games.id, game.id));
    expect(g1).toHaveLength(0);
  });

  it("Plan 03.0-08: DELETE /api/me/account/purge works for a soft-deleted user (CTA target — bypasses 60d gate)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `ap-soft-${uniq()}@test.local` });
    // Mark user as soft-deleted via direct DB write (mimics the post-soft-
    // delete state where Better Auth re-issued a session on the next sign-in).
    await db
      .update(userTable)
      .set({ deletedAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
      .where(eq(userTable.id, u.id));

    const res = await app.request("/api/me/account/purge", {
      method: "DELETE",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { purged: boolean };
    expect(body.purged).toBe(true);

    // User is gone — would be 0 rows.
    const u1 = await db.select().from(userTable).where(eq(userTable.id, u.id));
    expect(u1).toHaveLength(0);
  });

  it("Plan 03.0-08: after 200 purge, subsequent /api/me request with the same session cookie returns 401 (session cascade-deleted)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `ap-sess-${uniq()}@test.local` });

    const purgeRes = await app.request("/api/me/account/purge", {
      method: "DELETE",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(purgeRes.status).toBe(200);

    // Same cookie, fresh request — session gone (purgeAccount cascaded
    // session DELETE in the same tx that deleted the user row).
    const meRes = await app.request("/api/me", {
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(meRes.status).toBe(401);
    expect(await meRes.json()).toEqual({ error: "unauthorized" });
  });

  it("Plan 03.0-08: audit purge.completed row written under purged user_id with metadata.row_counts (HTTP-layer)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `ap-audit-${uniq()}@test.local` });
    await createGame(u.id, { title: `G-${uniq()}` }, "127.0.0.1");

    const res = await app.request("/api/me/account/purge", {
      method: "DELETE",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, "purge.completed")));
    expect(audits).toHaveLength(1);
    const meta = audits[0]!.metadata as {
      row_counts?: { user?: number; games?: number };
      ignore_retention?: boolean;
      purged_at?: string;
    } | null;
    expect(meta?.row_counts?.user).toBe(1);
    expect(meta?.row_counts?.games).toBe(1);
    expect(meta?.ignore_retention).toBe(true);
    expect(typeof meta?.purged_at).toBe("string");
  });

  it("Plan 03.0-08: anonymous DELETE /api/me/account/purge → 401 unauthorized", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();

    const res = await app.request("/api/me/account/purge", { method: "DELETE" });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
});

/**
 * Schema-reflection test for the purge cascade contract (P2-6 from
 * post-build review).
 *
 * The behavioral tests above prove the CURRENT cascade works end-to-end.
 * This test guards the FUTURE: when someone adds a new user-owned table,
 * the cascade contract (every `user_id` column has ON DELETE CASCADE
 * to user(id), or the table is in a documented allowlist) must hold.
 * Without this gate, a new table with a missing FK would silently leave
 * orphan rows after purge — and the existing fixture-based tests would
 * not flag it because they only seed the tables they know about.
 *
 * The test reads `information_schema` directly so it picks up new
 * tables automatically as the schema evolves. The two allowlists are
 * the load-bearing exceptions:
 *   - SURVIVES_PURGE: tables whose user_id rows MUST outlive a purge
 *     by design (audit_log — migration 0011 dropped its FK precisely
 *     so the purge.completed audit row survives the cascade).
 *   - PURGE_EXPLICIT_NO_CASCADE: tables purgeAccount() handles via an
 *     explicit DELETE inside the transaction so they do not need a
 *     CASCADE FK. Currently empty — every explicit-DELETE table also
 *     happens to carry a CASCADE FK. The set is here to stay flexible
 *     if a future table is intentionally non-cascading.
 */
describe("purge cascade contract (schema reflection)", () => {
  // Tables whose user_id rows are intentionally NOT cascade-deleted with
  // the user. Adding to this set requires a written invariant explaining
  // why the rows must survive (e.g. AGENTS.md §4 for audit_log).
  const SURVIVES_PURGE = new Set<string>(["audit_log"]);

  // Tables purgeAccount() handles via explicit DELETE in its tx. Currently
  // every such table ALSO has a CASCADE FK (belt-and-suspenders), so this
  // set is empty — the schema-FK check covers them. Kept for future use.
  const PURGE_EXPLICIT_NO_CASCADE = new Set<string>([]);

  it("every public.<table>.user_id column either has ON DELETE CASCADE FK to user(id) OR is in the SURVIVES_PURGE allowlist", async () => {
    // information_schema.columns lists EVERY user_id column in public.
    const cols = await db.execute(sql`
      SELECT table_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'user_id'
      ORDER BY table_name
    `);

    // information_schema.referential_constraints + key_column_usage joined
    // gives us the FK constraints with their delete_rule per (table_name, column_name).
    const fks = await db.execute(sql`
      SELECT
        kcu.table_name,
        rc.delete_rule,
        ccu.table_name AS referenced_table
      FROM information_schema.referential_constraints rc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_schema = rc.constraint_schema
       AND kcu.constraint_name = rc.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_schema = rc.constraint_schema
       AND ccu.constraint_name = rc.constraint_name
      WHERE rc.constraint_schema = 'public'
        AND kcu.column_name = 'user_id'
    `);

    const fkByTable = new Map<string, { delete_rule: string; referenced_table: string }>();
    for (const f of fks.rows as {
      table_name: string;
      delete_rule: string;
      referenced_table: string;
    }[]) {
      fkByTable.set(f.table_name, {
        delete_rule: f.delete_rule,
        referenced_table: f.referenced_table,
      });
    }

    const violations: string[] = [];

    for (const c of cols.rows as { table_name: string }[]) {
      const t = c.table_name;
      if (SURVIVES_PURGE.has(t)) {
        // Allowlisted to NOT cascade. Confirm there is genuinely no FK —
        // an accidentally re-introduced FK would defeat migration 0011's
        // audit-survives-purge contract.
        if (fkByTable.has(t)) {
          violations.push(
            `${t}: SURVIVES_PURGE expects no FK on user_id, but found ${fkByTable.get(t)!.delete_rule} FK to ${fkByTable.get(t)!.referenced_table}`,
          );
        }
        continue;
      }
      if (PURGE_EXPLICIT_NO_CASCADE.has(t)) continue;

      const fk = fkByTable.get(t);
      if (!fk) {
        violations.push(`${t}: user_id column has NO FK constraint (orphan after user purge)`);
        continue;
      }
      if (fk.referenced_table !== "user") {
        violations.push(
          `${t}: user_id FK points to ${fk.referenced_table}, expected user (chain mismatch)`,
        );
        continue;
      }
      if (fk.delete_rule !== "CASCADE") {
        violations.push(`${t}: user_id FK has delete_rule=${fk.delete_rule}, expected CASCADE`);
      }
    }

    expect(violations).toEqual([]);
  });
});
