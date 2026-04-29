import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import { auditLog } from "../../src/lib/server/db/schema/audit-log.js";
import { writeAudit } from "../../src/lib/server/audit.js";
import { NotFoundError } from "../../src/lib/server/services/errors.js";
import { seedUserDirectly } from "./helpers.js";

/**
 * Plan 01-07 (Wave 4) — VALIDATION 7/8/9 (cross-tenant 404 not 403).
 *
 * Phase 1 has /api/me only — no cross-resource matrix yet (Phase 2 lands
 * /api/games). This test seeds the Pattern-3 invariant on a sentinel: an
 * audit_log row owned by user B is unreadable when scoped by user A's id.
 *
 * Revision 1 W1 fix: VALIDATION 8 (write) and 9 (delete) are explicit
 * `it.skip` with the EXACT annotations `deferred to Phase 2: no writable
 * resource in Phase 1` and `deferred to Phase 2: no deletable resource in
 * Phase 1`. No silent skips; every behavior accounted for.
 */
describe("cross-tenant 404 (PRIV-01, VALIDATION 7/8/9)", () => {
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

  // Plan 02-08 — VALIDATION 8 lit up (Phase 1 deferred from "no writable resource").
  it("user A cannot WRITE user B resource — returns 404 (Phase 2 GAMES-01 turns this on)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const { createGame, getGameById } = await import(
      "../../src/lib/server/services/games.js"
    );
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

    // P1 invariant: body MUST NOT contain "forbidden" or "permission".
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toMatch(/forbidden|permission/i);

    // Verify A's game is unchanged.
    const after = await getGameById(userA.id, created.id);
    expect(after.title).toBe("A's Game");
  });

  // Plan 02-08 — VALIDATION 9 lit up (Phase 1 deferred from "no deletable resource").
  it("user A cannot DELETE user B resource — returns 404", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const { createGame, getGameByIdIncludingDeleted } = await import(
      "../../src/lib/server/services/games.js"
    );
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

  // Plan 02.1-17 — POST /api/events/preview-url is read-only (pure URL parse +
  // oEmbed fetch). No tenant-owned data is read. Cross-tenant invariant: both
  // users get the same enrichment shape from the same URL. This test asserts
  // that contract and surfaces any future drift if a refactor accidentally
  // reads from the caller's tenant scope.
  it("Plan 02.1-17: POST /api/events/preview-url is tenant-scoped but tenant-data-free — same URL → same shape for any user", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const youtubeOembed = await import(
      "../../src/lib/server/integrations/youtube-oembed.js"
    );
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
      // DTO discipline (P3): preview-url response carries no userId.
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
 * Plan 02-08 — D-37 cross-tenant matrix.
 *
 * For every Phase 2 route that takes an id (or gameId) parameter, exercise
 * the cross-tenant case at the HTTP boundary: user B presents their own
 * cookie against an id that belongs to user A and MUST receive 404 — never
 * 403, never 200 with another tenant's data, and the body MUST NOT contain
 * the strings 'forbidden' or 'permission' (P1 invariant; CLAUDE.md Privacy
 * & multi-tenancy rule 2).
 *
 * The probes use `expect.soft` so a single test surfaces every violation in
 * one run rather than failing on the first — the matrix is large enough
 * that the all-or-nothing failure mode would mask regressions.
 */
describe("Phase 2 + 2.1 cross-tenant matrix (D-37)", () => {
  it("user B requests on user A's resources return 404, never 403/200", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const { createGame } = await import("../../src/lib/server/services/games.js");
    const { createSteamKey } = await import(
      "../../src/lib/server/services/api-keys-steam.js"
    );
    const { createSource } = await import(
      "../../src/lib/server/services/data-sources.js"
    );
    const { createEvent, softDeleteEvent } = await import(
      "../../src/lib/server/services/events.js"
    );
    const { addSteamListing } = await import(
      "../../src/lib/server/services/game-steam-listings.js"
    );
    const SteamApi = await import("../../src/lib/server/integrations/steam-api.js");
    const { vi } = await import("vitest");

    // Mock validateSteamKey so createSteamKey doesn't hit the real Steam API.
    const validateSpy = vi.spyOn(SteamApi, "validateSteamKey").mockResolvedValue(true);
    // Mock fetchSteamAppDetails so addSteamListing doesn't hit Steam either.
    const fetchSpy = vi
      .spyOn(SteamApi, "fetchSteamAppDetails")
      .mockResolvedValue(null);

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
          gameId: null,
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
          gameId: game.id,
          kind: "twitter_post",
          occurredAt: new Date(),
          title: "A's tweet",
        },
        "127.0.0.1",
      );
      // Plan 02.1-14: User A's soft-deleted event — used for the cross-tenant
      // restore probe (must 404 by construction; restore is gated by the
      // service-layer userId AND-clause on the UPDATE).
      const deletedEvent = await createEvent(
        userA.id,
        {
          gameId: game.id,
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
        {
          method: "PATCH",
          path: `/api/games/${game.id}/listings/${listing.id}/key`,
          body: { apiKeyId: null },
        },
        // Phase 2.1 — data_sources (replaces Phase 2 youtube-channels probes)
        { method: "GET", path: `/api/sources/${source.id}` },
        {
          method: "PATCH",
          path: `/api/sources/${source.id}`,
          body: { autoImport: false },
        },
        { method: "DELETE", path: `/api/sources/${source.id}` },
        { method: "POST", path: `/api/sources/${source.id}/restore` },
        // api keys (steam)
        { method: "GET", path: `/api/api-keys/steam/${key.id}` },
        {
          method: "PATCH",
          path: `/api/api-keys/steam/${key.id}`,
          body: { plaintext: "STEAM-XYZW-NEWNEW-CCCC" },
        },
        { method: "DELETE", path: `/api/api-keys/steam/${key.id}` },
        // events: per-game + per-id (Phase 2.1 unified-events surface)
        { method: "GET", path: `/api/games/${game.id}/events` },
        { method: "GET", path: `/api/events/${event.id}` },
        {
          method: "PATCH",
          path: `/api/events/${event.id}`,
          body: { title: "B HACKED" },
        },
        { method: "DELETE", path: `/api/events/${event.id}` },
        // Phase 2.1 — events attach + dismiss-inbox cross-tenant probes
        // PATCH /api/events/:id/attach with B's own gameId — B is authed but
        // the event belongs to A so the UPDATE matches no rows and the
        // service returns NotFoundError → 404. Pitfall 4 explicit guard
        // (NOT 500 from a bare PG FK rejection).
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
        // Plan 02.1-14 — PATCH /api/events/:id/restore on A's soft-deleted
        // event must 404 cross-tenant. The restore service's UPDATE WHERE
        // clause is `userId AND id AND deleted_at IS NOT NULL`; user B's
        // session id never satisfies the userId clause.
        {
          method: "PATCH",
          path: `/api/events/${deletedEvent.id}/restore`,
        },
        // Plan 02.1-24 — PATCH /api/events/:id/mark-standalone +
        // /unmark-standalone on A's inbox event must 404 cross-tenant. The
        // service's UPDATE WHERE clause requires the userId match; B's
        // session never satisfies it (tenant-scope/no-unfiltered-tenant-query
        // ESLint rule plus the explicit eq(events.userId, userId) clause).
        {
          method: "PATCH",
          path: `/api/events/${inboxEvent.id}/mark-standalone`,
        },
        {
          method: "PATCH",
          path: `/api/events/${inboxEvent.id}/unmark-standalone`,
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
        expect.soft(
          res.status,
          `${p.method} ${p.path} should be 404 cross-tenant (got ${res.status})`,
        ).toBe(404);
        // Pitfall 4 explicit guard: cross-tenant attach must NEVER surface 500
        // from a bare PG FK rejection — assertGameOwnedByUser fires first.
        expect.soft(
          res.status,
          `${p.method} ${p.path} must NOT be 500 (Pitfall 4: cross-tenant FK)`,
        ).not.toBe(500);
        const txt = await res.text();
        expect.soft(
          txt,
          `${p.method} ${p.path} body must not contain 'forbidden' or 'permission'`,
        ).not.toMatch(/forbidden|permission/i);
      }

      // Plan 02.1-14 — GET /api/events/deleted is a list endpoint, not a
      // single-row endpoint, so the cross-tenant isolation contract is
      // "user B's call returns ZERO of user A's rows" rather than 404. The
      // service-layer eq(events.userId, userId) clause enforces this by
      // construction; the route assertion confirms the wire-format isolation.
      const deletedListRes = await app.request("/api/events/deleted", {
        method: "GET",
        headers: { cookie },
      });
      expect.soft(deletedListRes.status, "GET /api/events/deleted must be 200 for an authenticated user").toBe(200);
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
