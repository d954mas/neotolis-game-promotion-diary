import { describe, it, expect, vi, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createSteamKey, rotateSteamKey } from "../../src/lib/server/services/api-keys-steam.js";
import { toApiKeySteamDto } from "../../src/lib/server/dto.js";
import { db } from "../../src/lib/server/db/client.js";
import { apiKeysSteam } from "../../src/lib/server/db/schema/api-keys-steam.js";
import { auditLog } from "../../src/lib/server/db/schema/audit-log.js";
import * as SteamApi from "../../src/lib/server/integrations/steam-api.js";
import { seedUserDirectly } from "./helpers.js";

/**
 * Plan 02-05 — KEYS-03..06 envelope-encryption integration tests.
 *
 * The 5 placeholder it.skip stubs from Plan 02-01 are replaced with `it(...)`
 * bodies here. Names match exactly so Wave 0 traceability holds: each
 * placeholder belongs to one implementing plan, and each implementing plan
 * fills in the body with no new it() calls.
 *
 * Mocking strategy: `vi.spyOn(SteamApi, 'validateSteamKey')` against the
 * imported namespace. ESM partial mocks via `vi.mock` are flaky on
 * @sveltejs/kit + Vitest 4; spyOn against `import * as` is the same
 * pattern Phase 1 helpers use and is robust across rebuilds.
 */
describe("api_keys_steam envelope encryption (KEYS-03..06)", () => {
  const validateSpy = vi.spyOn(SteamApi, "validateSteamKey");
  afterEach(() => validateSpy.mockReset());

  it("02-05: KEYS-03 envelope encrypted at rest", async () => {
    validateSpy.mockResolvedValue(true);
    const userA = await seedUserDirectly({ email: "k1@test.local" });
    const PLAIN = "STEAM-TEST-KEY-ABCDEFGH-XYZW";
    const dto = await createSteamKey(
      userA.id,
      { label: "Studio A", plaintext: PLAIN },
      "127.0.0.1",
    );

    const [raw] = await db
      .select()
      .from(apiKeysSteam)
      .where(and(eq(apiKeysSteam.userId, userA.id), eq(apiKeysSteam.id, dto.id)))
      .limit(1);
    expect(raw).toBeDefined();
    expect(raw!.secretCt.length).toBeGreaterThan(0);
    expect(raw!.secretIv.length).toBe(12);
    expect(raw!.secretTag.length).toBe(16);
    expect(raw!.wrappedDek.length).toBeGreaterThan(0);
    expect(raw!.dekIv.length).toBe(12);
    expect(raw!.dekTag.length).toBe(16);
    expect(raw!.kekVersion).toBe(1);

    // Plaintext must not appear in any column when stringified — the
    // envelope-encryption guarantee made tangible. Buffers are base64'd
    // for the comparison so a substring match across encoded bytes
    // would still surface a leak.
    const json = JSON.stringify(raw, (_k, v) => (Buffer.isBuffer(v) ? v.toString("base64") : v));
    expect(json).not.toContain(PLAIN);

    // last4 = the last 4 chars of plaintext (D-34 forensics aid).
    expect(raw!.last4).toBe("XYZW");
  });

  it("02-05: KEYS-04 DTO strips ciphertext", async () => {
    validateSpy.mockResolvedValue(true);
    const userA = await seedUserDirectly({ email: "k2@test.local" });
    await createSteamKey(userA.id, { label: "K", plaintext: "1234567890ABCD" }, "127.0.0.1");

    const [raw] = await db
      .select()
      .from(apiKeysSteam)
      .where(eq(apiKeysSteam.userId, userA.id))
      .limit(1);
    const projected = toApiKeySteamDto(raw!);

    expect(Object.keys(projected).sort()).toEqual(
      ["createdAt", "id", "label", "last4", "rotatedAt", "updatedAt"].sort(),
    );
    expect(projected).not.toHaveProperty("secretCt");
    expect(projected).not.toHaveProperty("secretIv");
    expect(projected).not.toHaveProperty("secretTag");
    expect(projected).not.toHaveProperty("wrappedDek");
    expect(projected).not.toHaveProperty("dekIv");
    expect(projected).not.toHaveProperty("dekTag");
    expect(projected).not.toHaveProperty("kekVersion");
    expect(projected).not.toHaveProperty("userId");
  });

  it("02-05: KEYS-05 rotate overwrites ciphertext + audits", async () => {
    validateSpy.mockResolvedValue(true);
    const userA = await seedUserDirectly({ email: "k3@test.local" });
    const PLAIN1 = "ORIGINAL-KEY-1111";
    const PLAIN2 = "ROTATED-KEY-9999";

    const created = await createSteamKey(userA.id, { label: "K3", plaintext: PLAIN1 }, "127.0.0.1");
    const [pre] = await db
      .select()
      .from(apiKeysSteam)
      .where(eq(apiKeysSteam.id, created.id))
      .limit(1);

    await rotateSteamKey(userA.id, created.id, { plaintext: PLAIN2 }, "127.0.0.1");

    const [post] = await db
      .select()
      .from(apiKeysSteam)
      .where(eq(apiKeysSteam.id, created.id))
      .limit(1);

    // All 7 envelope fields rotated:
    expect(Buffer.compare(pre!.secretCt, post!.secretCt)).not.toBe(0);
    expect(Buffer.compare(pre!.wrappedDek, post!.wrappedDek)).not.toBe(0);
    expect(Buffer.compare(pre!.secretIv, post!.secretIv)).not.toBe(0);
    expect(Buffer.compare(pre!.dekIv, post!.dekIv)).not.toBe(0);
    expect(post!.last4).toBe("9999");
    expect(post!.rotatedAt).not.toBeNull();

    // Both audit verbs landed.
    const audits = await db.select().from(auditLog).where(eq(auditLog.userId, userA.id));
    expect(audits.some((a) => a.action === "key.add")).toBe(true);
    expect(audits.some((a) => a.action === "key.rotate")).toBe(true);
  });

  it("02-05: KEYS-05 rotate fails on invalid key (422)", async () => {
    validateSpy.mockResolvedValueOnce(true); // initial create OK
    const userA = await seedUserDirectly({ email: "k4@test.local" });
    const created = await createSteamKey(
      userA.id,
      { label: "K4", plaintext: "VALID-KEY-1111" },
      "127.0.0.1",
    );
    const [pre] = await db
      .select()
      .from(apiKeysSteam)
      .where(eq(apiKeysSteam.id, created.id))
      .limit(1);

    validateSpy.mockResolvedValueOnce(false); // rotation rejects
    await expect(
      rotateSteamKey(userA.id, created.id, { plaintext: "BAD" }, "127.0.0.1"),
    ).rejects.toMatchObject({ status: 422, code: "validation_failed" });

    // Ciphertext UNCHANGED — no half-write on validation failure.
    const [post] = await db
      .select()
      .from(apiKeysSteam)
      .where(eq(apiKeysSteam.id, created.id))
      .limit(1);
    expect(Buffer.compare(pre!.secretCt, post!.secretCt)).toBe(0);
    expect(Buffer.compare(pre!.wrappedDek, post!.wrappedDek)).toBe(0);
    expect(post!.last4).toBe("1111");
    expect(post!.rotatedAt).toBeNull();

    // No `key.rotate` audit row landed (validation failed before audit).
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, userA.id), eq(auditLog.action, "key.rotate")));
    expect(audits).toHaveLength(0);
  });

  it("02-05: KEYS-06 audit metadata shape {kind, key_id, label, last4}", async () => {
    validateSpy.mockResolvedValue(true);
    const userA = await seedUserDirectly({ email: "k5@test.local" });
    const created = await createSteamKey(
      userA.id,
      { label: "My Test Key", plaintext: "AAAA1234" },
      "127.0.0.1",
    );

    const [a] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, userA.id), eq(auditLog.action, "key.add")))
      .limit(1);
    expect(a).toBeDefined();
    expect(a!.metadata).toMatchObject({
      kind: "steam",
      key_id: created.id,
      label: "My Test Key",
      last4: "1234",
    });
  });
});
