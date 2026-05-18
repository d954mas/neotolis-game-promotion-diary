import { describe, it, expect, vi, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createSource,
  listSources,
  getSourceById,
  updateSource,
  softDeleteSource,
  restoreSource,
  assertNoChannelConflict,
} from "../../src/lib/server/services/data-sources.js";
import { toDataSourceDto } from "../../src/lib/server/dto.js";
import { db } from "../../src/lib/server/db/client.js";
import { dataSources } from "../../src/lib/server/db/schema/data-sources.js";
import { auditLog } from "../../src/lib/server/db/schema/audit-log.js";
import * as Audit from "../../src/lib/server/audit.js";
import { NotFoundError, AppError } from "../../src/lib/server/services/errors.js";
import { seedUserDirectly } from "./helpers.js";

// Service-layer integration for the data_sources registry. HTTP-route concerns
// (status codes, route shape) live in the HTTP-boundary suite below; this
// suite asserts service-layer behaviour exclusively.

describe("register data sources via POST /api/sources", () => {
  it("creating kind=youtube_channel returns row with userId-stripped DTO + active row in DB", async () => {
    const userA = await seedUserDirectly({ email: "ds1@test.local" });
    const row = await createSource(
      userA.id,
      {
        kind: "youtube_channel",
        handleUrl: "https://www.youtube.com/@happy",
        displayName: "Happy",
        isOwnedByMe: true,
        autoImport: true,
        metadata: { uploads_playlist_id: "PLABC" },
      },
      "127.0.0.1",
      "vitest",
    );

    expect(row.kind).toBe("youtube_channel");
    expect(row.deletedAt).toBeNull();
    expect(row.metadata).toEqual({ uploads_playlist_id: "PLABC" });

    const dto = toDataSourceDto(row);
    expect(dto).not.toHaveProperty("userId");
    expect(dto.id).toBe(row.id);
    expect(dto.handleUrl).toBe("https://www.youtube.com/@happy");

    const persisted = await db
      .select()
      .from(dataSources)
      .where(eq(dataSources.id, row.id))
      .limit(1);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.userId).toBe(userA.id);
    expect(persisted[0]!.deletedAt).toBeNull();
  });

  it("kind=reddit_account creates a source (Phase 03.1 — adapter functional)", async () => {
    const userA = await seedUserDirectly({ email: "ds2@test.local" });
    const created = await createSource(
      userA.id,
      { kind: "reddit_account", handleUrl: "https://reddit.com/user/d954mas" },
      "127.0.0.1",
    );
    expect(created.kind).toBe("reddit_account");
    expect(created.userId).toBe(userA.id);

    const rows = await db.select().from(dataSources).where(eq(dataSources.userId, userA.id));
    expect(rows).toHaveLength(1);
  });

  it("duplicate kind=reddit_account uses Reddit-specific duplicate_source message", async () => {
    const userA = await seedUserDirectly({ email: "ds2dup@test.local" });
    await createSource(
      userA.id,
      { kind: "reddit_account", handleUrl: "https://reddit.com/user/d954mas" },
      "127.0.0.1",
    );

    await expect(
      createSource(
        userA.id,
        { kind: "reddit_account", handleUrl: "https://reddit.com/user/d954mas" },
        "127.0.0.1",
      ),
    ).rejects.toMatchObject({
      code: "duplicate_source",
      status: 422,
      message: "You already track this Reddit user",
      metadata: {
        kind: "reddit_account",
        handle_url: "https://www.reddit.com/user/d954mas",
      },
    });
  });

  it("kinds twitter_account / telegram_channel / discord_server reject with 'kind_not_yet_functional'", async () => {
    const userA = await seedUserDirectly({ email: "ds3@test.local" });
    const rejectedKinds = ["twitter_account", "telegram_channel", "discord_server"] as const;
    for (const kind of rejectedKinds) {
      await expect(
        createSource(userA.id, { kind, handleUrl: `https://example.test/${kind}` }, "127.0.0.1"),
      ).rejects.toMatchObject({
        code: "kind_not_yet_functional",
        status: 422,
      });
    }
    const rows = await db.select().from(dataSources).where(eq(dataSources.userId, userA.id));
    expect(rows).toHaveLength(0);
  });

  it("empty handle_url rejects with AppError 'validation_failed' (422)", async () => {
    const userA = await seedUserDirectly({ email: "ds4@test.local" });
    await expect(
      createSource(userA.id, { kind: "youtube_channel", handleUrl: "" }, "127.0.0.1"),
    ).rejects.toMatchObject({ code: "validation_failed", status: 422 });
  });

  it("duplicate (user_id, handle_url) translates PG 23505 into 'duplicate_source' (422)", async () => {
    const userA = await seedUserDirectly({ email: "ds5@test.local" });
    await createSource(
      userA.id,
      { kind: "youtube_channel", handleUrl: "https://youtube.com/@dup" },
      "127.0.0.1",
    );
    await expect(
      createSource(
        userA.id,
        { kind: "youtube_channel", handleUrl: "https://youtube.com/@dup" },
        "127.0.0.1",
      ),
    ).rejects.toMatchObject({
      code: "duplicate_source",
      status: 422,
      metadata: { handle_url: "https://youtube.com/@dup" },
    });
  });

  it("createSource writes audit_action='source.added' with ipAddress + userAgent", async () => {
    const userA = await seedUserDirectly({ email: "ds6@test.local" });
    const row = await createSource(
      userA.id,
      { kind: "youtube_channel", handleUrl: "https://youtube.com/@audited" },
      "192.0.2.7",
      "test-agent/1.0",
    );

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, userA.id), eq(auditLog.action, "source.added")));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.ipAddress).toBe("192.0.2.7");
    expect(audits[0]!.userAgent).toBe("test-agent/1.0");
    expect(audits[0]!.metadata).toMatchObject({
      source_id: row.id,
      kind: "youtube_channel",
      handle_url: "https://youtube.com/@audited",
    });
  });

  it("listSources returns active rows only (omits soft-deleted)", async () => {
    const userA = await seedUserDirectly({ email: "ds7@test.local" });
    const a = await createSource(
      userA.id,
      { kind: "youtube_channel", handleUrl: "https://youtube.com/@a" },
      "127.0.0.1",
    );
    const b = await createSource(
      userA.id,
      { kind: "youtube_channel", handleUrl: "https://youtube.com/@b" },
      "127.0.0.1",
    );
    await softDeleteSource(userA.id, b.id, "127.0.0.1");

    const active = await listSources(userA.id);
    expect(active.map((r) => r.id)).toEqual([a.id]);

    const includingDeleted = await listSources(userA.id, { includeDeleted: true });
    expect(includingDeleted.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("getSourceById on cross-tenant id throws NotFoundError (404, never 403)", async () => {
    const userA = await seedUserDirectly({ email: "ds8a@test.local" });
    const userB = await seedUserDirectly({ email: "ds8b@test.local" });
    const aSource = await createSource(
      userA.id,
      { kind: "youtube_channel", handleUrl: "https://youtube.com/@a8" },
      "127.0.0.1",
    );
    await expect(getSourceById(userB.id, aSource.id)).rejects.toBeInstanceOf(NotFoundError);

    // P1 invariant: the response must never carry the strings 'forbidden' or 'permission'
    // for tenant-owned resources. NotFoundError carries 'not_found'.
    try {
      await getSourceById(userB.id, aSource.id);
    } catch (e) {
      const err = e as AppError;
      expect(err.code).toBe("not_found");
      expect(err.status).toBe(404);
      expect(err.message).not.toMatch(/forbidden|permission/i);
    }
  });
});

describe("soft-delete + retention + auto_import toggle + audit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("softDeleteSource sets deleted_at and returns the soft-deleted row", async () => {
    const userA = await seedUserDirectly({ email: "ds9@test.local" });
    const src = await createSource(
      userA.id,
      { kind: "youtube_channel", handleUrl: "https://youtube.com/@del" },
      "127.0.0.1",
    );

    const deleted = await softDeleteSource(userA.id, src.id, "127.0.0.1", "ua");
    expect(deleted.deletedAt).not.toBeNull();

    const [persisted] = await db
      .select()
      .from(dataSources)
      .where(eq(dataSources.id, src.id))
      .limit(1);
    expect(persisted!.deletedAt).not.toBeNull();
  });

  it("softDeleteSource called twice on the same id throws NotFoundError on the second call (idempotency)", async () => {
    const userA = await seedUserDirectly({ email: "ds10@test.local" });
    const src = await createSource(
      userA.id,
      { kind: "youtube_channel", handleUrl: "https://youtube.com/@idem" },
      "127.0.0.1",
    );
    await softDeleteSource(userA.id, src.id, "127.0.0.1");
    await expect(softDeleteSource(userA.id, src.id, "127.0.0.1")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("restoreSource clears deleted_at when within RETENTION_DAYS window", async () => {
    const userA = await seedUserDirectly({ email: "ds11@test.local" });
    const src = await createSource(
      userA.id,
      { kind: "youtube_channel", handleUrl: "https://youtube.com/@rest" },
      "127.0.0.1",
    );
    await softDeleteSource(userA.id, src.id, "127.0.0.1");

    const restored = await restoreSource(userA.id, src.id, "127.0.0.1");
    expect(restored.deletedAt).toBeNull();

    const [persisted] = await db
      .select()
      .from(dataSources)
      .where(eq(dataSources.id, src.id))
      .limit(1);
    expect(persisted!.deletedAt).toBeNull();
  });

  it("restoreSource throws AppError 'retention_expired' when the soft-delete is older than RETENTION_DAYS", async () => {
    const userA = await seedUserDirectly({ email: "ds12@test.local" });
    const src = await createSource(
      userA.id,
      { kind: "youtube_channel", handleUrl: "https://youtube.com/@retn" },
      "127.0.0.1",
    );
    // Manually push deleted_at to 90 days ago (RETENTION_DAYS default = 60).
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000);
    await db
      .update(dataSources)
      .set({ deletedAt: ninetyDaysAgo })
      .where(and(eq(dataSources.userId, userA.id), eq(dataSources.id, src.id)));

    await expect(restoreSource(userA.id, src.id, "127.0.0.1")).rejects.toMatchObject({
      code: "retention_expired",
      status: 422,
    });
  });

  it("post-build review 2026-05-08 (4th pass): createSource with resolvedChannelId allows re-add when soft-deleted source is past RETENTION_DAYS", async () => {
    // Regression for the third-pass review's #4 finding (deadlock loop).
    // Before the fix, a soft-deleted source past RETENTION_DAYS hit:
    //   - restoreSource → retention_expired (window closed)
    //   - createSource → duplicate_source_soft_deleted (gate threw on
    //     ANY tombstone with the same channelId, regardless of age)
    // The user could neither restore nor re-add — UX deadlock.
    //
    // The fix relaxes the duplicate gate: tombstones older than
    // RETENTION_DAYS skip the duplicate check, so a fresh INSERT lands
    // on the partial unique (user_id, handle_url) WHERE deleted_at IS
    // NULL. The orphan tombstone row stays in data_sources for active
    // users — purge.daily only sweeps tombstones owned by purged
    // accounts, NOT soft-deleted rows of active users. Accumulation is
    // bounded by user behaviour (a real operator does not delete +
    // re-add the same channel hundreds of times); if it ever becomes a
    // real cost a separate sweeper can be added.
    //
    // The earlier regression test (post-build review 3rd pass) covered
    // the handle-only path. This one specifically hits the
    // resolvedChannelId branch, which is where the deadlock actually
    // lived in production: the duplicate gate at data-sources.ts:235
    // looks up by channel_id, not handle_url.
    const userA = await seedUserDirectly({
      email: `ds-resolved-tombstone-${Math.random().toString(36).slice(2, 8)}@test.local`,
    });
    const channelId = "UCresolved01resolved01reso";

    // Create source with channel_id pre-resolved (no parseYoutubeChannelUrl
    // round-trip — exercises the duplicate gate's resolved path directly).
    const src = await createSource(
      userA.id,
      {
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/channel/${channelId}`,
        channelId,
      },
      "127.0.0.1",
    );
    // Soft-delete and push deletedAt past RETENTION_DAYS (default 60).
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000);
    await db
      .update(dataSources)
      .set({ deletedAt: ninetyDaysAgo })
      .where(and(eq(dataSources.userId, userA.id), eq(dataSources.id, src.id)));

    // Re-add must succeed — past retention, the tombstone no longer
    // blocks. The new row uses a distinct handleUrl so the partial
    // unique on (user_id, handle_url) WHERE deleted_at IS NULL lets it
    // through (the old row's handleUrl is still in use, but its
    // deletedAt is non-null so the partial unique excludes it).
    const resurrected = await createSource(
      userA.id,
      {
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/channel/${channelId}-v2`,
        channelId,
      },
      "127.0.0.1",
    );
    expect(resurrected.id).not.toBe(src.id);
    expect(resurrected.channelId).toBe(channelId);
    expect(resurrected.deletedAt).toBeNull();

    // Within-retention case still throws — paint a fresh tombstone
    // (deletedAt = now) and verify createSource still rejects with the
    // duplicate_source_soft_deleted error (the recoverable-via-Restore
    // path is unchanged).
    const userB = await seedUserDirectly({
      email: `ds-resolved-recent-${Math.random().toString(36).slice(2, 8)}@test.local`,
    });
    const recentChannelId = "UCrecent01recent01recent01";
    const recentSrc = await createSource(
      userB.id,
      {
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/channel/${recentChannelId}`,
        channelId: recentChannelId,
      },
      "127.0.0.1",
    );
    await db
      .update(dataSources)
      .set({ deletedAt: new Date() })
      .where(and(eq(dataSources.userId, userB.id), eq(dataSources.id, recentSrc.id)));

    await expect(
      createSource(
        userB.id,
        {
          kind: "youtube_channel",
          handleUrl: `https://www.youtube.com/channel/${recentChannelId}-v2`,
          channelId: recentChannelId,
        },
        "127.0.0.1",
      ),
    ).rejects.toMatchObject({
      code: "duplicate_source_soft_deleted",
      status: 409,
    });
  });

  it("post-build review 2026-05-08 (6th pass): newer within-retention tombstone blocks re-add even when an older expired tombstone exists for the same channel", async () => {
    // Regression for the sixth-pass review's finding. Pre-fix, the gate
    // ordered tombstones by deleted_at ASC NULLS FIRST and took .limit(1)
    // — so when both a >60d-old AND a <60d-old tombstone existed for the
    // same channel, the OLD one won the limit, the gate marked
    // pastRetention=true, and the user could re-add the channel even
    // though the recent tombstone was still recoverable via Restore.
    // Result: a Restore-on-the-recent then a re-add could land two
    // active sources for the same channel under different handle_urls
    // (the partial unique on handle_url would not catch the divergent
    // URLs).
    //
    // Fixed in the same pass: the gate now fetches ALL rows for
    // (userId, channelId) and explicitly checks (a) any active row →
    // duplicate_source, (b) any within-retention tombstone →
    // duplicate_source_soft_deleted, (c) only past-retention tombstones
    // → fall through. This test pins (b) when (c)-shape rows ALSO exist.
    const userC = await seedUserDirectly({
      email: `ds-mixed-tombstones-${Math.random().toString(36).slice(2, 8)}@test.local`,
    });
    const channelId = "UCmixed01mixed01mixed01mix";

    // Old tombstone (past retention).
    const oldSrc = await createSource(
      userC.id,
      {
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/channel/${channelId}-old`,
        channelId,
      },
      "127.0.0.1",
    );
    await db
      .update(dataSources)
      .set({ deletedAt: new Date(Date.now() - 90 * 86_400_000) })
      .where(and(eq(dataSources.userId, userC.id), eq(dataSources.id, oldSrc.id)));

    // Recent tombstone (within retention).
    const recentSrc = await createSource(
      userC.id,
      {
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/channel/${channelId}-recent`,
        channelId,
      },
      "127.0.0.1",
    );
    await db
      .update(dataSources)
      .set({ deletedAt: new Date(Date.now() - 5 * 86_400_000) })
      .where(and(eq(dataSources.userId, userC.id), eq(dataSources.id, recentSrc.id)));

    // Re-add MUST fail — the recent tombstone is still recoverable via
    // Restore, so the gate should redirect the user there. Pre-fix, the
    // OLD tombstone won the .limit(1) ordering and the gate fell through.
    await expect(
      createSource(
        userC.id,
        {
          kind: "youtube_channel",
          handleUrl: `https://www.youtube.com/channel/${channelId}-v3`,
          channelId,
        },
        "127.0.0.1",
      ),
    ).rejects.toMatchObject({
      code: "duplicate_source_soft_deleted",
      status: 409,
      metadata: expect.objectContaining({
        // Error names the recent tombstone (the one Restore would
        // target), not the old one.
        source_id: recentSrc.id,
      }),
    });
  });

  it("updateSource toggling autoImport=false writes audit_action='source.toggled_auto_import' with from/to metadata", async () => {
    const userA = await seedUserDirectly({ email: "ds13@test.local" });
    const src = await createSource(
      userA.id,
      {
        kind: "youtube_channel",
        handleUrl: "https://youtube.com/@toggle",
        autoImport: true,
      },
      "127.0.0.1",
    );

    const updated = await updateSource(
      userA.id,
      src.id,
      { autoImport: false },
      "10.0.0.1",
      "test-agent",
    );
    expect(updated.autoImport).toBe(false);

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, userA.id), eq(auditLog.action, "source.toggled_auto_import")));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({
      source_id: src.id,
      kind: "youtube_channel",
      from: true,
      to: false,
    });
  });

  it("updateSource WITHOUT changing autoImport does NOT emit a toggle audit row", async () => {
    const userA = await seedUserDirectly({ email: "ds13b@test.local" });
    const src = await createSource(
      userA.id,
      {
        kind: "youtube_channel",
        handleUrl: "https://youtube.com/@nochange",
        autoImport: true,
      },
      "127.0.0.1",
    );
    await updateSource(userA.id, src.id, { displayName: "Renamed" }, "127.0.0.1");
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, userA.id), eq(auditLog.action, "source.toggled_auto_import")));
    expect(audits).toHaveLength(0);
  });

  it("softDeleteSource writes audit BEFORE the soft-delete update (forensics order)", async () => {
    const userA = await seedUserDirectly({ email: "ds14@test.local" });
    const src = await createSource(
      userA.id,
      { kind: "youtube_channel", handleUrl: "https://youtube.com/@order" },
      "127.0.0.1",
    );

    // Spy on writeAudit. When it's called, the source row's deleted_at MUST
    // still be NULL — the audit fires BEFORE the UPDATE that sets it (the
    // same forensics-order pattern removeSteamKey uses): even if the UPDATE
    // later fails, the security signal lands.
    const auditSpy = vi.spyOn(Audit, "writeAudit").mockImplementation(async (entry) => {
      if (entry.action === "source.removed") {
        const [snapshot] = await db
          .select()
          .from(dataSources)
          .where(eq(dataSources.id, src.id))
          .limit(1);
        expect(snapshot!.deletedAt).toBeNull();
      }
    });

    await softDeleteSource(userA.id, src.id, "127.0.0.1");

    expect(auditSpy.mock.calls.some(([entry]) => entry.action === "source.removed")).toBe(true);
  });

  it("cross-tenant softDeleteSource throws NotFoundError (404, never 403)", async () => {
    const userA = await seedUserDirectly({ email: "ds15a@test.local" });
    const userB = await seedUserDirectly({ email: "ds15b@test.local" });
    const aSrc = await createSource(
      userA.id,
      { kind: "youtube_channel", handleUrl: "https://youtube.com/@xtA" },
      "127.0.0.1",
    );
    await expect(softDeleteSource(userB.id, aSrc.id, "127.0.0.1")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("cross-tenant updateSource + restoreSource throw NotFoundError", async () => {
    const userA = await seedUserDirectly({ email: "ds16a@test.local" });
    const userB = await seedUserDirectly({ email: "ds16b@test.local" });
    const aSrc = await createSource(
      userA.id,
      { kind: "youtube_channel", handleUrl: "https://youtube.com/@xtB" },
      "127.0.0.1",
    );
    await expect(
      updateSource(userB.id, aSrc.id, { autoImport: false }, "127.0.0.1"),
    ).rejects.toBeInstanceOf(NotFoundError);

    await softDeleteSource(userA.id, aSrc.id, "127.0.0.1");
    await expect(restoreSource(userB.id, aSrc.id, "127.0.0.1")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("soft-deleted source can be re-added via the partial unique index (resurrect by re-create)", async () => {
    // The unique index is `WHERE deleted_at IS NULL`, so the soft-deleted
    // handle does not block a fresh registration of the same handle_url.
    const userA = await seedUserDirectly({ email: "ds17@test.local" });
    const first = await createSource(
      userA.id,
      { kind: "youtube_channel", handleUrl: "https://youtube.com/@resurrect" },
      "127.0.0.1",
    );
    await softDeleteSource(userA.id, first.id, "127.0.0.1");

    const second = await createSource(
      userA.id,
      { kind: "youtube_channel", handleUrl: "https://youtube.com/@resurrect" },
      "127.0.0.1",
    );
    expect(second.id).not.toBe(first.id);
    expect(second.deletedAt).toBeNull();
  });
});

// /api/sources HTTP-boundary tests. The service-layer suite above asserts
// behaviour against the Drizzle layer; these tests assert that the Hono
// router wires the same contract into the HTTP envelope (status codes +
// DTO projection + tenantScope guard).
describe("/api/sources HTTP boundary", () => {
  it("POST /api/sources kind=youtube_channel returns 201 + DataSourceDto without userId", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "http-src-1@test.local" });
    const res = await app.request("/api/sources", {
      method: "POST",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "youtube_channel",
        handleUrl: "https://www.youtube.com/@http-happy",
        displayName: "HTTP Happy",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("userId");
    expect(body.kind).toBe("youtube_channel");
    expect(body.handleUrl).toBe("https://www.youtube.com/@http-happy");
  });

  it("post-build review 2026-05-08 (8th pass): POST /api/sources strips client-supplied channelId — must not bypass URL canonicalization", async () => {
    // Regression for the eighth-pass review's finding. Pre-fix, the HTTP
    // schema accepted an optional `channelId` and the route handler
    // forwarded it to the service. createSource's parseYoutubeChannelUrl
    // gate (`if (kind === 'youtube_channel' && resolvedChannelId === null)`)
    // skipped when the supplied channelId was non-null — so a forged
    // payload like {kind:'youtube_channel', handleUrl:'https://evil.com/x',
    // channelId:'UCfaked...'} would land a row with a non-YouTube URL
    // under kind=youtube_channel. The duplicate gate (post-fix) and the
    // adapter both trust the kind/URL pairing; a forged channel_id
    // breaks both. Fix dropped the field from the HTTP schema entirely
    // (UI never sent it — sources/new/+page.svelte uses only handleUrl).
    //
    // Zod's default behaviour on extra keys is STRIP, so the route
    // accepts the request; the proof is that the persisted row's
    // channel_id is NOT the forged value but either NULL (handle URL
    // path defers resolution to the worker) or the canonical UC id
    // derived from a UC URL.
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "http-src-forge@test.local" });
    const res = await app.request("/api/sources", {
      method: "POST",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "youtube_channel",
        handleUrl: "https://www.youtube.com/@no-forge-attempt",
        displayName: "No Forge",
        channelId: "UCfakedfakedfakedfakedfak", // 24-char shape — must be stripped
      }),
    });
    expect(res.status).toBe(201);

    // Read the persisted row directly so we observe what landed in the
    // DB, not just the DTO projection.
    const [row] = await db.select().from(dataSources).where(eq(dataSources.userId, u.id));
    expect(row).toBeDefined();
    // For an /@handle URL the worker resolves channel_id later — at this
    // POST stage the column is NULL. The load-bearing assertion is
    // simply: the FORGED value is NOT what landed.
    expect(row!.channelId).not.toBe("UCfakedfakedfakedfakedfak");
    expect(row!.handleUrl).toBe("https://www.youtube.com/@no-forge-attempt");
  });

  it("POST /api/sources kind=reddit_account returns 201 (Phase 03.1 — adapter functional)", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "http-src-2@test.local" });
    const res = await app.request("/api/sources", {
      method: "POST",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "reddit_account",
        handleUrl: "https://reddit.com/user/d954mas",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { kind: string };
    expect(body.kind).toBe("reddit_account");
  });

  it("POST /api/sources kind=reddit synthetic — user URL resolves to reddit_account", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "http-src-reddit-syn-1@test.local" });
    const res = await app.request("/api/sources", {
      method: "POST",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "reddit",
        handleUrl: "https://reddit.com/user/d954mas",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { kind: string; handleUrl: string };
    expect(body.kind).toBe("reddit_account");
    expect(body.handleUrl).toBe("https://www.reddit.com/user/d954mas");
  });

  it("POST /api/sources kind=reddit synthetic — sub URL resolves to reddit_subreddit", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "http-src-reddit-syn-2@test.local" });
    const res = await app.request("/api/sources", {
      method: "POST",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "reddit",
        handleUrl: "https://www.reddit.com/r/IndieDev",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { kind: string; handleUrl: string };
    expect(body.kind).toBe("reddit_subreddit");
    expect(body.handleUrl).toBe("https://www.reddit.com/r/IndieDev");
  });

  it("POST /api/sources kind=reddit synthetic — non-Reddit URL returns 422 invalid_reddit_url", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "http-src-reddit-syn-3@test.local" });
    const res = await app.request("/api/sources", {
      method: "POST",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "reddit",
        handleUrl: "https://example.com/r/IndieDev",
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_reddit_url");
  });

  it("POST /api/sources duplicate handleUrl returns 422 duplicate_source", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "http-src-3@test.local" });
    const cookie = `neotolis.session_token=${u.signedSessionCookieValue}`;
    const body = JSON.stringify({
      kind: "youtube_channel",
      handleUrl: "https://www.youtube.com/@http-dup",
    });
    const r1 = await app.request("/api/sources", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body,
    });
    expect(r1.status).toBe(201);
    const r2 = await app.request("/api/sources", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body,
    });
    expect(r2.status).toBe(422);
    expect((await r2.json()).error).toBe("duplicate_source");
  });

  it("GET /api/sources omits soft-deleted by default; ?includeDeleted=true returns them", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "http-src-4@test.local" });
    const a = await createSource(
      u.id,
      { kind: "youtube_channel", handleUrl: "https://www.youtube.com/@http-a" },
      "127.0.0.1",
    );
    const b = await createSource(
      u.id,
      { kind: "youtube_channel", handleUrl: "https://www.youtube.com/@http-b" },
      "127.0.0.1",
    );
    await softDeleteSource(u.id, b.id, "127.0.0.1");

    const cookie = `neotolis.session_token=${u.signedSessionCookieValue}`;
    const rDefault = await app.request("/api/sources", { headers: { cookie } });
    expect(rDefault.status).toBe(200);
    const listDefault = (await rDefault.json()) as Array<{ id: string }>;
    expect(listDefault.map((r) => r.id)).toEqual([a.id]);

    const rAll = await app.request("/api/sources?includeDeleted=true", {
      headers: { cookie },
    });
    expect(rAll.status).toBe(200);
    const listAll = (await rAll.json()) as Array<{ id: string }>;
    expect(listAll.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("DELETE /api/sources/:id returns 200 + soft-deleted DTO; second call returns 404", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "http-src-5@test.local" });
    const src = await createSource(
      u.id,
      { kind: "youtube_channel", handleUrl: "https://www.youtube.com/@http-del" },
      "127.0.0.1",
    );
    const cookie = `neotolis.session_token=${u.signedSessionCookieValue}`;
    const r1 = await app.request(`/api/sources/${src.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(r1.status).toBe(200);
    const body = (await r1.json()) as { id: string; deletedAt: string | null };
    expect(body.id).toBe(src.id);
    expect(body.deletedAt).not.toBeNull();

    const r2 = await app.request(`/api/sources/${src.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(r2.status).toBe(404);
    expect((await r2.json()).error).toBe("not_found");
  });

  it("POST /api/sources/:id/restore beyond RETENTION_DAYS returns 422 retention_expired", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "http-src-6@test.local" });
    const src = await createSource(
      u.id,
      {
        kind: "youtube_channel",
        handleUrl: "https://www.youtube.com/@http-retn",
      },
      "127.0.0.1",
    );
    await softDeleteSource(u.id, src.id, "127.0.0.1");
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000);
    await db
      .update(dataSources)
      .set({ deletedAt: ninetyDaysAgo })
      .where(and(eq(dataSources.userId, u.id), eq(dataSources.id, src.id)));

    const res = await app.request(`/api/sources/${src.id}/restore`, {
      method: "POST",
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("retention_expired");
  });
});

/**
 * Direct state-machine tests for the channel-duplicate gate.
 *
 * createSource exercises the gate end-to-end (covered by tests above);
 * this suite isolates the gate from URL parsing, withQuotaGuard, and the
 * INSERT path so a state-machine regression surfaces with a precise
 * error message instead of a long stack starting from
 * `parseYoutubeChannelUrl`.
 *
 * The gate's contract (three states):
 *   1. Active row exists                        → duplicate_source
 *   2. Any tombstone within RETENTION_DAYS      → duplicate_source_soft_deleted
 *   3. Only past-retention tombstones (or none) → fall through (no throw)
 *
 * The function MUST run inside a tx — the type narrows to `Tx`. We open
 * one with db.transaction(async (tx) => …) here just to satisfy the
 * type; the test fixtures do not require advisory-lock semantics.
 */
describe("assertNoChannelConflict — state machine (direct)", () => {
  const uniq = (): string => Math.random().toString(36).slice(2, 10);
  const CHANNEL = (): string => `UC${uniq()}${uniq()}padd0`.slice(0, 24);

  async function withTx<T>(
    fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    return db.transaction(fn);
  }

  it("(1) zero rows → no throw", async () => {
    const u = await seedUserDirectly({ email: `gate-empty-${uniq()}@test.local` });
    const channelId = CHANNEL();
    await expect(
      withTx((tx) => assertNoChannelConflict(tx, u.id, channelId)),
    ).resolves.toBeUndefined();
  });

  it("(2) single active row → duplicate_source", async () => {
    const u = await seedUserDirectly({ email: `gate-active-${uniq()}@test.local` });
    const channelId = CHANNEL();
    await db.insert(dataSources).values({
      userId: u.id,
      kind: "youtube_channel",
      handleUrl: `https://www.youtube.com/channel/${channelId}`,
      channelId,
      isOwnedByMe: true,
      autoImport: true,
      metadata: {},
    });
    await expect(
      withTx((tx) => assertNoChannelConflict(tx, u.id, channelId)),
    ).rejects.toMatchObject({
      code: "duplicate_source",
      status: 409,
    });
  });

  it("(3) single within-retention tombstone → duplicate_source_soft_deleted", async () => {
    const u = await seedUserDirectly({ email: `gate-recent-${uniq()}@test.local` });
    const channelId = CHANNEL();
    await db.insert(dataSources).values({
      userId: u.id,
      kind: "youtube_channel",
      handleUrl: `https://www.youtube.com/channel/${channelId}`,
      channelId,
      isOwnedByMe: true,
      autoImport: true,
      metadata: {},
      // 5 days ago — well within default RETENTION_DAYS=60.
      deletedAt: new Date(Date.now() - 5 * 86_400_000),
    });
    await expect(
      withTx((tx) => assertNoChannelConflict(tx, u.id, channelId)),
    ).rejects.toMatchObject({
      code: "duplicate_source_soft_deleted",
      status: 409,
    });
  });

  it("(4) single past-retention tombstone → no throw", async () => {
    const u = await seedUserDirectly({ email: `gate-past-${uniq()}@test.local` });
    const channelId = CHANNEL();
    await db.insert(dataSources).values({
      userId: u.id,
      kind: "youtube_channel",
      handleUrl: `https://www.youtube.com/channel/${channelId}`,
      channelId,
      isOwnedByMe: true,
      autoImport: true,
      metadata: {},
      // 90 days ago — past default RETENTION_DAYS=60.
      deletedAt: new Date(Date.now() - 90 * 86_400_000),
    });
    await expect(
      withTx((tx) => assertNoChannelConflict(tx, u.id, channelId)),
    ).resolves.toBeUndefined();
  });

  it("(5) active + tombstone → active wins → duplicate_source", async () => {
    const u = await seedUserDirectly({ email: `gate-both-${uniq()}@test.local` });
    const channelId = CHANNEL();
    // Tombstone first (recent — would block on its own).
    await db.insert(dataSources).values({
      userId: u.id,
      kind: "youtube_channel",
      handleUrl: `https://www.youtube.com/channel/${channelId}-tomb`,
      channelId,
      isOwnedByMe: true,
      autoImport: true,
      metadata: {},
      deletedAt: new Date(Date.now() - 3 * 86_400_000),
    });
    // Active.
    await db.insert(dataSources).values({
      userId: u.id,
      kind: "youtube_channel",
      handleUrl: `https://www.youtube.com/channel/${channelId}-active`,
      channelId,
      isOwnedByMe: true,
      autoImport: true,
      metadata: {},
    });
    await expect(
      withTx((tx) => assertNoChannelConflict(tx, u.id, channelId)),
    ).rejects.toMatchObject({
      code: "duplicate_source",
      status: 409,
    });
  });

  it("(6) recent + old tombstones → recent wins → duplicate_source_soft_deleted naming the recent row", async () => {
    const u = await seedUserDirectly({ email: `gate-mixed-${uniq()}@test.local` });
    const channelId = CHANNEL();
    // Old tombstone (past retention).
    await db.insert(dataSources).values({
      userId: u.id,
      kind: "youtube_channel",
      handleUrl: `https://www.youtube.com/channel/${channelId}-old`,
      channelId,
      isOwnedByMe: true,
      autoImport: true,
      metadata: {},
      deletedAt: new Date(Date.now() - 90 * 86_400_000),
    });
    // Recent tombstone (within retention).
    const [recent] = await db
      .insert(dataSources)
      .values({
        userId: u.id,
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/channel/${channelId}-recent`,
        channelId,
        isOwnedByMe: true,
        autoImport: true,
        metadata: {},
        deletedAt: new Date(Date.now() - 5 * 86_400_000),
      })
      .returning();
    await expect(
      withTx((tx) => assertNoChannelConflict(tx, u.id, channelId)),
    ).rejects.toMatchObject({
      code: "duplicate_source_soft_deleted",
      status: 409,
      metadata: expect.objectContaining({ source_id: recent!.id }),
    });
  });

  it("(7) only past-retention tombstones → no throw", async () => {
    const u = await seedUserDirectly({ email: `gate-allpast-${uniq()}@test.local` });
    const channelId = CHANNEL();
    for (const daysAgo of [70, 90, 120]) {
      await db.insert(dataSources).values({
        userId: u.id,
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/channel/${channelId}-${daysAgo}`,
        channelId,
        isOwnedByMe: true,
        autoImport: true,
        metadata: {},
        deletedAt: new Date(Date.now() - daysAgo * 86_400_000),
      });
    }
    await expect(
      withTx((tx) => assertNoChannelConflict(tx, u.id, channelId)),
    ).resolves.toBeUndefined();
  });

  it("(8) cross-tenant: another user's row for same channelId is invisible", async () => {
    const userA = await seedUserDirectly({ email: `gate-tcA-${uniq()}@test.local` });
    const userB = await seedUserDirectly({ email: `gate-tcB-${uniq()}@test.local` });
    const channelId = CHANNEL();
    // User A has an active row for this channel.
    await db.insert(dataSources).values({
      userId: userA.id,
      kind: "youtube_channel",
      handleUrl: `https://www.youtube.com/channel/${channelId}`,
      channelId,
      isOwnedByMe: true,
      autoImport: true,
      metadata: {},
    });
    // User B asks the gate for the same channel — must NOT see userA's row.
    await expect(
      withTx((tx) => assertNoChannelConflict(tx, userB.id, channelId)),
    ).resolves.toBeUndefined();
  });
});
