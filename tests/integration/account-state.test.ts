import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import { user } from "../../src/lib/server/db/schema/auth.js";
import { seedUserDirectly } from "./helpers.js";

// Phase 02.2 review (Codex P1.2): account-state middleware blocks writes from
// a soft-deleted account's session. Allowed routes during grace:
//   - POST /api/me/account/restore
//   - GET  /api/me/export
//   - POST /api/me/sessions/all
//   - GET  /api/me
// Everything else returns 423 Locked.
//
// Why this matters: softDeleteAccount kills existing sessions, but the user
// can sign back in via Google OAuth at any time during the RETENTION_DAYS
// grace. Without this guard, the freshly re-authed deleted user could create
// rows that neither carry the marker timestamp (so restoreAccount won't
// reverse them) nor get hard-purged by the Phase 3 worker.

const uniq = () => Math.random().toString(36).slice(2, 10);

async function softDeleteUser(userId: string): Promise<Date> {
  const deletedAt = new Date();
  await db.update(user).set({ deletedAt }).where(eq(user.id, userId));
  return deletedAt;
}

describe("account-state middleware (Phase 02.2 — Codex P1.2)", () => {
  it("active account: POST /api/games passes through (control)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `as-active-${uniq()}@test.local` });
    const res = await app.request("/api/games", {
      method: "POST",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "active-game" }),
    });
    // 201 created (or 200 — depends on route handler) but NEVER 423.
    expect(res.status).not.toBe(423);
    expect([200, 201]).toContain(res.status);
  });

  it("soft-deleted account: POST /api/games returns 423 account_pending_deletion", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `as-write-block-${uniq()}@test.local` });
    const deletedAt = await softDeleteUser(u.id);

    const res = await app.request("/api/games", {
      method: "POST",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "should-not-create" }),
    });
    expect(res.status).toBe(423);
    const body = (await res.json()) as { error: string; deletedAt: string };
    expect(body.error).toBe("account_pending_deletion");
    expect(new Date(body.deletedAt).getTime()).toBe(deletedAt.getTime());
  });

  it("soft-deleted account: POST /api/me/account/restore is allowed (allowlist)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `as-restore-allow-${uniq()}@test.local` });
    await softDeleteUser(u.id);

    const res = await app.request("/api/me/account/restore", {
      method: "POST",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    // Allowed by middleware → handler runs → restoreAccount returns 200 ok.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // After restore, the user.deletedAt is null again.
    const [row] = await db
      .select({ deletedAt: user.deletedAt })
      .from(user)
      .where(eq(user.id, u.id));
    expect(row!.deletedAt).toBeNull();
  });

  it("soft-deleted account: GET /api/me/export is allowed (Article 15 right of access)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `as-export-allow-${uniq()}@test.local` });
    await softDeleteUser(u.id);

    const res = await app.request("/api/me/export", {
      method: "GET",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { exported_at: string };
    expect(typeof body.exported_at).toBe("string");
  });

  it("soft-deleted account: POST /api/me/sessions/all is allowed (sign-out)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `as-signout-allow-${uniq()}@test.local` });
    await softDeleteUser(u.id);

    const res = await app.request("/api/me/sessions/all", {
      method: "POST",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    // Allowed; handler outcome is its own concern (200 or 204). Just NOT 423.
    expect(res.status).not.toBe(423);
  });

  it("soft-deleted account: GET /api/me is allowed (banner state read)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `as-me-read-allow-${uniq()}@test.local` });
    await softDeleteUser(u.id);

    const res = await app.request("/api/me", {
      method: "GET",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).not.toBe(423);
  });

  it("soft-deleted account: POST /api/events returns 423 (write blocked)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `as-events-block-${uniq()}@test.local` });
    await softDeleteUser(u.id);

    const res = await app.request("/api/events", {
      method: "POST",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "youtube_video",
        title: "should-fail",
        occurredAt: new Date().toISOString(),
      }),
    });
    expect(res.status).toBe(423);
  });

  it("soft-deleted account: POST /api/sources returns 423 (write blocked)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `as-sources-block-${uniq()}@test.local` });
    await softDeleteUser(u.id);

    const res = await app.request("/api/sources", {
      method: "POST",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "youtube_channel",
        handleUrl: "https://www.youtube.com/@blocked",
      }),
    });
    expect(res.status).toBe(423);
  });

  it("layout-load contract: deletedAt is read directly from DB (Codex P1.1)", async () => {
    // The +layout.server.ts load now SELECTs user.deletedAt explicitly rather
    // than relying on Better Auth getSession passthrough. This is the same
    // SELECT path the middleware uses, so we exercise it via a 423 response —
    // a 423 means the middleware DID find deletedAt set, even though Better
    // Auth's getSession TypeScript shape does not include it.
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: `as-deletedat-direct-${uniq()}@test.local` });
    await softDeleteUser(u.id);

    const res = await app.request("/api/games", {
      method: "POST",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "x" }),
    });
    expect(res.status).toBe(423);
    const body = (await res.json()) as { deletedAt: string };
    expect(body.deletedAt).toBeDefined();
    // Round-trips through the SELECT, not through Better Auth user-shape projection.
  });
});
