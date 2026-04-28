import { describe, it, expect, vi, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createSource,
  listSources,
  getSourceById,
  updateSource,
  softDeleteSource,
  restoreSource,
} from "../../src/lib/server/services/data-sources.js";
import { toDataSourceDto } from "../../src/lib/server/dto.js";
import { db } from "../../src/lib/server/db/client.js";
import { dataSources } from "../../src/lib/server/db/schema/data-sources.js";
import { auditLog } from "../../src/lib/server/db/schema/audit-log.js";
import * as Audit from "../../src/lib/server/audit.js";
import { NotFoundError, AppError } from "../../src/lib/server/services/errors.js";
import { seedUserDirectly } from "./helpers.js";

// Plan 02.1-04 — SOURCES-01 + SOURCES-02 service-layer integration.
//
// The Wave 0 it.skip placeholders from Plan 02.1-02 are flipped to live `it(...)`
// bodies here. Names continue to start with `Plan 02.1-04:` so a future grep
// can trace each placeholder to the plan that filled it. SOURCES-01 / SOURCES-02
// HTTP-route concerns (status codes, route shape) belong to Plan 02.1-06; this
// suite asserts service-layer behaviour exclusively.

describe("SOURCES-01: register data sources via POST /api/sources", () => {
  it("Plan 02.1-04: creating kind=youtube_channel returns row with userId-stripped DTO + active row in DB", async () => {
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

  it("Plan 02.1-04: kind=reddit_account rejects with AppError 'kind_not_yet_functional' (422 + metadata)", async () => {
    const userA = await seedUserDirectly({ email: "ds2@test.local" });
    await expect(
      createSource(
        userA.id,
        { kind: "reddit_account", handleUrl: "https://reddit.com/user/me" },
        "127.0.0.1",
      ),
    ).rejects.toMatchObject({
      code: "kind_not_yet_functional",
      status: 422,
      metadata: { kind: "reddit_account", available_phase: "Phase 3" },
    });

    // No row was inserted.
    const rows = await db
      .select()
      .from(dataSources)
      .where(eq(dataSources.userId, userA.id));
    expect(rows).toHaveLength(0);
  });

  it("Plan 02.1-04: kinds twitter_account / telegram_channel / discord_server reject with 'kind_not_yet_functional'", async () => {
    const userA = await seedUserDirectly({ email: "ds3@test.local" });
    const rejectedKinds = [
      "twitter_account",
      "telegram_channel",
      "discord_server",
    ] as const;
    for (const kind of rejectedKinds) {
      await expect(
        createSource(
          userA.id,
          { kind, handleUrl: `https://example.test/${kind}` },
          "127.0.0.1",
        ),
      ).rejects.toMatchObject({
        code: "kind_not_yet_functional",
        status: 422,
      });
    }
    const rows = await db
      .select()
      .from(dataSources)
      .where(eq(dataSources.userId, userA.id));
    expect(rows).toHaveLength(0);
  });

  it("Plan 02.1-04: empty handle_url rejects with AppError 'validation_failed' (422)", async () => {
    const userA = await seedUserDirectly({ email: "ds4@test.local" });
    await expect(
      createSource(
        userA.id,
        { kind: "youtube_channel", handleUrl: "" },
        "127.0.0.1",
      ),
    ).rejects.toMatchObject({ code: "validation_failed", status: 422 });
  });

  it("Plan 02.1-04: duplicate (user_id, handle_url) translates PG 23505 into 'duplicate_source' (422)", async () => {
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

  it("Plan 02.1-04: createSource writes audit_action='source.added' with ipAddress + userAgent", async () => {
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
      .where(
        and(
          eq(auditLog.userId, userA.id),
          eq(auditLog.action, "source.added"),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.ipAddress).toBe("192.0.2.7");
    expect(audits[0]!.userAgent).toBe("test-agent/1.0");
    expect(audits[0]!.metadata).toMatchObject({
      source_id: row.id,
      kind: "youtube_channel",
      handle_url: "https://youtube.com/@audited",
    });
  });

  it("Plan 02.1-04: listSources returns active rows only (omits soft-deleted)", async () => {
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

  it("Plan 02.1-04: getSourceById on cross-tenant id throws NotFoundError (404, never 403)", async () => {
    const userA = await seedUserDirectly({ email: "ds8a@test.local" });
    const userB = await seedUserDirectly({ email: "ds8b@test.local" });
    const aSource = await createSource(
      userA.id,
      { kind: "youtube_channel", handleUrl: "https://youtube.com/@a8" },
      "127.0.0.1",
    );
    await expect(getSourceById(userB.id, aSource.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );

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

describe("SOURCES-02: soft-delete + retention + auto_import toggle + audit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Plan 02.1-04: softDeleteSource sets deleted_at and returns the soft-deleted row", async () => {
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

  it("Plan 02.1-04: softDeleteSource called twice on the same id throws NotFoundError on the second call (idempotency)", async () => {
    const userA = await seedUserDirectly({ email: "ds10@test.local" });
    const src = await createSource(
      userA.id,
      { kind: "youtube_channel", handleUrl: "https://youtube.com/@idem" },
      "127.0.0.1",
    );
    await softDeleteSource(userA.id, src.id, "127.0.0.1");
    await expect(
      softDeleteSource(userA.id, src.id, "127.0.0.1"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("Plan 02.1-04: restoreSource clears deleted_at when within RETENTION_DAYS window", async () => {
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

  it("Plan 02.1-04: restoreSource throws AppError 'retention_expired' when the soft-delete is older than RETENTION_DAYS", async () => {
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

    await expect(
      restoreSource(userA.id, src.id, "127.0.0.1"),
    ).rejects.toMatchObject({ code: "retention_expired", status: 422 });
  });

  it("Plan 02.1-04: updateSource toggling autoImport=false writes audit_action='source.toggled_auto_import' with from/to metadata", async () => {
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
      .where(
        and(
          eq(auditLog.userId, userA.id),
          eq(auditLog.action, "source.toggled_auto_import"),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({
      source_id: src.id,
      kind: "youtube_channel",
      from: true,
      to: false,
    });
  });

  it("Plan 02.1-04: updateSource WITHOUT changing autoImport does NOT emit a toggle audit row", async () => {
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
    await updateSource(
      userA.id,
      src.id,
      { displayName: "Renamed" },
      "127.0.0.1",
    );
    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.userId, userA.id),
          eq(auditLog.action, "source.toggled_auto_import"),
        ),
      );
    expect(audits).toHaveLength(0);
  });

  it("Plan 02.1-04: softDeleteSource writes audit BEFORE the soft-delete update (D-32 forensics order)", async () => {
    const userA = await seedUserDirectly({ email: "ds14@test.local" });
    const src = await createSource(
      userA.id,
      { kind: "youtube_channel", handleUrl: "https://youtube.com/@order" },
      "127.0.0.1",
    );

    // Spy on writeAudit. When it's called, the source row's deleted_at MUST
    // still be NULL — the audit fires BEFORE the UPDATE that sets it. Mirrors
    // Phase 2 removeSteamKey's forensics-order pattern: even if the UPDATE
    // later fails, the security signal lands.
    const auditSpy = vi.spyOn(Audit, "writeAudit").mockImplementation(
      async (entry) => {
        if (entry.action === "source.removed") {
          const [snapshot] = await db
            .select()
            .from(dataSources)
            .where(eq(dataSources.id, src.id))
            .limit(1);
          expect(snapshot!.deletedAt).toBeNull();
        }
      },
    );

    await softDeleteSource(userA.id, src.id, "127.0.0.1");

    expect(
      auditSpy.mock.calls.some(
        ([entry]) => entry.action === "source.removed",
      ),
    ).toBe(true);
  });

  it("Plan 02.1-04: cross-tenant softDeleteSource throws NotFoundError (404, never 403)", async () => {
    const userA = await seedUserDirectly({ email: "ds15a@test.local" });
    const userB = await seedUserDirectly({ email: "ds15b@test.local" });
    const aSrc = await createSource(
      userA.id,
      { kind: "youtube_channel", handleUrl: "https://youtube.com/@xtA" },
      "127.0.0.1",
    );
    await expect(
      softDeleteSource(userB.id, aSrc.id, "127.0.0.1"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("Plan 02.1-04: cross-tenant updateSource + restoreSource throw NotFoundError", async () => {
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
    await expect(
      restoreSource(userB.id, aSrc.id, "127.0.0.1"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("Plan 02.1-04: soft-deleted source can be re-added via the partial unique index (resurrect by re-create)", async () => {
    // SOURCES-02 + Plan 02.1-01 schema decision: the unique index is
    // `WHERE deleted_at IS NULL` so the soft-deleted handle does not block
    // a fresh registration of the same handle_url.
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
