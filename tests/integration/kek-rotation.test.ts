// Activated by plan 06-04 (was a Wave-0 skipped scaffold from 06-01).
//
// D-12 KEK rotation rehearsal. Integration-level (real Postgres): seed
// encrypted secret rows under KEK v1, run rotateAllDeks({to:2}), then assert
// every wrapped_dek now carries kek_version=2, the ciphertext (secret_ct) is
// byte-identical (re-wrap touches the DEK only — cheap online rotation, D-10),
// and decryptSecret still returns the original plaintext. This is the
// load-bearing deliverable of DEPLOY-04: a permanent CI gate cannot rot into
// an aspirational runbook transcript (PITFALLS P20).
//
// The test imports rotateAllDeks from the SAME shared core
// (src/lib/server/crypto/rotate-kek-batch.ts) that scripts/rotate-kek.ts
// invokes — proving "test + operator run the same code" (D-13).
//
// v2 KEK supply: env.KEK_VERSIONS is a live Map and envelope.loadKek reads it
// per-call (no module cache), so the test installs a second 32-byte KEK into
// the Map before rotating and removes it afterward — mirroring the operator's
// APP_KEK_V2_BASE64 boot dance without touching process.env.

import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import { apiKeysSteam } from "../../src/lib/server/db/schema/api-keys-steam.js";
import { user } from "../../src/lib/server/db/schema/auth.js";
import { uuidv7 } from "../../src/lib/server/ids.js";
import { env } from "../../src/lib/server/config/env.js";
import {
  encryptSecret,
  decryptSecret,
  type EncryptedSecret,
} from "../../src/lib/server/crypto/envelope.js";
import { rotateAllDeks } from "../../src/lib/server/crypto/rotate-kek-batch.js";

const uniq = (): string => Math.random().toString(36).slice(2, 10);

/** Install a fresh v2 KEK into the live env Map (mirrors APP_KEK_V2_BASE64). */
function installV2Kek(): void {
  env.KEK_VERSIONS.set(2, randomBytes(32));
}

/** Seed one user + N api_keys_steam rows encrypted under KEK v1. */
async function seedSteamKeysUnderV1(
  count: number,
): Promise<{ userId: string; rows: { id: string; plaintext: string }[] }> {
  const userId = uuidv7();
  await db.insert(user).values({
    id: userId,
    email: `kek-rot-${uniq()}@test.local`,
    name: "KEK Rotation Fixture",
    emailVerified: true,
  });

  const rows: { id: string; plaintext: string }[] = [];
  for (let i = 0; i < count; i++) {
    const plaintext = `STEAM-SECRET-${uniq()}-${i}`;
    const enc = encryptSecret(plaintext); // KEK_CURRENT_VERSION = 1 in test env
    expect(enc.kekVersion).toBe(1);
    const id = uuidv7();
    await db.insert(apiKeysSteam).values({
      id,
      userId,
      label: `key-${i}-${uniq()}`,
      last4: plaintext.slice(-4),
      secretCt: enc.secretCt,
      secretIv: enc.secretIv,
      secretTag: enc.secretTag,
      wrappedDek: enc.wrappedDek,
      dekIv: enc.dekIv,
      dekTag: enc.dekTag,
      kekVersion: enc.kekVersion,
    });
    rows.push({ id, plaintext });
  }
  return { userId, rows };
}

async function fetchRow(id: string): Promise<EncryptedSecret & { id: string }> {
  const [row] = await db.select().from(apiKeysSteam).where(eq(apiKeysSteam.id, id));
  return row as unknown as EncryptedSecret & { id: string };
}

describe("KEK rotation rehearsal (D-12)", () => {
  beforeAll(() => {
    // The fixture encrypts under v1; v1 always exists (APP_KEK_BASE64).
    expect(env.KEK_VERSIONS.get(1)).toBeDefined();
  });

  afterEach(() => {
    // Leave the env Map as we found it for any later integration file.
    env.KEK_VERSIONS.delete(2);
  });

  it("seed under v1 → rotateAllDeks({to:2}) → every wrapped_dek now kek_version=2 [06-04]", async () => {
    installV2Kek();
    const { rows } = await seedSteamKeysUnderV1(3);

    const results = await rotateAllDeks({ to: 2 });

    const steam = results.find((r) => r.table === "api_keys_steam");
    expect(steam).toBeDefined();
    expect(steam!.rotated).toBe(3);
    expect(steam!.verified).toBe(3);
    expect(steam!.failures).toEqual([]);

    for (const r of rows) {
      const row = await fetchRow(r.id);
      expect(row.kekVersion).toBe(2);
    }
  });

  it("secret_ct is byte-identical before/after rotation (re-wrap touches DEK only) [06-04]", async () => {
    installV2Kek();
    const { rows } = await seedSteamKeysUnderV1(2);

    const before = new Map<string, Buffer>();
    for (const r of rows) before.set(r.id, Buffer.from((await fetchRow(r.id)).secretCt));

    await rotateAllDeks({ to: 2 });

    for (const r of rows) {
      const row = await fetchRow(r.id);
      // secret_ct unchanged; only the wrapped DEK was re-wrapped under v2.
      expect(Buffer.compare(row.secretCt, before.get(r.id)!)).toBe(0);
    }
  });

  it("decryptSecret returns the original plaintext after rotation [06-04]", async () => {
    installV2Kek();
    const { rows } = await seedSteamKeysUnderV1(3);

    await rotateAllDeks({ to: 2 });

    for (const r of rows) {
      const row = await fetchRow(r.id);
      expect(row.kekVersion).toBe(2);
      expect(decryptSecret(row)).toBe(r.plaintext);
    }
  });

  it("re-running rotateAllDeks on already-v2 rows is a no-op (idempotent, kek_version checkpoint) [06-04]", async () => {
    installV2Kek();
    const { rows } = await seedSteamKeysUnderV1(2);

    await rotateAllDeks({ to: 2 });
    const wrappedAfterFirst = new Map<string, Buffer>();
    for (const r of rows)
      wrappedAfterFirst.set(r.id, Buffer.from((await fetchRow(r.id)).wrappedDek));

    // Second pass: WHERE kek_version < 2 now selects zero rows.
    const second = await rotateAllDeks({ to: 2 });
    const steam = second.find((r) => r.table === "api_keys_steam");
    expect(steam!.rotated).toBe(0);
    expect(steam!.verified).toBe(0);

    // The wrapped DEK was not touched by the second pass.
    for (const r of rows) {
      const row = await fetchRow(r.id);
      expect(Buffer.compare(row.wrappedDek, wrappedAfterFirst.get(r.id)!)).toBe(0);
    }
  });

  it("after dropping v1 from KEK_VERSIONS, rotated rows still decrypt (v1 retireable) [06-04]", async () => {
    installV2Kek();
    const v1 = env.KEK_VERSIONS.get(1)!;
    const { rows } = await seedSteamKeysUnderV1(2);

    await rotateAllDeks({ to: 2 });

    // Retire v1: simulate the operator dropping APP_KEK_BASE64 after zero
    // v1 rows remain. Decryption must still succeed under v2.
    env.KEK_VERSIONS.delete(1);
    try {
      for (const r of rows) {
        const row = await fetchRow(r.id);
        expect(decryptSecret(row)).toBe(r.plaintext);
      }
    } finally {
      // Restore v1 so the rest of the suite (and other files) is unaffected.
      env.KEK_VERSIONS.set(1, v1);
    }
  });

  it("a corrupted wrapped_dek surfaces the failing row id rather than silently skipping [06-04]", async () => {
    installV2Kek();
    const { rows } = await seedSteamKeysUnderV1(2);

    // Tamper one row's wrapped_dek so rotateDek's GCM unwrap throws.
    const victim = rows[0]!;
    const corrupt = Buffer.from((await fetchRow(victim.id)).wrappedDek);
    corrupt[0] = corrupt[0]! ^ 0xff;
    await db
      .update(apiKeysSteam)
      .set({ wrappedDek: corrupt })
      .where(eq(apiKeysSteam.id, victim.id));

    const results = await rotateAllDeks({ to: 2 });
    const steam = results.find((r) => r.table === "api_keys_steam");
    expect(steam).toBeDefined();

    // The corrupted row id is surfaced in failures — NOT silently skipped.
    expect(steam!.failures).toContain(victim.id);
    // The sound row still rotated.
    const sound = await fetchRow(rows[1]!.id);
    expect(sound.kekVersion).toBe(2);
    // The corrupted row was NOT advanced to v2 (left for the operator to fix).
    const tampered = await fetchRow(victim.id);
    expect(tampered.kekVersion).toBe(1);
  });

  it("dry-run verifies every row under the old KEK and issues no UPDATE [06-04]", async () => {
    installV2Kek();
    const { rows } = await seedSteamKeysUnderV1(3);

    const results = await rotateAllDeks({ to: 2, dryRun: true });
    const steam = results.find((r) => r.table === "api_keys_steam");
    expect(steam).toBeDefined();
    expect(steam!.candidates).toBe(3);
    expect(steam!.verified).toBe(3);
    expect(steam!.rotated).toBe(0);
    expect(steam!.failures).toEqual([]);

    // No row advanced — dry-run is read-only.
    for (const r of rows) {
      const row = await fetchRow(r.id);
      expect(row.kekVersion).toBe(1);
    }
  });

  it("fails fast with a clear error when the target KEK version is not loaded [06-04]", async () => {
    // v9 is not in env.KEK_VERSIONS — pre-check should reject before any row work.
    await seedSteamKeysUnderV1(1);
    await expect(rotateAllDeks({ to: 9 })).rejects.toThrow(/KEK v9/);
  });
});
