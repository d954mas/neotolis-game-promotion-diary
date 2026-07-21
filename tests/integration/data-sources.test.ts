import { describe, it, expect, vi, afterEach } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  createSource,
  listSources,
  getSourceById,
  updateSource,
  softDeleteSource,
  restoreSource,
  assertNoChannelConflict,
  markSourceNeedsReconnect,
  clearNeedsReconnect,
  hardDeleteSource,
} from "../../src/lib/server/services/data-sources.js";
import { loadSourceDetailPage } from "../../src/lib/server/services/sources-page-read.js";
import { toDataSourceDto } from "../../src/lib/server/dto.js";
import { db } from "../../src/lib/server/db/client.js";
import { dataSources } from "../../src/lib/server/db/schema/data-sources.js";
import { auditLog } from "../../src/lib/server/db/schema/audit-log.js";
import { redditAccounts } from "../../src/lib/sources/reddit/server/schema/index.js";
import { dataSourceChannelState } from "../../src/lib/server/db/schema/data-source-channel-state.js";
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

  it("kind=reddit_account with autoImport=false skips source-action cap", async () => {
    const userA = await seedUserDirectly({ email: "ds2passive@test.local" });
    for (let i = 0; i < 5; i++) {
      await db.execute(sql`
        INSERT INTO adapter_refresh_queue (adapter_kind, queue_name, type, payload, user_id, priority)
        VALUES ('reddit_account', 'user_source', 'author_poll',
                ${`{"handle":"existing_${i}"}`}::jsonb, ${userA.id}, 1)
      `);
    }

    const created = await createSource(
      userA.id,
      {
        kind: "reddit_account",
        handleUrl: "https://reddit.com/user/passive-source",
        autoImport: false,
      },
      "127.0.0.1",
    );

    expect(created.autoImport).toBe(false);
    const queueRows = await db.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM adapter_refresh_queue
      WHERE adapter_kind = 'reddit_account'
        AND queue_name = 'user_source'
        AND user_id = ${userA.id}
    `);
    expect(Number((queueRows.rows[0] as { count: number | string }).count)).toBe(5);
  });

  it("source detail read-model enriches reddit_account lastPolledAt", async () => {
    const userA = await seedUserDirectly({ email: "ds2detail@test.local" });
    const created = await createSource(
      userA.id,
      {
        kind: "reddit_account",
        handleUrl: "https://reddit.com/user/detailpolled",
        autoImport: false,
      },
      "127.0.0.1",
    );
    const lastMetadataRefreshAt = new Date("2026-05-18T10:00:00.000Z");
    await db.insert(redditAccounts).values({
      username: "detailpolled",
      lastRefreshedAt: lastMetadataRefreshAt,
    });

    const detail = await loadSourceDetailPage(userA.id, created.id);

    expect(detail.source.lastPolledAt?.toISOString()).toBe(lastMetadataRefreshAt.toISOString());
  });

  it("source detail read-model enriches telegram_channel lastPolledAt from channel-state", async () => {
    const userA = await seedUserDirectly({ email: "ds2tgdetail@test.local" });
    const created = await createSource(
      userA.id,
      {
        kind: "telegram_channel",
        handleUrl: "https://t.me/detailpolledtg",
        autoImport: false,
      },
      "127.0.0.1",
    );
    const lastPolledAt = new Date("2026-05-19T10:00:00.000Z");
    await db.insert(dataSourceChannelState).values({
      kind: "telegram_channel",
      channelKey: "detailpolledtg",
      lastPolledAt,
    });

    const detail = await loadSourceDetailPage(userA.id, created.id);

    // Without the telegram lastPolled enrichment the DTO would carry
    // lastPolledAt=null → SourceRow renders "Queued" forever even after polls
    // (the bug this guards). channelKey here is the @slug.
    expect(detail.source.lastPolledAt?.toISOString()).toBe(lastPolledAt.toISOString());
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

  it("kind discord_server rejects with 'kind_not_yet_functional'", async () => {
    // telegram_channel was in this list pre-Phase-9 (Plan 09-05 made it functional);
    // twitter_account was here pre-Phase-11 (Plan 11-04 made it functional — it now
    // degrades to kind_not_configured when the provider is unset, see
    // twitter-not-configured.test.ts). Only the still-schema-only kind (Discord —
    // coming soon) rejects with the schema-only kind_not_yet_functional.
    const userA = await seedUserDirectly({ email: "ds3@test.local" });
    const rejectedKinds = ["discord_server"] as const;
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

  // SOC-05 / SOC-03 not-configured degrade. The integration test process boots
  // with INSTAGRAM_PROVIDER="" (env.ts default — the safe self-host default), so
  // isInstagramConfigured() is false. createSource for instagram_account must
  // surface a clean 422 `kind_not_configured` (distinct from the schema-only
  // `kind_not_yet_functional`) — NOT a 500 — and persist no row. Body must never
  // carry "forbidden"/"permission" (cross-tenant carrier discipline; this is a
  // config gate, not an ownership gate, but the literal-string ban is global).
  it("kind=instagram_account with provider unconfigured rejects with 'kind_not_configured' (422), no row, no 500", async () => {
    const userA = await seedUserDirectly({ email: "ds-ig-notcfg@test.local" });
    try {
      await createSource(
        userA.id,
        { kind: "instagram_account", handleUrl: "https://www.instagram.com/natgeo/" },
        "127.0.0.1",
      );
      throw new Error("expected createSource to throw kind_not_configured");
    } catch (e) {
      const err = e as AppError;
      expect(err.code).toBe("kind_not_configured");
      expect(err.status).toBe(422);
      expect(err.metadata.kind).toBe("instagram_account");
      expect(err.metadata.status).toBe("not configured by operator");
      expect(err.message).not.toMatch(/forbidden|permission/i);
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

  // Phase 03.4-08: source titles became read-only canonical, with a separate
  // free-form `note` field replacing the inline-rename of `displayName`. The
  // service-layer contract: `note` round-trips through updateSource, the
  // column accepts null (clear), and cross-tenant updates still 404.
  it("updateSource persists note (set, clear, round-trip via getSourceById)", async () => {
    const userA = await seedUserDirectly({ email: "ds-note-a@test.local" });
    const src = await createSource(
      userA.id,
      { kind: "youtube_channel", handleUrl: "https://youtube.com/@withnote" },
      "127.0.0.1",
    );

    // Fresh row: note starts NULL (column nullable, default null).
    expect(src.note).toBeNull();

    // Set a non-empty note.
    const setRow = await updateSource(
      userA.id,
      src.id,
      { note: "press contact — asked for review codes" },
      "127.0.0.1",
    );
    expect(setRow.note).toBe("press contact — asked for review codes");

    // Re-read confirms persistence (not a return-value-only artifact).
    const reread = await getSourceById(userA.id, src.id);
    expect(reread.note).toBe("press contact — asked for review codes");

    // Clearing via null sets the column back to NULL.
    const clearedRow = await updateSource(userA.id, src.id, { note: null }, "127.0.0.1");
    expect(clearedRow.note).toBeNull();
  });

  it("cross-tenant updateSource with note still throws NotFoundError (404, never 403)", async () => {
    const userA = await seedUserDirectly({ email: "ds-note-b@test.local" });
    const userB = await seedUserDirectly({ email: "ds-note-c@test.local" });
    const aSrc = await createSource(
      userA.id,
      { kind: "youtube_channel", handleUrl: "https://youtube.com/@victim" },
      "127.0.0.1",
    );
    // userB attempts to set a note on userA's source — tenant-scope WHERE on
    // the SELECT inside updateSource (getSourceById) yields no row, and the
    // 404 sentinel fires. Note-aware patch path inherits the same gate; no
    // separate test surface needed for the column itself.
    await expect(
      updateSource(userB.id, aSrc.id, { note: "I should not see this" }, "127.0.0.1"),
    ).rejects.toBeInstanceOf(NotFoundError);
    // Bonus: the row stays untouched.
    const persisted = await getSourceById(userA.id, aSrc.id);
    expect(persisted.note).toBeNull();
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

// markSourceNeedsReconnect — AdapterError surface columns.
// Plan 03.4-08 surfaces these to /sources as a danger-tinted 'Error: <kind>'
// pill on SourceRow. The UI render path keys off DTO fields, so the
// load-bearing invariant is: after the helper writes, the DTO carries the
// expected values back through getSourceById → toDataSourceDto.
describe("markSourceNeedsReconnect — surfaces AdapterError state on DTO", () => {
  it("flips needsReconnect=true + writes lastErrorKind + lastErrorAt on the source row", async () => {
    const userA = await seedUserDirectly({ email: "ds-needs-reconnect@test.local" });
    const src = await createSource(
      userA.id,
      { kind: "youtube_channel", handleUrl: "https://www.youtube.com/@needs-reconnect" },
      "127.0.0.1",
    );
    // Sanity — fresh source is clean.
    const beforeDto = toDataSourceDto(await getSourceById(userA.id, src.id));
    expect(beforeDto.needsReconnect).toBe(false);
    expect(beforeDto.lastErrorKind).toBeNull();
    expect(beforeDto.lastErrorAt).toBeNull();

    const tStart = Date.now();
    await markSourceNeedsReconnect(userA.id, src.id, "not-found");

    const afterDto = toDataSourceDto(await getSourceById(userA.id, src.id));
    expect(afterDto.needsReconnect).toBe(true);
    expect(afterDto.lastErrorKind).toBe("not-found");
    expect(afterDto.lastErrorAt).toBeInstanceOf(Date);
    // lastErrorAt is "now-ish" — within the last 60s. Loose bound so the
    // assertion survives slow CI runners without becoming a flake.
    expect(afterDto.lastErrorAt!.getTime()).toBeGreaterThanOrEqual(tStart - 1000);
    expect(afterDto.lastErrorAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("operator-issue category surfaces as lastErrorKind='operator-issue' — drives 'Error: Setup' UI label", async () => {
    // Reddit cron + YouTube channel-context-backfill both write
    // 'operator-issue' for malformed source metadata. The SourceRow
    // pill maps that kind to "Error: Setup"; the integration contract
    // is just "the kind round-trips intact through the DTO".
    const userA = await seedUserDirectly({ email: "ds-needs-reconnect-op@test.local" });
    const src = await createSource(
      userA.id,
      { kind: "reddit_account", handleUrl: "https://reddit.com/user/operator-issue-test" },
      "127.0.0.1",
    );

    await markSourceNeedsReconnect(userA.id, src.id, "operator-issue");

    const dto = toDataSourceDto(await getSourceById(userA.id, src.id));
    expect(dto.needsReconnect).toBe(true);
    expect(dto.lastErrorKind).toBe("operator-issue");
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
    // Reddit identifiers are case-insensitive; the adapter lowercases
    // subreddit / username at the parser boundary so two subscribers
    // pasting different-case spellings land on the same canonical
    // cache row and fan-out lane.
    expect(body.handleUrl).toBe("https://www.reddit.com/r/indiedev");
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

// hardDeleteSource — permanent removal of soft-deleted data_sources rows.
// The service requires the row to already be soft-deleted; live rows and
// cross-tenant rows surface as NotFoundError (404, never 403).
describe("hardDeleteSource — permanent delete of soft-deleted sources", () => {
  it("soft-delete then hard-delete removes the row from the DB", async () => {
    const userA = await seedUserDirectly({ email: "hd-src-1@test.local" });
    const src = await createSource(
      userA.id,
      { kind: "youtube_channel", handleUrl: "https://youtube.com/@hard-del" },
      "127.0.0.1",
    );
    await softDeleteSource(userA.id, src.id, "127.0.0.1");

    await hardDeleteSource(userA.id, src.id, "127.0.0.1", "vitest");

    // Row is gone from the DB entirely.
    const rows = await db.select().from(dataSources).where(eq(dataSources.id, src.id));
    expect(rows).toHaveLength(0);
  });

  it("hard-delete via HTTP DELETE ?force=true returns 204 + row gone", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "hd-src-http@test.local" });
    const src = await createSource(
      u.id,
      { kind: "youtube_channel", handleUrl: "https://youtube.com/@hard-del-http" },
      "127.0.0.1",
    );
    await softDeleteSource(u.id, src.id, "127.0.0.1");

    const cookie = `neotolis.session_token=${u.signedSessionCookieValue}`;
    const res = await app.request(`/api/sources/${src.id}?force=true`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(res.status).toBe(204);

    const rows = await db.select().from(dataSources).where(eq(dataSources.id, src.id));
    expect(rows).toHaveLength(0);
  });

  it("hard-delete on a NON-soft-deleted source throws NotFoundError", async () => {
    const userA = await seedUserDirectly({ email: "hd-src-2@test.local" });
    const src = await createSource(
      userA.id,
      { kind: "youtube_channel", handleUrl: "https://youtube.com/@hard-del-live" },
      "127.0.0.1",
    );

    // Source is still live — hard-delete must reject.
    await expect(hardDeleteSource(userA.id, src.id, "127.0.0.1")).rejects.toBeInstanceOf(
      NotFoundError,
    );

    // Row is still in the DB.
    const rows = await db.select().from(dataSources).where(eq(dataSources.id, src.id));
    expect(rows).toHaveLength(1);
  });

  it("cross-tenant hard-delete throws NotFoundError (404, never 403)", async () => {
    const userA = await seedUserDirectly({ email: "hd-src-3a@test.local" });
    const userB = await seedUserDirectly({ email: "hd-src-3b@test.local" });
    const src = await createSource(
      userA.id,
      { kind: "youtube_channel", handleUrl: "https://youtube.com/@hard-del-xt" },
      "127.0.0.1",
    );
    await softDeleteSource(userA.id, src.id, "127.0.0.1");

    // userB attempts to hard-delete userA's source.
    const err = await hardDeleteSource(userB.id, src.id, "127.0.0.1").catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe("not_found");
    expect(err.status).toBe(404);
    expect(err.message).not.toMatch(/forbidden|permission/i);

    // Row is still intact for userA.
    const rows = await db.select().from(dataSources).where(eq(dataSources.id, src.id));
    expect(rows).toHaveLength(1);
  });

  it("hard-delete writes audit row source.delete_forever with correct metadata", async () => {
    const userA = await seedUserDirectly({ email: "hd-src-4@test.local" });
    const src = await createSource(
      userA.id,
      { kind: "youtube_channel", handleUrl: "https://youtube.com/@hard-del-audit" },
      "127.0.0.1",
    );
    await softDeleteSource(userA.id, src.id, "127.0.0.1");

    await hardDeleteSource(userA.id, src.id, "127.0.0.1", "vitest");

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, userA.id), eq(auditLog.action, "source.delete_forever")));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({
      source_id: src.id,
      kind: "youtube_channel",
    });
  });
});

// clearNeedsReconnect — counterpart to markSourceNeedsReconnect.
describe("clearNeedsReconnect — resets AdapterError surface columns", () => {
  it("mark then clear round-trips: needsReconnect=true → false, error fields nulled", async () => {
    const userA = await seedUserDirectly({ email: "clr-reconnect-1@test.local" });
    const src = await createSource(
      userA.id,
      { kind: "youtube_channel", handleUrl: "https://www.youtube.com/@clr-reconnect" },
      "127.0.0.1",
    );

    await markSourceNeedsReconnect(userA.id, src.id, "not-found");
    const afterMark = toDataSourceDto(await getSourceById(userA.id, src.id));
    expect(afterMark.needsReconnect).toBe(true);
    expect(afterMark.lastErrorKind).toBe("not-found");

    await clearNeedsReconnect(userA.id, src.id);
    const afterClear = toDataSourceDto(await getSourceById(userA.id, src.id));
    expect(afterClear.needsReconnect).toBe(false);
    expect(afterClear.lastErrorAt).toBeNull();
    expect(afterClear.lastErrorKind).toBeNull();
  });

  it("clearNeedsReconnect when already clear is a no-op (idempotent)", async () => {
    const userA = await seedUserDirectly({ email: "clr-reconnect-2@test.local" });
    const src = await createSource(
      userA.id,
      { kind: "youtube_channel", handleUrl: "https://www.youtube.com/@clr-noop" },
      "127.0.0.1",
    );

    // Source starts clean — clearNeedsReconnect should be a silent no-op.
    const before = toDataSourceDto(await getSourceById(userA.id, src.id));
    expect(before.needsReconnect).toBe(false);

    await clearNeedsReconnect(userA.id, src.id);

    const after = toDataSourceDto(await getSourceById(userA.id, src.id));
    expect(after.needsReconnect).toBe(false);
    expect(after.lastErrorAt).toBeNull();
    expect(after.lastErrorKind).toBeNull();
  });
});
