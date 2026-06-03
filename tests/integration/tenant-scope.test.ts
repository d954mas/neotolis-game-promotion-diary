import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import { auditLog } from "../../src/lib/server/db/schema/audit-log.js";
import { writeAudit } from "../../src/lib/server/audit.js";
import { NotFoundError } from "../../src/lib/server/services/errors.js";
import { seedUserDirectly } from "./helpers.js";

/**
 * Cross-tenant 404 not 403.
 *
 * Seeds the Pattern-3 invariant on a sentinel: an audit_log row owned by
 * user B is unreadable when scoped by user A's id.
 */
describe("cross-tenant 404", () => {
  it("user A cannot READ user B audit row (404 NOT 403)", async () => {
    const userA = await seedUserDirectly({ email: "a@test.local" });
    const userB = await seedUserDirectly({ email: "b@test.local" });
    await writeAudit({
      userId: userB.id,
      action: "session.signin",
      ipAddress: "127.0.0.1",
    });

    // Sentinel "service": fetch one audit row scoped by userId. The double
    // eq(...userId) clause encodes the Pattern 3 invariant — the scope is
    // ALWAYS the caller's userId, even when looking up "this specific row";
    // the only way both clauses can be true is if rowOwnerId === callerId.
    async function getAuditRowFor(callerId: string, rowOwnerId: string) {
      const rows = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.userId, callerId), eq(auditLog.userId, rowOwnerId)))
        .limit(1);
      if (rows.length === 0) throw new NotFoundError();
      return rows[0]!;
    }

    // user A scoping user B's row: NotFoundError, never a result.
    await expect(getAuditRowFor(userA.id, userB.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("user A cannot WRITE user B resource — returns 404", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const { createGame, getGameById } = await import("../../src/lib/server/services/games.js");
    const app = createApp();
    const userA = await seedUserDirectly({ email: "wA@test.local" });
    const userB = await seedUserDirectly({ email: "wB@test.local" });
    const created = await createGame(userA.id, { title: "A's Game" }, "127.0.0.1");

    // user B PATCHes user A's game id — must be 404, not 403, and not a successful write.
    const res = await app.request(`/api/games/${created.id}`, {
      method: "PATCH",
      headers: {
        cookie: `neotolis.session_token=${userB.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "B HACKED" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "not_found" });

    // Invariant: body MUST NOT contain "forbidden" or "permission".
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toMatch(/forbidden|permission/i);

    // Verify A's game is unchanged.
    const after = await getGameById(userA.id, created.id);
    expect(after.title).toBe("A's Game");
  });

  it("user A cannot DELETE user B resource — returns 404", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const { createGame, getGameByIdIncludingDeleted } =
      await import("../../src/lib/server/services/games.js");
    const app = createApp();
    const userA = await seedUserDirectly({ email: "dA@test.local" });
    const userB = await seedUserDirectly({ email: "dB@test.local" });
    const created = await createGame(userA.id, { title: "A's Game" }, "127.0.0.1");

    const res = await app.request(`/api/games/${created.id}`, {
      method: "DELETE",
      headers: { cookie: `neotolis.session_token=${userB.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(404);
    const bodyStr = await res.text();
    expect(bodyStr).not.toMatch(/forbidden|permission/i);

    // Verify A's game is NOT soft-deleted.
    const after = await getGameByIdIncludingDeleted(userA.id, created.id);
    expect(after.deletedAt).toBeNull();
  });

  it('NotFoundError serializes to {error: "not_found"} status 404 (never "forbidden")', () => {
    const err = new NotFoundError();
    expect(err.status).toBe(404);
    expect(err.code).toBe("not_found");
    // Body must NOT contain "forbidden" or "permission".
    const body = JSON.stringify({ error: err.code });
    expect(body).not.toContain("forbidden");
    expect(body).not.toContain("permission");
  });

  // POST /api/events/preview-url is read-only (pure URL parse + oEmbed
  // fetch). No tenant-owned data is read. Cross-tenant invariant: both
  // users get the same enrichment shape from the same URL. This test
  // asserts that contract and surfaces any future drift if a refactor
  // accidentally reads from the caller's tenant scope.
  it("POST /api/events/preview-url is tenant-scoped but tenant-data-free — same URL → same shape for any user", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const youtubeOembed = await import("../../src/lib/server/integrations/youtube-oembed.js");
    const { vi } = await import("vitest");
    const spy = vi.spyOn(youtubeOembed, "fetchYoutubeOembed").mockResolvedValue({
      kind: "ok",
      data: {
        title: "Cross-tenant preview",
        authorName: "Author",
        authorUrl: "",
        thumbnailUrl: "",
      },
    });
    try {
      const app = createApp();
      const userA = await seedUserDirectly({ email: "p17-tnA@test.local" });
      const userB = await seedUserDirectly({ email: "p17-tnB@test.local" });
      const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

      const resA = await app.request("/api/events/preview-url", {
        method: "POST",
        headers: {
          cookie: `neotolis.session_token=${userA.signedSessionCookieValue}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url }),
      });
      expect(resA.status).toBe(200);
      const bodyA = (await resA.json()) as Record<string, unknown>;

      const resB = await app.request("/api/events/preview-url", {
        method: "POST",
        headers: {
          cookie: `neotolis.session_token=${userB.signedSessionCookieValue}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url }),
      });
      expect(resB.status).toBe(200);
      const bodyB = (await resB.json()) as Record<string, unknown>;

      // Same URL → same enrichment payload. No leakage of one tenant's data
      // into the other's response.
      expect(bodyA.externalId).toBe(bodyB.externalId);
      expect(bodyA.kind).toBe(bodyB.kind);
      expect(bodyA.title).toBe(bodyB.title);
      // DTO discipline: preview-url response carries no userId.
      expect(bodyA).not.toHaveProperty("userId");
      expect(bodyB).not.toHaveProperty("userId");
    } finally {
      spy.mockRestore();
    }
  });

  it("user A reading their own /api/me returns 200; user B reading their own returns 200 with different data", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const userA = await seedUserDirectly({ email: "mine-a@test.local", name: "A" });
    const userB = await seedUserDirectly({ email: "mine-b@test.local", name: "B" });

    const resA = await app.request("/api/me", {
      headers: { cookie: `neotolis.session_token=${userA.signedSessionCookieValue}` },
    });
    expect(resA.status).toBe(200);
    const bodyA = (await resA.json()) as Record<string, unknown>;
    expect(bodyA.email).toBe("mine-a@test.local");

    const resB = await app.request("/api/me", {
      headers: { cookie: `neotolis.session_token=${userB.signedSessionCookieValue}` },
    });
    expect(resB.status).toBe(200);
    const bodyB = (await resB.json()) as Record<string, unknown>;
    expect(bodyB.email).toBe("mine-b@test.local");
    expect(bodyA.id).not.toBe(bodyB.id);
  });
});

/**
 * Cross-tenant matrix.
 *
 * For every route that takes an id (or gameId) parameter, exercise
 * the cross-tenant case at the HTTP boundary: user B presents their own
 * cookie against an id that belongs to user A and MUST receive 404 — never
 * 403, never 200 with another tenant's data, and the body MUST NOT contain
 * the strings 'forbidden' or 'permission' (CLAUDE.md Privacy & multi-tenancy
 * rule 2).
 *
 * The probes use `expect.soft` so a single test surfaces every violation in
 * one run rather than failing on the first — the matrix is large enough
 * that the all-or-nothing failure mode would mask regressions.
 */
describe("cross-tenant matrix", () => {
  it("user B requests on user A's resources return 404, never 403/200", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const { createGame } = await import("../../src/lib/server/services/games.js");
    const { createSteamKey } = await import("../../src/lib/server/services/api-keys-steam.js");
    const { createSource } = await import("../../src/lib/server/services/data-sources.js");
    const { createEvent, softDeleteEvent } =
      await import("../../src/lib/server/services/events.js");
    const { addSteamListing } =
      await import("../../src/lib/server/services/game-steam-listings.js");
    const SteamApi = await import("../../src/lib/server/integrations/steam-api.js");
    const { vi } = await import("vitest");

    // Mock validateSteamKey so createSteamKey doesn't hit the real Steam API.
    const validateSpy = vi.spyOn(SteamApi, "validateSteamKey").mockResolvedValue(true);
    // Mock fetchSteamAppDetails so addSteamListing doesn't hit Steam either.
    const fetchSpy = vi.spyOn(SteamApi, "fetchSteamAppDetails").mockResolvedValue(null);

    try {
      const app = createApp();
      const userA = await seedUserDirectly({ email: "mA@test.local" });
      const userB = await seedUserDirectly({ email: "mB@test.local" });

      // Seed: A owns one of every kind of resource the routes operate on.
      const game = await createGame(userA.id, { title: "A's Game" }, "127.0.0.1");
      const key = await createSteamKey(
        userA.id,
        { label: "A's Key", plaintext: "STEAM-XYZW-AAAA-BBBB" },
        "127.0.0.1",
      );
      const source = await createSource(
        userA.id,
        {
          kind: "youtube_channel",
          handleUrl: "https://www.youtube.com/@AOwn",
          isOwnedByMe: true,
        },
        "127.0.0.1",
      );
      // User A's inbox event (game_id IS NULL) — used for dismiss-inbox probe.
      const inboxEvent = await createEvent(
        userA.id,
        {
          gameIds: [],
          kind: "twitter_post",
          occurredAt: new Date(),
          title: "A's inbox tweet",
        },
        "127.0.0.1",
      );
      // User A's attached event — used for the attach + edit + delete probes.
      const event = await createEvent(
        userA.id,
        {
          gameIds: [game.id],
          kind: "twitter_post",
          occurredAt: new Date(),
          title: "A's tweet",
        },
        "127.0.0.1",
      );
      // User A's soft-deleted event — used for the cross-tenant restore
      // probe (must 404 by construction; restore is gated by the
      // service-layer userId AND-clause on the UPDATE).
      const deletedEvent = await createEvent(
        userA.id,
        {
          gameIds: [game.id],
          kind: "press",
          occurredAt: new Date(),
          title: "A's deleted press hit",
        },
        "127.0.0.1",
      );
      await softDeleteEvent(userA.id, deletedEvent.id, "127.0.0.1");
      const listing = await addSteamListing(
        userA.id,
        { gameId: game.id, appId: 730, label: "A's listing" },
        "127.0.0.1",
      );
      // User B's own game — used as the cross-tenant attach target so we
      // can exercise the "B has a game, but A's event still 404s" path.
      const gameB = await createGame(userB.id, { title: "B's Game" }, "127.0.0.1");

      const cookie = `neotolis.session_token=${userB.signedSessionCookieValue}`;
      type Probe = { method: string; path: string; body?: Record<string, unknown> };
      const probes: Probe[] = [
        // games
        { method: "GET", path: `/api/games/${game.id}` },
        { method: "PATCH", path: `/api/games/${game.id}`, body: { title: "X" } },
        { method: "DELETE", path: `/api/games/${game.id}` },
        { method: "POST", path: `/api/games/${game.id}/restore` },
        // game-listings
        { method: "GET", path: `/api/games/${game.id}/listings` },
        {
          method: "POST",
          path: `/api/games/${game.id}/listings`,
          body: { appId: 730 },
        },
        {
          method: "DELETE",
          path: `/api/games/${game.id}/listings/${listing.id}`,
        },
        // delete-forever (hard purge) — same DELETE route with ?force=true
        // (Plan 03.2-04). Cross-tenant → 404 before hardDeleteListing runs.
        {
          method: "DELETE",
          path: `/api/games/${game.id}/listings/${listing.id}?force=true`,
        },
        {
          method: "PATCH",
          path: `/api/games/${game.id}/listings/${listing.id}/key`,
          body: { apiKeyId: null },
        },
        // data_sources
        { method: "GET", path: `/api/sources/${source.id}` },
        {
          method: "PATCH",
          path: `/api/sources/${source.id}`,
          body: { autoImport: false },
        },
        { method: "DELETE", path: `/api/sources/${source.id}` },
        { method: "POST", path: `/api/sources/${source.id}/restore` },
        // refresh-content endpoint cross-tenant probe.
        // Dispatches via getAdapter(source.kind).backfillSource; the
        // getSourceById fast-path throws NotFoundError BEFORE any enqueue,
        // so this assertion does not need a pg-boss mock — the 404 short-
        // circuits before getBoss() is ever called.
        { method: "POST", path: `/api/sources/${source.id}/refresh-content` },
        // api keys (steam)
        { method: "GET", path: `/api/api-keys/steam/${key.id}` },
        {
          method: "PATCH",
          path: `/api/api-keys/steam/${key.id}`,
          body: { plaintext: "STEAM-XYZW-NEWNEW-CCCC" },
        },
        { method: "DELETE", path: `/api/api-keys/steam/${key.id}` },
        // events: per-game + per-id (unified-events surface)
        { method: "GET", path: `/api/games/${game.id}/events` },
        { method: "GET", path: `/api/events/${event.id}` },
        {
          method: "PATCH",
          path: `/api/events/${event.id}`,
          body: { title: "B HACKED" },
        },
        { method: "DELETE", path: `/api/events/${event.id}` },
        // events attach + dismiss-inbox cross-tenant probes
        // PATCH /api/events/:id/attach with B's own gameId — B is authed but
        // the event belongs to A so the UPDATE matches no rows and the
        // service returns NotFoundError → 404. Explicit guard:
        // NOT 500 from a bare PG FK rejection.
        {
          method: "PATCH",
          path: `/api/events/${event.id}/attach`,
          body: { gameId: gameB.id },
        },
        // PATCH /api/events/:id/attach with A's own gameId — same outcome:
        // event ownership wins, 404. The body's gameId never even gets
        // validated (B doesn't own A's game either).
        {
          method: "PATCH",
          path: `/api/events/${event.id}/attach`,
          body: { gameId: game.id },
        },
        // PATCH /api/events/:id/dismiss-inbox on A's inbox event — 404.
        {
          method: "PATCH",
          path: `/api/events/${inboxEvent.id}/dismiss-inbox`,
        },
        // PATCH /api/events/:id/restore on A's soft-deleted event must 404
        // cross-tenant. The restore service's UPDATE WHERE clause is
        // `userId AND id AND deleted_at IS NOT NULL`; user B's session id
        // never satisfies the userId clause.
        {
          method: "PATCH",
          path: `/api/events/${deletedEvent.id}/restore`,
        },
      ];

      for (const p of probes) {
        const init: RequestInit = {
          method: p.method,
          headers: {
            cookie,
            "content-type": "application/json",
          },
        };
        if (p.body) (init as { body?: string }).body = JSON.stringify(p.body);
        const res = await app.request(p.path, init);
        expect
          .soft(res.status, `${p.method} ${p.path} should be 404 cross-tenant (got ${res.status})`)
          .toBe(404);
        // Explicit guard: cross-tenant attach must NEVER surface 500 from a
        // bare PG FK rejection — assertGameOwnedByUser fires first.
        expect
          .soft(res.status, `${p.method} ${p.path} must NOT be 500 (cross-tenant FK)`)
          .not.toBe(500);
        const txt = await res.text();
        expect
          .soft(txt, `${p.method} ${p.path} body must not contain 'forbidden' or 'permission'`)
          .not.toMatch(/forbidden|permission/i);
      }

      // GET /api/events/deleted is a list endpoint, not a single-row
      // endpoint, so the cross-tenant isolation contract is
      // "user B's call returns ZERO of user A's rows" rather than 404. The
      // service-layer eq(events.userId, userId) clause enforces this by
      // construction; the route assertion confirms the wire-format isolation.
      const deletedListRes = await app.request("/api/events/deleted", {
        method: "GET",
        headers: { cookie },
      });
      expect
        .soft(
          deletedListRes.status,
          "GET /api/events/deleted must be 200 for an authenticated user",
        )
        .toBe(200);
      const deletedBody = (await deletedListRes.json()) as {
        rows: Array<{ id: string }>;
      };
      // userB has no deleted events → empty list; A's deletedEvent.id MUST NOT appear.
      expect.soft(deletedBody.rows.map((r) => r.id)).not.toContain(deletedEvent.id);
    } finally {
      validateSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });
});

/**
 * Cross-tenant probes against the `event_games` junction.
 *
 * Two probe shapes:
 *   - userB attempting to attach userA's eventId to userB's own gameId →
 *     404 (NotFoundError on the eventId lookup; userB's session never
 *     satisfies the userId clause on the events SELECT).
 *   - userB attempting to attach userB's own eventId to userA's gameId →
 *     404 (NotFoundError from assertGameOwnedByUser; userB's session
 *     never satisfies the userId clause on the games SELECT).
 *
 * Body MUST NOT contain 'forbidden' / 'permission' (CLAUDE.md Privacy
 * & multi-tenancy rule 2).
 *
 * The eventGames table is tenant-scoped at every read site via the
 * denormalized userId column; the ESLint tenant-scope rule fires on any
 * future Drizzle query that omits eq(eventGames.userId, userId).
 */
describe("event_games cross-tenant", () => {
  // Parallel-executor email-uniqueness coordination:
  const uniq = () => Math.random().toString(36).slice(2, 10);

  it("userB attaches userA's event to userB's game → 404 (eventId ownership wins)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const { createGame } = await import("../../src/lib/server/services/games.js");
    const { createEvent } = await import("../../src/lib/server/services/events.js");
    const app = createApp();
    const userA = await seedUserDirectly({ email: `p28-xtA-${uniq()}@test.local` });
    const userB = await seedUserDirectly({ email: `p28-xtB-${uniq()}@test.local` });

    // userA owns an event; userB owns a game.
    const evA = await createEvent(
      userA.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date(),
        title: "User A's event",
      },
      "127.0.0.1",
    );
    const gB = await createGame(userB.id, { title: "B's game" }, "127.0.0.1");

    const res = await app.request(`/api/events/${evA.id}/attach`, {
      method: "PATCH",
      headers: {
        cookie: `neotolis.session_token=${userB.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ gameIds: [gB.id] }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "not_found" });
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toMatch(/forbidden|permission/i);
  });

  it("userB attaches userB's own event to userA's game → 404 (gameId ownership wins via assertGameOwnedByUser)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const { createGame } = await import("../../src/lib/server/services/games.js");
    const { createEvent } = await import("../../src/lib/server/services/events.js");
    const app = createApp();
    const userA = await seedUserDirectly({ email: `p28-xt2A-${uniq()}@test.local` });
    const userB = await seedUserDirectly({ email: `p28-xt2B-${uniq()}@test.local` });

    // userA owns a game; userB owns an event.
    const gA = await createGame(userA.id, { title: "A's game" }, "127.0.0.1");
    const evB = await createEvent(
      userB.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date(),
        title: "User B's event",
      },
      "127.0.0.1",
    );

    // userB attempts to attach their own event to userA's game.
    const res = await app.request(`/api/events/${evB.id}/attach`, {
      method: "PATCH",
      headers: {
        cookie: `neotolis.session_token=${userB.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ gameIds: [gA.id] }),
    });
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "not_found" });
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toMatch(/forbidden|permission/i);
  });

  it("GET /api/events list response from userB cursor never contains userA's gameIds in any row", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const { createGame } = await import("../../src/lib/server/services/games.js");
    const { createEvent, attachEventToGames } =
      await import("../../src/lib/server/services/events.js");
    const app = createApp();
    const userA = await seedUserDirectly({ email: `p28-xt3A-${uniq()}@test.local` });
    const userB = await seedUserDirectly({ email: `p28-xt3B-${uniq()}@test.local` });

    // userA: one game + one event attached to it.
    const gA = await createGame(userA.id, { title: "A's game" }, "127.0.0.1");
    const evA = await createEvent(
      userA.id,
      {
        gameIds: [gA.id],
        kind: "press",
        occurredAt: new Date(),
        title: "A's attached event",
      },
      "127.0.0.1",
    );
    void evA;

    // userB: one own event in inbox.
    const evB = await createEvent(
      userB.id,
      {
        gameIds: [],
        kind: "press",
        occurredAt: new Date(),
        title: "B's inbox event",
      },
      "127.0.0.1",
    );
    // (Avoid unused-var warning.)
    void attachEventToGames;

    // userB hits GET /api/events. The response rows MUST NOT contain
    // userA's gameId in any row's gameIds[] array (the mapEventsToDtos
    // junction lookup is filtered by userB.id).
    const res = await app.request("/api/events?show=any", {
      headers: { cookie: `neotolis.session_token=${userB.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ id: string; gameIds: string[] }>;
    };
    // userB's own inbox event should appear (with empty gameIds).
    const ids = body.rows.map((r) => r.id);
    expect(ids).toContain(evB.id);
    // No row carries userA's gameId.
    const allGameIds = body.rows.flatMap((r) => r.gameIds);
    expect(allGameIds).not.toContain(gA.id);
  });
});

// Cross-tenant invariants for the /api/me/* account surface. The routes
// have no :userId path parameter — they operate on c.var.userId only, so
// cross-tenant access is impossible by construction. The two assertions
// below exercise both layers: the behavioural HTTP-boundary check (User
// A's export does not contain User B rows) and the structural
// by-construction check (no :userId in any registered route path).
describe("cross-tenant invariants for /api/me/account routes", () => {
  const uniqAcc = () => Math.random().toString(36).slice(2, 10);

  it("GET /api/me/export for User A does NOT contain any User B rows", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const { createGame } = await import("../../src/lib/server/services/games.js");
    const app = createApp();
    const userA = await seedUserDirectly({ email: `p223-xt-A-${uniqAcc()}@test.local` });
    const userB = await seedUserDirectly({ email: `p223-xt-B-${uniqAcc()}@test.local` });

    const aTitle = `A-pri-${uniqAcc()}`;
    const bTitle = `B-pri-${uniqAcc()}`;
    await createGame(userA.id, { title: aTitle }, "127.0.0.1");
    await createGame(userB.id, { title: bTitle }, "127.0.0.1");

    const res = await app.request("/api/me/export", {
      headers: { cookie: `neotolis.session_token=${userA.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { games: Array<{ title: string }> };
    expect(body.games.map((g) => g.title)).toEqual([aTitle]);
    const json = JSON.stringify(body);
    expect(json).not.toContain(bTitle);
    expect(json).not.toContain(userB.id);
  });

  it("account routes have no :userId path parameter — cross-tenant impossible by construction", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const routes = (app as unknown as { routes: Array<{ path: string }> }).routes;
    // The 3 routes registered under /api/me/*. By construction
    // none of them carry a :userId path parameter; cross-tenant access is
    // impossible because the handler only reads c.var.userId.
    const accountPaths = routes
      .map((r) => r.path)
      .filter(
        (p) => p === "/api/me/export" || p === "/api/me/account" || p === "/api/me/account/restore",
      );
    expect(accountPaths.length).toBeGreaterThanOrEqual(3);
    for (const p of accountPaths) {
      expect(p).not.toMatch(/:userId/);
    }
  });
});

// Cross-tenant probes for refresh-poll + account/purge routes.
// CLAUDE.md §Privacy invariant 2: cross-tenant returns 404, never 403.
// /api/me/account/purge has no :userId path parameter (account routes
// operate on c.var.userId only); the cross-tenant probe is therefore a
// structural pin ("the shape of the route can't accidentally grow a
// :userId param") rather than a behavioural assertion.
//
// pg-boss is mocked so the cross-tenant test doesn't need a live boss —
// the assertion is on the 404 short-circuit BEFORE any enqueue.
describe("refresh-poll + account/purge cross-tenant", () => {
  it("cross-tenant POST /api/events/:id/refresh-poll → 404", async () => {
    const { vi } = await import("vitest");
    vi.doMock("../../src/lib/server/queue-client.js", async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return {
        ...actual,
        getBoss: async () => ({ send: async () => "mock-job-id" }),
      };
    });
    try {
      const { createApp } = await import("../../src/lib/server/http/app.js");
      const { db } = await import("../../src/lib/server/db/client.js");
      const { events } = await import("../../src/lib/server/db/schema/events.js");
      const { uuidv7 } = await import("../../src/lib/server/ids.js");
      const app = createApp();
      const userA = await seedUserDirectly({ email: "rp-xt-A@test.local" });
      const userB = await seedUserDirectly({ email: "rp-xt-B@test.local" });

      // Seed an event owned by user A.
      const id = uuidv7();
      await db.insert(events).values({
        id,
        userId: userA.id,
        kind: "youtube_video",
        authorIsMe: false,
        occurredAt: new Date(),
        title: "A's video",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        externalId: "dQw4w9WgXcQ",
        metadata: {},
      });

      // User B hits A's event /refresh-poll → 404 (NotFoundError, not 403).
      const res = await app.request(`/api/events/${id}/refresh-poll`, {
        method: "POST",
        headers: { cookie: `neotolis.session_token=${userB.signedSessionCookieValue}` },
      });
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).not.toMatch(/forbidden|permission/i);
      expect(JSON.parse(text)).toEqual({ error: "not_found" });
    } finally {
      const { vi: viCleanup } = await import("vitest");
      viCleanup.doUnmock("../../src/lib/server/queue-client.js");
    }
  });

  it("account/purge route has no :userId path parameter — cross-tenant impossible by construction", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const routes = (app as unknown as { routes: Array<{ path: string }> }).routes;
    // The /api/me/account/purge route registers under /api/me/account/* and
    // operates on c.var.userId only. By construction it carries no :userId
    // path parameter; cross-tenant access is impossible because the handler
    // never reads a tenant-id from the URL.
    const purgePath = routes.map((r) => r.path).find((p) => p === "/api/me/account/purge");
    expect(purgePath).toBeDefined();
    expect(purgePath!).not.toMatch(/:userId/);
  });
});

// Refresh-content cross-tenant. Beyond the matrix row above (which uses
// expect.soft over many probes), this dedicated describe pins the wire
// format so any future refactor that drifts into 403 / "forbidden" body
// trips a single, named test rather than a soft assertion buried in the
// matrix.
describe("POST /api/sources/:id/refresh-content cross-tenant", () => {
  it("cross-tenant POST /api/sources/:id/refresh-content returns 404, body never contains 'forbidden' or 'permission'", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const { createSource } = await import("../../src/lib/server/services/data-sources.js");
    const app = createApp();
    const userA = await seedUserDirectly({
      email: `p10-rc-A-${Math.random().toString(36).slice(2, 10)}@test.local`,
    });
    const userB = await seedUserDirectly({
      email: `p10-rc-B-${Math.random().toString(36).slice(2, 10)}@test.local`,
    });

    // userA owns a youtube_channel source. Use a /channel/UC… handle URL so
    // createSource skips the videos.list lookup (no quota / no network needed
    // in the test) — the canonicalizer parses /channel/UC… synchronously.
    const sourceA = await createSource(
      userA.id,
      {
        kind: "youtube_channel",
        handleUrl: "https://www.youtube.com/channel/UCxAlmEhsZRrIvI1F6m7UqGw",
        isOwnedByMe: true,
        autoImport: false,
      },
      "127.0.0.1",
    );

    // user B hits user A's source /refresh-content → 404, NOT 403, body never
    // contains 'forbidden' / 'permission' (AGENTS.md invariant 2).
    const res = await app.request(`/api/sources/${sourceA.id}/refresh-content`, {
      method: "POST",
      headers: { cookie: `neotolis.session_token=${userB.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text.toLowerCase()).not.toContain("forbidden");
    expect(text.toLowerCase()).not.toContain("permission");
    expect(JSON.parse(text)).toEqual({ error: "not_found" });
  });
});

// admin/quota cross-allowlist assertion.
// The "non-allowlisted user → 404" contract is structurally distinct from
// the row-ownership 404 above (the gate is the env allowlist, not tenant
// ownership), but the wire format is identical: existence doesn't leak.
//
// Body MUST NOT contain "forbidden" / "permission". The
// adminAllowlist middleware matches the wire format mapErr emits for
// NotFoundError, so callers cannot distinguish "you're not in the allowlist"
// from "this URL has no resource for you" — that's the contract.
describe("admin/quota cross-allowlist", () => {
  it("GET /api/admin/quota for non-allowlisted user → 404 (matches anonymous; allowlist is the gate)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    // The integration test process boots with ADMIN_EMAIL_ALLOWLIST empty by
    // default (env.ts default is empty Set), so any authenticated user is
    // non-allowlisted by construction. Seed a normal user and probe.
    const u = await seedUserDirectly({
      email: `p07-nonallow-${Math.random().toString(36).slice(2, 10)}@test.local`,
    });
    const res = await app.request("/api/admin/quota", {
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "not_found" });
    // Response body MUST NOT leak "forbidden" / "permission".
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toMatch(/forbidden|permission/i);
  });
});

// Phase 3.4 design-v2-ux — bulk events cross-tenant.
//
// D-13 contract: bulk PATCH/DELETE silently DROP ids the caller doesn't
// own — they NEVER 404 the whole request, they NEVER 403 the whole
// request, they return 200 with affected_count = (subset that committed).
// This is intentionally different from per-id endpoints (which DO 404
// cross-tenant) — bulk is an upsert-style atomic batch, not an
// existence-check op (Pitfall 9 — cross-tenant ids must not leak via
// per-id 422 errors).
//
// Body MUST NOT contain "forbidden" or "permission". The mapErr envelope
// would never produce those strings because there's no error here at all
// — the response is 200 with a numeric counter. These assertions are
// belt-and-suspenders against a future refactor that breaks the contract
// (e.g. throwing NotFoundError on the first cross-tenant id, which would
// turn the 200 into a 404).
describe("bulk events cross-tenant (D-13)", () => {
  it("PATCH /api/events/bulk silently filters cross-tenant ids (D-13) — 200 + affected_count for owned subset", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const { createEvent } = await import("../../src/lib/server/services/events.js");
    const app = createApp();
    const userA = await seedUserDirectly({
      email: `bulk-xt-A-${Math.random().toString(36).slice(2, 10)}@test.local`,
    });
    const userB = await seedUserDirectly({
      email: `bulk-xt-B-${Math.random().toString(36).slice(2, 10)}@test.local`,
    });
    const evA = await createEvent(
      userA.id,
      { gameIds: [], kind: "twitter_post", occurredAt: new Date(), title: "A" },
      "127.0.0.1",
    );
    const evB = await createEvent(
      userB.id,
      { gameIds: [], kind: "twitter_post", occurredAt: new Date(), title: "B" },
      "127.0.0.1",
    );

    const res = await app.request("/api/events/bulk", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: `neotolis.session_token=${userA.signedSessionCookieValue}`,
      },
      body: JSON.stringify({
        ids: [evA.id, evB.id],
        gameStates: {},
        offTopicState: "on",
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.toLowerCase()).not.toContain("forbidden");
    expect(text.toLowerCase()).not.toContain("permission");
    const body = JSON.parse(text) as { affected_count: number };
    expect(body.affected_count).toBe(1);
  });

  it("DELETE /api/events/bulk silently filters cross-tenant ids (D-13) — 200 + affected_count for owned subset", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const { createEvent } = await import("../../src/lib/server/services/events.js");
    const app = createApp();
    const userA = await seedUserDirectly({
      email: `bulk-del-xt-A-${Math.random().toString(36).slice(2, 10)}@test.local`,
    });
    const userB = await seedUserDirectly({
      email: `bulk-del-xt-B-${Math.random().toString(36).slice(2, 10)}@test.local`,
    });
    const evA = await createEvent(
      userA.id,
      { gameIds: [], kind: "twitter_post", occurredAt: new Date(), title: "A" },
      "127.0.0.1",
    );
    const evB = await createEvent(
      userB.id,
      { gameIds: [], kind: "twitter_post", occurredAt: new Date(), title: "B" },
      "127.0.0.1",
    );

    const res = await app.request("/api/events/bulk", {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        cookie: `neotolis.session_token=${userA.signedSessionCookieValue}`,
      },
      body: JSON.stringify({ ids: [evA.id, evB.id] }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.toLowerCase()).not.toContain("forbidden");
    expect(text.toLowerCase()).not.toContain("permission");
    const body = JSON.parse(text) as { affected_count: number };
    expect(body.affected_count).toBe(1);
  });

  it("DELETE /api/events/bulk?force=true silently filters cross-tenant + still-live ids (D-13 + D-21)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const { createEvent } = await import("../../src/lib/server/services/events.js");
    const { db } = await import("../../src/lib/server/db/client.js");
    const { events } = await import("../../src/lib/server/db/schema/events.js");
    const { and, eq } = await import("drizzle-orm");
    const app = createApp();
    const userA = await seedUserDirectly({
      email: `bulk-force-xt-A-${Math.random().toString(36).slice(2, 10)}@test.local`,
    });
    const userB = await seedUserDirectly({
      email: `bulk-force-xt-B-${Math.random().toString(36).slice(2, 10)}@test.local`,
    });
    const evALive = await createEvent(
      userA.id,
      { gameIds: [], kind: "twitter_post", occurredAt: new Date(), title: "A-live" },
      "127.0.0.1",
    );
    const evATrash = await createEvent(
      userA.id,
      { gameIds: [], kind: "twitter_post", occurredAt: new Date(), title: "A-trash" },
      "127.0.0.1",
    );
    const evBTrash = await createEvent(
      userB.id,
      { gameIds: [], kind: "twitter_post", occurredAt: new Date(), title: "B-trash" },
      "127.0.0.1",
    );
    // Pre-soft-delete the two "trash" events.
    await db
      .update(events)
      .set({ deletedAt: new Date() })
      .where(and(eq(events.userId, userA.id), eq(events.id, evATrash.id)));
    await db
      .update(events)
      .set({ deletedAt: new Date() })
      .where(and(eq(events.userId, userB.id), eq(events.id, evBTrash.id)));

    const res = await app.request("/api/events/bulk?force=true", {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        cookie: `neotolis.session_token=${userA.signedSessionCookieValue}`,
      },
      body: JSON.stringify({ ids: [evALive.id, evATrash.id, evBTrash.id] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { affected_count: number };
    // Only evATrash hard-deleted. evALive (live) silently filtered; evBTrash (cross-tenant) silently filtered.
    expect(body.affected_count).toBe(1);
  });

  // Plan 04-23: getWishlistSeries / computeWishlistDelta are OWNERSHIP-GATED.
  // The `listingId` is the addressable tenant-owned resource, so a foreign or
  // non-existent listingId must 404 (NotFoundError) per the P0 cross-tenant
  // rule — NOT silently return an empty series (which would diverge the exported
  // service contract from the tenant rule). An OWNED listing with no snapshots
  // is NOT a 404: it returns an empty series, proving the 404 is ownership-based,
  // never empty-data-based.
  it("getWishlistSeries / computeWishlistDelta cross-tenant listingId → NotFoundError; own-but-empty → empty (Plan 04-23)", async () => {
    const { vi } = await import("vitest");
    const { createGame } = await import("../../src/lib/server/services/games.js");
    const { addSteamListing } =
      await import("../../src/lib/server/services/game-steam-listings.js");
    const SteamApi = await import("../../src/lib/server/integrations/steam-api.js");
    const { getWishlistSeries, computeWishlistDelta } =
      await import("../../src/lib/server/services/wishlist-snapshots.js");
    const { NotFoundError } = await import("../../src/lib/server/services/errors.js");
    const { wishlistSnapshots } =
      await import("../../src/lib/server/db/schema/wishlist-snapshots.js");

    // Mock fetchSteamAppDetails so addSteamListing doesn't hit Steam.
    vi.spyOn(SteamApi, "fetchSteamAppDetails").mockResolvedValue(null);

    const userA = await seedUserDirectly({ email: "wlA@test.local" });
    const userB = await seedUserDirectly({ email: "wlB@test.local" });

    // User B owns a listing with real wishlist history.
    const gameB = await createGame(userB.id, { title: "B's Game" }, "127.0.0.1");
    const listingB = await addSteamListing(userB.id, { gameId: gameB.id, appId: 900 }, "127.0.0.1");
    await db.insert(wishlistSnapshots).values([
      {
        userId: userB.id,
        listingId: listingB.id,
        date: "2026-05-01",
        adds: 0,
        deletes: 0,
        purchasesAndActivations: 0,
        gifts: 0,
        balance: 500,
        source: "csv",
      },
      {
        userId: userB.id,
        listingId: listingB.id,
        date: "2026-05-08",
        adds: 0,
        deletes: 0,
        purchasesAndActivations: 0,
        gifts: 0,
        balance: 650,
        source: "csv",
      },
    ]);

    // User A asks for B's listingId — not A's resource → 404 (NotFoundError),
    // NOT an empty series. The ownership gate fires before any snapshot read.
    await expect(getWishlistSeries(userA.id, listingB.id)).rejects.toThrow(NotFoundError);
    await expect(computeWishlistDelta(userA.id, listingB.id, "2026-05-01")).rejects.toThrow(
      NotFoundError,
    );

    // A non-existent listingId is likewise a 404 (missing tenant-owned resource).
    await expect(
      getWishlistSeries(userA.id, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow(NotFoundError);

    // Sanity: B (the owner) DOES see the data — proves the 404 above is
    // ownership, not an empty table.
    const seriesForB = await getWishlistSeries(userB.id, listingB.id);
    expect(seriesForB.points).toHaveLength(2);

    // Positive control: an OWNED listing with NO snapshots is NOT a 404 — it
    // resolves to an empty series (points: [], lastImportedAt: null). This
    // distinguishes "your listing, no CSV imported" from "not your listing".
    const emptyListing = await addSteamListing(
      userB.id,
      { gameId: gameB.id, appId: 901 },
      "127.0.0.1",
    );
    const seriesEmpty = await getWishlistSeries(userB.id, emptyListing.id);
    expect(seriesEmpty).toEqual({ points: [], lastImportedAt: null });
    const deltaEmpty = await computeWishlistDelta(userB.id, emptyListing.id, "2026-05-01");
    expect(deltaEmpty.delta24h).toBeNull();
    expect(deltaEmpty.delta7d).toBeNull();
  });
});
