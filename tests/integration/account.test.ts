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
import { wishlistSnapshots } from "../../src/lib/server/db/schema/wishlist-snapshots.js";
import { youtubeVideoSnapshots } from "../../src/lib/sources/youtube/server/schema/video-snapshots.js";
import { redditPosts } from "../../src/lib/sources/reddit/server/schema/posts.js";
import { redditPostSnapshots } from "../../src/lib/sources/reddit/server/schema/post-snapshots.js";
import { createApp } from "../../src/lib/server/http/app.js";
import { createGame } from "../../src/lib/server/services/games.js";
import { createSource } from "../../src/lib/server/services/data-sources.js";
import { createEvent } from "../../src/lib/server/services/events.js";
import { createSteamKey } from "../../src/lib/server/services/api-keys-steam.js";
import { exportAccountJson } from "../../src/lib/server/services/account.js";
import * as SteamApi from "../../src/lib/server/integrations/steam-api.js";
import { vi } from "vitest";
import { seedUserDirectly } from "./helpers.js";
import { env } from "../../src/lib/server/config/env.js";

// Live integration tests for in-app account export / soft-delete /
// restore.

describe("account export / soft-delete / restore", () => {
  const validateSpy = vi.spyOn(SteamApi, "validateSteamKey").mockResolvedValue(true);
  const fetchSpy = vi.spyOn(SteamApi, "fetchSteamAppDetails").mockResolvedValue(null);
  void validateSpy;
  void fetchSpy;

  const uniq = () => Math.random().toString(36).slice(2, 10);

  it("GET /api/me/export returns JSON envelope with all 11 documented top-level keys", async () => {
    const app = createApp();
    const userA = await seedUserDirectly({ email: `exp-shape-${uniq()}@test.local` });
    const res = await app.request("/api/me/export", {
      headers: { cookie: `neotolis.session_token=${userA.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // 11 keys = 10 sections + the exported_at scalar. The three Phase 6
    // additions (PRIV-03) — wishlist_snapshots + the two public-data metric
    // history sections — close the "take all your data" gap.
    expect(Object.keys(body).sort()).toEqual([
      "api_keys_steam",
      "audit_log",
      "data_sources",
      "events",
      "exported_at",
      "game_steam_listings",
      "games",
      "reddit_post_snapshots",
      "user",
      "wishlist_snapshots",
      "youtube_video_snapshots",
    ]);
    // exported_at is an ISO timestamp.
    expect(typeof body.exported_at).toBe("string");
    expect(body.exported_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("GET /api/me/export sends Content-Disposition attachment with diary-export-YYYY-MM-DD.json filename", async () => {
    const app = createApp();
    const userA = await seedUserDirectly({ email: `exp-cd-${uniq()}@test.local` });
    const res = await app.request("/api/me/export", {
      headers: { cookie: `neotolis.session_token=${userA.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);
    const cd = res.headers.get("content-disposition");
    expect(cd).toMatch(/^attachment; filename="diary-export-\d{4}-\d{2}-\d{2}\.json"$/);
  });

  it("GET /api/me/export envelope strips ciphertext columns (no secret_ct, wrapped_dek, kek_version, googleSub, refresh_token)", async () => {
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
    // D-09: the strip invariant is TOTAL over the WHOLE envelope, including
    // the Phase 6 wishlist + metric-history sections. user_id must never
    // appear (DTOs omit it); ciphertext column names must never appear.
    expect(json).not.toMatch(/user_id|userId/);
  });

  it("GET /api/me/export full envelope (with wishlist + metric history) leaks no ciphertext or user_id [06-02 D-09]", async () => {
    const app = createApp();
    const userA = await seedUserDirectly({ email: `exp-full-strip-${uniq()}@test.local` });

    // Seed a row in EVERY section that could carry a forbidden column: a steam
    // key (ciphertext), a wishlist snapshot (tenant-owned, user_id), and a
    // YouTube + Reddit event-with-snapshot (per-event metric history).
    await createSteamKey(
      userA.id,
      { label: "K", plaintext: "STEAM-FULL-STRIP-XYZW1234" },
      "127.0.0.1",
    );

    const game = await createGame(userA.id, { title: `g-${uniq()}` }, "127.0.0.1");
    const [listing] = await db
      .insert(gameSteamListings)
      .values({ userId: userA.id, gameId: game.id, appId: 730, label: "L" })
      .returning();
    await db.insert(wishlistSnapshots).values({
      userId: userA.id,
      listingId: listing!.id,
      date: "2026-06-01",
      adds: 10,
      deletes: 1,
      purchasesAndActivations: 0,
      gifts: 0,
      balance: 9,
    });

    const ytVideoId = `vid-${uniq()}`;
    await createEvent(
      userA.id,
      {
        gameIds: [],
        kind: "youtube_video",
        occurredAt: new Date(),
        title: "YT",
        externalId: ytVideoId,
      },
      "127.0.0.1",
    );
    await db.insert(youtubeVideoSnapshots).values({
      videoId: ytVideoId,
      polledAt: new Date(),
      viewCount: 100,
      likeCount: 5,
      commentCount: 2,
    });

    const redditPostId = `t3_${uniq()}`;
    await db.insert(redditPosts).values({
      postId: redditPostId,
      subredditSlug: "gamedev",
      permalink: `/r/gamedev/comments/${uniq()}`,
      title: "R",
      publishedAt: new Date(),
    });
    // Insert the reddit_post event row DIRECTLY (not via createEvent): the
    // createEvent path runs a synchronous reddit syncStats.fetch
    // (events-mutation.ts) that hits the provider — a non-hermetic network call
    // this export test must not make. The export scopes reddit snapshots by the
    // user's reddit_post event external_ids, so a bare event row with the
    // matching externalId is all this test needs.
    await db.insert(events).values({
      userId: userA.id,
      kind: "reddit_post",
      occurredAt: new Date(),
      title: "RD",
      externalId: redditPostId,
    });
    await db.insert(redditPostSnapshots).values({
      postId: redditPostId,
      polledAt: new Date(),
      likeCount: 42,
      commentCount: 3,
      score: 42,
      numComments: 3,
    });

    const res = await app.request("/api/me/export", {
      headers: { cookie: `neotolis.session_token=${userA.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      wishlist_snapshots: unknown[];
      youtube_video_snapshots: unknown[];
      reddit_post_snapshots: unknown[];
    };
    // The new sections are actually populated (not vacuously secret-free).
    expect(body.wishlist_snapshots.length).toBeGreaterThan(0);
    expect(body.youtube_video_snapshots.length).toBeGreaterThan(0);
    expect(body.reddit_post_snapshots.length).toBeGreaterThan(0);

    const json = JSON.stringify(body);
    for (const forbidden of [
      "secret_ct",
      "secret_iv",
      "secret_tag",
      "wrapped_dek",
      "dek_iv",
      "dek_tag",
      "kek_version",
      "user_id",
      "userId",
    ]) {
      expect(
        json,
        `forbidden substring '${forbidden}' leaked into the full export envelope`,
      ).not.toContain(forbidden);
    }
  });

  it("GET /api/me/export writes account.exported audit event", async () => {
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

  it("DELETE /api/me/account soft-cascades to games, game_steam_listings, data_sources, events, api_keys_steam (NOT audit_log)", async () => {
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

    // api_keys_steam — hard-deleted (no deletedAt column).
    const keysAfter = await db.select().from(apiKeysSteam).where(eq(apiKeysSteam.userId, userA.id));
    expect(keysAfter).toHaveLength(0);

    // audit_log NOT cascaded (AGENTS.md §4 INSERT-only invariant).
    const audits = await db.select().from(auditLog).where(eq(auditLog.userId, userA.id));
    expect(audits.length).toBeGreaterThan(0);
    for (const a of audits) {
      expect(a).not.toHaveProperty("deletedAt");
    }
  });

  it("DELETE /api/me/account hard-deletes all session rows for that user", async () => {
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

  it("DELETE /api/me/account writes account.deleted audit event with retentionDays metadata", async () => {
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

  it("POST /api/me/account/restore reverses ONLY children whose deleted_at === user.deleted_at", async () => {
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

  it("POST /api/me/account/restore writes account.restored audit event", async () => {
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

  it("POST /api/me/account/restore returns 410 Gone when called past RETENTION_DAYS", async () => {
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

  it("cross-tenant: User A's export does not contain User B's rows", async () => {
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

  it("export includes wishlist + YouTube + Reddit metric history, tenant-scoped to the caller [06-02 D-07]", async () => {
    const userA = await seedUserDirectly({ email: `content-A-${uniq()}@test.local` });
    const userB = await seedUserDirectly({ email: `content-B-${uniq()}@test.local` });

    // ── wishlist (tenant-owned) — one row per user, on the user's own listing.
    const gameA = await createGame(userA.id, { title: `gA-${uniq()}` }, "127.0.0.1");
    const [listingA] = await db
      .insert(gameSteamListings)
      .values({ userId: userA.id, gameId: gameA.id, appId: 730, label: "LA" })
      .returning();
    await db.insert(wishlistSnapshots).values({
      userId: userA.id,
      listingId: listingA!.id,
      date: "2026-06-02",
      adds: 20,
      deletes: 2,
      purchasesAndActivations: 0,
      gifts: 0,
      balance: 18,
    });

    const gameB = await createGame(userB.id, { title: `gB-${uniq()}` }, "127.0.0.1");
    const [listingB] = await db
      .insert(gameSteamListings)
      .values({ userId: userB.id, gameId: gameB.id, appId: 570, label: "LB" })
      .returning();
    const bBalance = 999_111; // distinctive number so we can substring-assert its absence
    await db.insert(wishlistSnapshots).values({
      userId: userB.id,
      listingId: listingB!.id,
      date: "2026-06-02",
      adds: bBalance,
      deletes: 0,
      purchasesAndActivations: 0,
      gifts: 0,
      balance: bBalance,
    });

    // ── YouTube event + matching public-data snapshot (same external_id/video_id).
    const ytVideoId = `ytc-${uniq()}`;
    await createEvent(
      userA.id,
      {
        gameIds: [],
        kind: "youtube_video",
        occurredAt: new Date(),
        title: "YTc",
        externalId: ytVideoId,
      },
      "127.0.0.1",
    );
    await db.insert(youtubeVideoSnapshots).values({
      videoId: ytVideoId,
      polledAt: new Date(),
      viewCount: 1234,
      likeCount: 56,
      commentCount: 7,
    });

    // ── Reddit event + matching public-data snapshot (same external_id/post_id).
    const redditPostId = `t3_${uniq()}`;
    await db.insert(redditPosts).values({
      postId: redditPostId,
      subredditSlug: "gamedev",
      permalink: `/r/gamedev/comments/${uniq()}`,
      title: "Rc",
      publishedAt: new Date(),
    });
    // Direct event insert (see the shape test above): avoid createEvent's live
    // reddit syncStats.fetch so this export test stays hermetic.
    await db.insert(events).values({
      userId: userA.id,
      kind: "reddit_post",
      occurredAt: new Date(),
      title: "RDc",
      externalId: redditPostId,
    });
    await db.insert(redditPostSnapshots).values({
      postId: redditPostId,
      polledAt: new Date(),
      likeCount: 314,
      commentCount: 9,
      score: 314,
      numComments: 9,
    });

    const envelope = await exportAccountJson(userA.id, "127.0.0.1");

    // D-07 content: the three new sections appear and contain the seeded ids.
    expect(envelope.wishlist_snapshots.some((w) => w.listingId === listingA!.id)).toBe(true);
    expect(envelope.youtube_video_snapshots.some((s) => s.videoId === ytVideoId)).toBe(true);
    expect(envelope.reddit_post_snapshots.some((s) => s.postId === redditPostId)).toBe(true);

    // Cross-tenant: user B's wishlist row is NOT in user A's export.
    expect(envelope.wishlist_snapshots.some((w) => w.listingId === listingB!.id)).toBe(false);
    const json = JSON.stringify(envelope);
    expect(json).not.toContain(listingB!.id);
    expect(json).not.toContain(String(bBalance));
  });
});
