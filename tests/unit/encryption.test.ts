import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";

// Plan 01-04 RED — failing tests for envelope encryption per VALIDATION behaviors
// 10/11/12/13 (round-trip, tamper detection, missing KEK fail-fast, rotation D-10).
//
// Tests own labels RT1, RT2, RT3, T1, T2, T3, T4, B1, R1, R2, U1 (11 active cases)
// covering AUTH-03 must_haves:
//   - encryptSecret/decryptSecret round-trip (RT1, RT2, RT3, U1)
//   - tamper detection via AES-256-GCM auth tag (T1, T2, T3, T4)
//   - missing KEK version causes a clear error (B1 — proxy for PITFALL P2 fail-fast)
//   - rotateDek re-wraps DEK only and ciphertext is byte-identical (R1, R2 — D-10)
//
// Test isolation strategy: env.ts is the SOLE reader of process.env (D-24, AP-6).
// We seed required process.env vars BEFORE the dynamic import so zod parse succeeds.
// We then mutate `env.KEK_VERSIONS` directly inside `beforeEach` for two-version
// rotation scenarios — the env module exposes the Map by reference.

// Seed the bare minimum env the schema requires. APP_KEK_BASE64 is decoded then
// scrubbed by env.ts; KEK_CURRENT_VERSION defaults to 1.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.BETTER_AUTH_SECRET ??= "x".repeat(40);
process.env.GOOGLE_CLIENT_ID ??= "test-google-id";
process.env.GOOGLE_CLIENT_SECRET ??= "test-google-secret";
// 32 raw bytes, base64 encoded (44 chars including padding).
process.env.APP_KEK_BASE64 ??= randomBytes(32).toString("base64");

const { env } = await import("../../src/lib/server/config/env.js");
const { encryptSecret, decryptSecret, rotateDek } =
  await import("../../src/lib/server/crypto/envelope.js");

describe("envelope encryption — round-trip (VALIDATION behaviors 10/11)", () => {
  it("RT1: decryptSecret(encryptSecret(plaintext)) returns identical plaintext", () => {
    const plaintext = "hello world";
    const enc = encryptSecret(plaintext);
    expect(decryptSecret(enc)).toBe(plaintext);
  });

  it("RT2: round trip empty string", () => {
    expect(decryptSecret(encryptSecret(""))).toBe("");
  });

  it("RT3: round trip 4KB unicode (mixed CJK / Cyrillic / emoji)", () => {
    // Validate UTF-8 round-trip across multi-byte code points.
    const big = "日本語κίνησηабв🎮🎲".repeat(200).slice(0, 4096);
    expect(decryptSecret(encryptSecret(big))).toBe(big);
  });

  it("U1: same plaintext encrypted twice produces different ciphertexts (random nonce + DEK)", () => {
    const e1 = encryptSecret("repeat me");
    const e2 = encryptSecret("repeat me");
    // Different DEKs and different nonces => different ciphertexts and wrapped DEKs.
    expect(Buffer.compare(e1.secretCt, e2.secretCt)).not.toBe(0);
    expect(Buffer.compare(e1.wrappedDek, e2.wrappedDek)).not.toBe(0);
    expect(Buffer.compare(e1.secretIv, e2.secretIv)).not.toBe(0);
    expect(Buffer.compare(e1.dekIv, e2.dekIv)).not.toBe(0);
  });
});

describe("envelope encryption — tamper detection (VALIDATION behavior 12)", () => {
  it("T1: tampered secretCt throws on decrypt (AES-256-GCM auth-tag mismatch)", () => {
    const enc = encryptSecret("confidential");
    const tampered = { ...enc, secretCt: Buffer.from(enc.secretCt) };
    tampered.secretCt[0] ^= 0xff;
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("T2: tampered secretTag throws on decrypt (auth-tag mismatch)", () => {
    const enc = encryptSecret("confidential");
    const tampered = { ...enc, secretTag: Buffer.from(enc.secretTag) };
    tampered.secretTag[0] ^= 0x01;
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("T3: tampered wrappedDek throws on decrypt (KEK->DEK auth-tag fails first)", () => {
    const enc = encryptSecret("confidential");
    const tampered = { ...enc, wrappedDek: Buffer.from(enc.wrappedDek) };
    tampered.wrappedDek[0] ^= 0x01;
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("T4: tampered dekTag throws on decrypt", () => {
    const enc = encryptSecret("confidential");
    const tampered = { ...enc, dekTag: Buffer.from(enc.dekTag) };
    tampered.dekTag[0] ^= 0x01;
    expect(() => decryptSecret(tampered)).toThrow();
  });
});

describe("envelope encryption — KEK availability (VALIDATION behavior 13)", () => {
  it("B1: missing KEK version causes clear error mentioning the version number", () => {
    // Encrypt with the current KEK (v1), then forge a row claiming kek v99
    // which is not loaded into env.KEK_VERSIONS. decryptSecret must fail
    // loudly — proxy for "missing/short KEK at boot" (PITFALL P2 fail-fast):
    // env.ts itself enforces 32-byte length on boot, but if a stored row was
    // encrypted with v2 and the running process only holds v1, we MUST throw
    // before silently corrupting data.
    const enc = encryptSecret("hello");
    const fakeRow = { ...enc, kekVersion: 99 };
    expect(() => decryptSecret(fakeRow)).toThrow(/KEK v99/);
  });
});

describe("envelope encryption — rotation (D-10, AUTH-03)", () => {
  beforeEach(() => {
    // Seed a v2 KEK so rotation tests can exercise the two-version path.
    // env.KEK_VERSIONS is exported by reference (Map) so this mutation is seen
    // by the envelope module's per-call loadKek lookup (AP-6: no module-level
    // cached KEK in either env.ts or envelope.ts).
    env.KEK_VERSIONS.set(2, randomBytes(32));
  });

  it("R1: rotateDek re-wraps DEK only — ciphertext is byte-identical", () => {
    const enc = encryptSecret("confidential payload");
    const rotated = rotateDek(enc, 2);
    // Ciphertext + its IV + its tag are the unchanged secret payload.
    expect(Buffer.compare(rotated.secretCt, enc.secretCt)).toBe(0);
    expect(Buffer.compare(rotated.secretIv, enc.secretIv)).toBe(0);
    expect(Buffer.compare(rotated.secretTag, enc.secretTag)).toBe(0);
    // DEK wrap fields are all replaced — different KEK + new random nonce.
    expect(Buffer.compare(rotated.wrappedDek, enc.wrappedDek)).not.toBe(0);
    expect(Buffer.compare(rotated.dekIv, enc.dekIv)).not.toBe(0);
    expect(Buffer.compare(rotated.dekTag, enc.dekTag)).not.toBe(0);
    // kek_version column updates to the new version (D-10).
    expect(rotated.kekVersion).toBe(2);
  });

  it("R2: rotated row decrypts to original plaintext", () => {
    const original = "top secret";
    const enc = encryptSecret(original);
    const rotated = rotateDek(enc, 2);
    expect(decryptSecret(rotated)).toBe(original);
  });
});
