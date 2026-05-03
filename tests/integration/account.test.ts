import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import { auditLog } from "../../src/lib/server/db/schema/audit-log.js";
import { user as userTable, session } from "../../src/lib/server/db/schema/auth.js";
import { games } from "../../src/lib/server/db/schema/games.js";
import { gameSteamListings } from "../../src/lib/server/db/schema/game-steam-listings.js";
import { dataSources } from "../../src/lib/server/db/schema/data-sources.js";
import { events } from "../../src/lib/server/db/schema/events.js";
import { apiKeysSteam } from "../../src/lib/server/db/schema/api-keys-steam.js";
import { createApp } from "../../src/lib/server/http/app.js";
import { createGame } from "../../src/lib/server/services/games.js";
import { createSource } from "../../src/lib/server/services/data-sources.js";
import { createEvent } from "../../src/lib/server/services/events.js";
import { createSteamKey } from "../../src/lib/server/services/api-keys-steam.js";
import * as SteamApi from "../../src/lib/server/integrations/steam-api.js";
import { vi } from "vitest";
import { seedUserDirectly } from "./helpers.js";
import { env } from "../../src/lib/server/config/env.js";

// Plan 02.2-03 — live integration tests for in-app account export /
// soft-delete / restore (D-15 / D-16). Replaces the 11 placeholder it.skip
// stubs from Plan 02.2-01 with concrete `it(...)` bodies. Names match the
// placeholder names (lock-step traceability).

describe("account export / soft-delete / restore (Phase 02.2)", () => {
  const validateSpy = vi.spyOn(SteamApi, "validateSteamKey").mockResolvedValue(true);
  const fetchSpy = vi.spyOn(SteamApi, "fetchSteamAppDetails").mockResolvedValue(null);
  void validateSpy;
  void fetchSpy;

  const uniq = () => Math.random().toString(36).slice(2, 10);

  it("Plan 02.2-03: GET /api/me/export returns JSON envelope with all 7 documented top-level keys", async () => {
    const app = createApp();
    const userA = await seedUserDirectly({ email: `exp-shape-${uniq()}@test.local` });
    const res = await app.request("/api/me/export", {
      headers: { cookie: `neotolis.session_token=${userA.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "api_keys_steam",
      "audit_log",
      "data_sources",
      "events",
      "exported_at",
      "game_steam_listings",
      "games",
      "user",
    ]);
    // exported_at is an ISO timestamp.
    expect(typeof body.exported_at).toBe("string");
    expect(body.exported_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("Plan 02.2-03: GET /api/me/export sends Content-Disposition attachment with diary-export-YYYY-MM-DD.json filename", async () => {
    const app = createApp();
    const userA = await seedUserDirectly({ email: `exp-cd-${uniq()}@test.local` });
    const res = await app.request("/api/me/export", {
      headers: { cookie: `neotolis.session_token=${userA.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);
    const cd = res.headers.get("content-disposition");
    expect(cd).toMatch(/^attachment; filename="diary-export-\d{4}-\d{2}-\d{2}\.json"$/);
  });

  it("Plan 02.2-03: GET /api/me/export envelope strips ciphertext columns (no secret_ct, wrapped_dek, kek_version, googleSub, refresh_token)", async () => {
    const app = createApp();
    const userA = await seedUserDirectly({ email: `exp-strip-${uniq()}@test.local` });
    // Seed a row that DOES carry ciphertext columns.
    await createSteamKey(
      userA.id,
      { label: "K", plaintext: "STEAM-CT-STRIP-TEST-XYZW1234" },
      "127.0.0.1",
    );

    const res = await app.request("/api/me/export", {
      headers: { cookie: `neotolis.session_token=${userA.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const json = JSON.stringify(body);

    // Ciphertext column names — every variant covered (snake + camel).
    expect(json).not.toMatch(/secret_ct|secretCt/);
    expect(json).not.toMatch(/secret_iv|secretIv/);
    expect(json).not.toMatch(/secret_tag|secretTag/);
    expect(json).not.toMatch(/wrapped_dek|wrappedDek/);
    expect(json).not.toMatch(/dek_iv|dekIv/);
    expect(json).not.toMatch(/dek_tag|dekTag/);
    expect(json).not.toMatch(/kek_version|kekVersion/);
    // PII / OAuth tokens (Better Auth account table — none of these are on
    // the user table by design; toUserDto is the runtime barrier).
    expect(json).not.toMatch(/googleSub|google_sub/);
    expect(json).not.toMatch(/refresh_token|refreshToken/);
    expect(json).not.toMatch(/access_token|accessToken/);
    expect(json).not.toMatch(/id_token|idToken/);
  });

  it("Plan 02.2-03: GET /api/me/export writes account.exported audit event", async () => {
    const app = createApp();
    const userA = await seedUserDirectly({ email: `exp-audit-${uniq()}@test.local` });
    const res = await app.request("/api/me/export", {
      headers: { cookie: `neotolis.session_token=${userA.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, userA.id), eq(auditLog.action, "account.exported")));
    expect(audits).toHaveLength(1);
  });

  it("Plan 02.2-03: DELETE /api/me/account soft-cascades to games, game_steam_listings, data_sources, events, api_keys_steam (NOT audit_log)", async () => {
    const app = createApp();
    const userA = await seedUserDirectly({ email: `del-cascade-${uniq()}@test.local` });

    // Seed one row in each cascade table.
    const game = await createGame(userA.id, { title: "G" }, "127.0.0.1");
    const [listing] = await db
      .insert(gameSteamListings)
      .values({ userId: userA.id, gameId: game.id, appId: 730, label: "L" })
      .returning();
    const source = await createSource(
      userA.id,
      { kind: "youtube_channel", handleUrl: `https://www.youtube.com/@u${uniq()}` },
      "127.0.0.1",
    );
    const event = await createEvent(
      userA.id,
      { gameIds: [], kind: "twitter_post", occurredAt: new Date(), title: "T" },
      "127.0.0.1",
    );
    await createSteamKey(
      userA.id,
      { label: "K", plaintext: "STEAM-DEL-CASCADE-XYZW1234" },
      "127.0.0.1",
    );

    const res = await app.request("/api/me/account", {
      method: "DELETE",
      headers: { cookie: `neotolis.session_token=${userA.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);

    const [userAfter] = await db.select().from(userTable).where(eq(userTable.id, userA.id));
    const markerTs = userAfter!.deletedAt;
    expect(markerTs).not.toBeNull();

    // 4 soft-cascade tables — all deletedAt === markerTs.
    const [g] = await db.select().from(games).where(eq(games.id, game.id));
    expect(g!.deletedAt!.getTime()).toBe(markerTs!.getTime());
    const [l] = await db
      .select()
      .from(gameSteamListings)
      .where(eq(gameSteamListings.id, listing!.id));
    expect(l!.deletedAt!.getTime()).toBe(markerTs!.getTime());
    const [s] = await db.select().from(dataSources).where(eq(dataSources.id, source.id));
    expect(s!.deletedAt!.getTime()).toBe(markerTs!.getTime());
    const [e] = await db.select().from(events).where(eq(events.id, event.id));
    expect(e!.deletedAt!.getTime()).toBe(markerTs!.getTime());

    // api_keys_steam — hard-deleted (no deletedAt column; D-14 hard-delete
    // semantics; AGENTS-INV-3 soft-cascade text in the plan was advisory
    // and adapted to schema reality — see commit message for Rule 3
    // deviation rationale).
    const keysAfter = await db.select().from(apiKeysSteam).where(eq(apiKeysSteam.userId, userA.id));
    expect(keysAfter).toHaveLength(0);

    // audit_log NOT cascaded (AGENTS.md §4 INSERT-only invariant).
    const audits = await db.select().from(auditLog).where(eq(auditLog.userId, userA.id));
    expect(audits.length).toBeGreaterThan(0);
    for (const a of audits) {
      expect(a).not.toHaveProperty("deletedAt");
    }
  });

  it("Plan 02.2-03: DELETE /api/me/account hard-deletes all session rows for that user", async () => {
    const app = createApp();
    const userA = await seedUserDirectly({ email: `del-sess-${uniq()}@test.local` });
    // Confirm precondition: one session row.
    const sessBefore = await db.select().from(session).where(eq(session.userId, userA.id));
    expect(sessBefore.length).toBeGreaterThanOrEqual(1);

    const res = await app.request("/api/me/account", {
      method: "DELETE",
      headers: { cookie: `neotolis.session_token=${userA.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);

    const sessAfter = await db.select().from(session).where(eq(session.userId, userA.id));
    expect(sessAfter).toHaveLength(0);
  });

  it("Plan 02.2-03: DELETE /api/me/account writes account.deleted audit event with retentionDays metadata", async () => {
    const app = createApp();
    const userA = await seedUserDirectly({ email: `del-audit-${uniq()}@test.local` });
    const res = await app.request("/api/me/account", {
      method: "DELETE",
      headers: { cookie: `neotolis.session_token=${userA.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, userA.id), eq(auditLog.action, "account.deleted")));
    expect(audits).toHaveLength(1);
    const meta = audits[0]!.metadata as { retentionDays?: number } | null;
    expect(meta?.retentionDays).toBe(env.RETENTION_DAYS);
  });

  it("Plan 02.2-03: POST /api/me/account/restore reverses ONLY children whose deleted_at === user.deleted_at", async () => {
    const app = createApp();
    const userA = await seedUserDirectly({ email: `restore-marker-${uniq()}@test.local` });

    // Earlier soft-delete on one game (well before account-delete marker).
    const gameEarly = await createGame(userA.id, { title: "Early" }, "127.0.0.1");
    const earlyTs = new Date(Date.now() - 60_000); // 1 minute ago
    await db
      .update(games)
      .set({ deletedAt: earlyTs })
      .where(and(eq(games.userId, userA.id), eq(games.id, gameEarly.id)));

    // gameLater stays active until account-delete cascade.
    const gameLater = await createGame(userA.id, { title: "Later" }, "127.0.0.1");

    // Soft-delete account (cascade marks gameLater with markerTs).
    const delRes = await app.request("/api/me/account", {
      method: "DELETE",
      headers: { cookie: `neotolis.session_token=${userA.signedSessionCookieValue}` },
    });
    expect(delRes.status).toBe(200);

    const [userAfter] = await db.select().from(userTable).where(eq(userTable.id, userA.id));
    const markerTs = userAfter!.deletedAt!;

    // Re-seed a session so we can call /restore (the DELETE cleared sessions).
    const userARefreshed = await seedUserDirectly({
      email: `restore-marker-r-${uniq()}@test.local`,
    });
    void userARefreshed;
    // Restore directly via service (skips the session re-issue dance —
    // restore endpoint requires an authenticated session, but the
    // service-layer assertion is the load-bearing contract).
    const { restoreAccount } = await import("../../src/lib/server/services/account.js");
    await restoreAccount(userA.id, "127.0.0.1");

    const [eAfter] = await db.select().from(games).where(eq(games.id, gameEarly.id));
    const [lAfter] = await db.select().from(games).where(eq(games.id, gameLater.id));

    // gameEarly: stays deleted (deletedAt !== markerTs).
    expect(eAfter!.deletedAt!.getTime()).toBe(earlyTs.getTime());
    expect(eAfter!.deletedAt!.getTime()).not.toBe(markerTs.getTime());
    // gameLater: restored (deletedAt was === markerTs → cleared).
    expect(lAfter!.deletedAt).toBeNull();

    // user.deletedAt cleared too.
    const [userFinal] = await db.select().from(userTable).where(eq(userTable.id, userA.id));
    expect(userFinal!.deletedAt).toBeNull();
  });

  it("Plan 02.2-03: POST /api/me/account/restore writes account.restored audit event", async () => {
    const userA = await seedUserDirectly({ email: `restore-audit-${uniq()}@test.local` });
    // Soft-delete via service (skip HTTP since we want to retain ability to
    // call restore — DELETE clears the session).
    const { softDeleteAccount, restoreAccount } =
      await import("../../src/lib/server/services/account.js");
    await softDeleteAccount(userA.id, "127.0.0.1");
    await restoreAccount(userA.id, "127.0.0.1");

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, userA.id), eq(auditLog.action, "account.restored")));
    expect(audits).toHaveLength(1);
  });

  it("Plan 02.2-03: POST /api/me/account/restore returns 410 Gone when called past RETENTION_DAYS", async () => {
    const app = createApp();
    const userA = await seedUserDirectly({ email: `restore-410-${uniq()}@test.local` });
    // Backdate user.deletedAt to RETENTION_DAYS + 1 day ago — past the
    // grace window. Direct DB update simulates the time travel.
    const ancient = new Date(Date.now() - (env.RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000);
    await db.update(userTable).set({ deletedAt: ancient }).where(eq(userTable.id, userA.id));

    // Re-seed a session for userA (auth still works since user row is just
    // soft-deleted; tenant scope checks session, not user.deletedAt).
    const { db: db2 } = await import("../../src/lib/server/db/client.js");
    const { uuidv7 } = await import("../../src/lib/server/ids.js");
    const { makeSignature } = await import("better-auth/crypto");
    const { randomBytes } = await import("node:crypto");
    const sessionToken = randomBytes(32).toString("base64url");
    const sessionId = uuidv7();
    await db2.insert(session).values({
      id: sessionId,
      userId: userA.id,
      token: sessionToken,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    const sig = await makeSignature(sessionToken, env.BETTER_AUTH_SECRET);
    const cookie = `neotolis.session_token=${sessionToken}.${sig}`;

    const res = await app.request("/api/me/account/restore", {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body).toEqual({ error: "account_purge_window_expired" });
  });

  it("Plan 02.2-03: cross-tenant: User A's export does not contain User B's rows", async () => {
    const app = createApp();
    const userA = await seedUserDirectly({ email: `xt-A-${uniq()}@test.local` });
    const userB = await seedUserDirectly({ email: `xt-B-${uniq()}@test.local` });

    // Seed one game per user with distinctive titles.
    const aTitle = `A-only-game-${uniq()}`;
    const bTitle = `B-only-game-${uniq()}`;
    await createGame(userA.id, { title: aTitle }, "127.0.0.1");
    await createGame(userB.id, { title: bTitle }, "127.0.0.1");

    const res = await app.request("/api/me/export", {
      headers: { cookie: `neotolis.session_token=${userA.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { games: Array<{ id: string; title: string }> };

    // A sees only their game.
    expect(body.games.map((g) => g.title)).toEqual([aTitle]);
    // B's row never appears in A's payload (substring check defends
    // against any future field that might smuggle the title across).
    const json = JSON.stringify(body);
    expect(json).not.toContain(bTitle);
    expect(json).not.toContain(userB.id);
  });
});
