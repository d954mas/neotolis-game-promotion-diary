// Envelope encryption (KEK -> DEK -> plaintext) per CONTEXT D-09/D-10/D-11 and
// RESEARCH.md Pattern 4. AES-256-GCM via Node's built-in `node:crypto` (NEVER a
// third-party crypto library — see CLAUDE.md "What NOT to Use" for crypto-js,
// bcrypt/argon2, and KMS SDKs all explicitly excluded).
//
// Why envelope: a leaked database without the server's env does not disclose
// any secret. The KEK is loaded from env at boot (length-checked at 32 bytes
// in src/lib/server/config/env.ts, then scrubbed from process.env). Each row
// gets its own random 32-byte DEK; the DEK is wrapped (encrypted) by the KEK.
// Both wrap and seal are AES-256-GCM with random 12-byte nonces and 16-byte
// auth tags. Tamper anywhere causes decrypt to throw — no silent corruption.
//
// Rotation (D-10): kek_version is recorded on every row. To rotate, load the
// new KEK as v2, run a background job that calls `rotateDek(row, 2)` on every
// row where kek_version=1 (re-wraps the DEK only — ciphertext is unchanged
// and untouched), then drop KEK_V1 from env. Online and reversible.
//
// AP-6 anti-pattern explicitly avoided: `loadKek` reads from `env.KEK_VERSIONS`
// on every call. The KEK is never cached at module scope — that would defeat
// the env-scrub mitigation in env.ts and prevent rotation hot-swaps.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

const ALG = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEK_BYTES = 32;

export interface EncryptedSecret {
  /** AES-256-GCM ciphertext of the user secret (encrypted with the per-row DEK). */
  secretCt: Buffer;
  /** 12-byte nonce for the secret encryption. */
  secretIv: Buffer;
  /** 16-byte GCM authentication tag for the secret. */
  secretTag: Buffer;
  /** AES-256-GCM ciphertext of the DEK (the DEK is wrapped by the KEK). */
  wrappedDek: Buffer;
  /** 12-byte nonce for the DEK wrap. */
  dekIv: Buffer;
  /** 16-byte GCM authentication tag for the DEK wrap. */
  dekTag: Buffer;
  /** Which KEK version unwrapped this row. Increments on KEK rotation (D-10). */
  kekVersion: number;
}

/**
 * Per-call KEK loader. Reads from `env.KEK_VERSIONS` every time so KEK rotation
 * (Map mutation in env.ts) is picked up immediately and the KEK is never held
 * at module scope (AP-6). Throws a clear `KEK v<n>` error if the requested
 * version is not loaded — proxy for VALIDATION behavior 13 fail-fast (PITFALL
 * P2): if a stored row was encrypted with v2 and the running process only
 * holds v1, decrypt MUST throw before silently corrupting data.
 */
function loadKek(version: number): Buffer {
  const kek = env.KEK_VERSIONS.get(version);
  if (!kek) {
    throw new Error(`KEK v${version} not loaded (env.KEK_VERSIONS missing)`);
  }
  if (kek.length !== KEK_BYTES) {
    throw new Error(`KEK v${version} must be ${KEK_BYTES} bytes (got ${kek.length})`);
  }
  return kek;
}

/**
 * Encrypt a secret with a fresh per-row DEK; wrap the DEK with the current KEK.
 *
 * D-09 random DEK + KEK-wrapped: per-row DEK ensures rotation re-wraps DEK only
 * (D-10) — ciphertext is never re-encrypted, which keeps rotation cheap and
 * online.
 *
 * The DEK Buffer is best-effort wiped (`.fill(0)`) in the `finally` block.
 * V8 strings are immutable so the plaintext argument cannot be wiped here, but
 * keeping the DEK out of long-lived memory closes the most useful attack
 * window for a postmortem heap dump (AP-6).
 */
export function encryptSecret(plaintext: string): EncryptedSecret {
  const dek = randomBytes(KEK_BYTES);
  try {
    // 1. Encrypt the user secret with the DEK.
    const secretIv = randomBytes(NONCE_BYTES);
    const c1 = createCipheriv(ALG, dek, secretIv);
    const secretCt = Buffer.concat([c1.update(plaintext, "utf8"), c1.final()]);
    const secretTag = c1.getAuthTag();
    if (secretTag.length !== TAG_BYTES) {
      throw new Error(`unexpected GCM tag length ${secretTag.length}`);
    }

    // 2. Wrap the DEK with the current KEK.
    const kekVersion = env.KEK_CURRENT_VERSION;
    const kek = loadKek(kekVersion);
    const dekIv = randomBytes(NONCE_BYTES);
    const c2 = createCipheriv(ALG, kek, dekIv);
    const wrappedDek = Buffer.concat([c2.update(dek), c2.final()]);
    const dekTag = c2.getAuthTag();
    if (dekTag.length !== TAG_BYTES) {
      throw new Error(`unexpected GCM tag length ${dekTag.length}`);
    }

    return {
      secretCt,
      secretIv,
      secretTag,
      wrappedDek,
      dekIv,
      dekTag,
      kekVersion,
    };
  } finally {
    // Best-effort wipe; V8 strings are immutable but Buffers can be zeroed (AP-6).
    dek.fill(0);
  }
}

/**
 * Unwrap the DEK with the row's KEK version; decrypt the secret with the DEK.
 *
 * Throws on auth-tag mismatch (tamper detection — VALIDATION behavior 12). The
 * KEK→DEK auth tag is verified BEFORE the DEK→plaintext step, so a tampered
 * `wrappedDek` or `dekTag` fails first; tampered `secretCt` or `secretTag` fails
 * at the second step. Either way the function throws — never returns garbage.
 *
 * Throws on unknown KEK version (PITFALL P2 fail-fast — VALIDATION behavior 13).
 */
export function decryptSecret(s: EncryptedSecret): string {
  const kek = loadKek(s.kekVersion);

  // 1. Unwrap the DEK.
  const d1 = createDecipheriv(ALG, kek, s.dekIv);
  d1.setAuthTag(s.dekTag);
  const dek = Buffer.concat([d1.update(s.wrappedDek), d1.final()]);

  try {
    // 2. Decrypt the secret with the DEK.
    const d2 = createDecipheriv(ALG, dek, s.secretIv);
    d2.setAuthTag(s.secretTag);
    return Buffer.concat([d2.update(s.secretCt), d2.final()]).toString("utf8");
  } finally {
    dek.fill(0);
  }
}

/**
 * Rotate the DEK wrap to a new KEK version. Ciphertext is unchanged (only the
 * wrapped DEK is re-wrapped). This is the cheap online rotation per D-10.
 *
 * Returns a new EncryptedSecret where:
 *  - `secretCt`, `secretIv`, `secretTag` are byte-identical to input
 *  - `wrappedDek`, `dekIv`, `dekTag` are fresh (re-wrapped under newKekVersion)
 *  - `kekVersion` is set to `newKekVersion`
 *
 * Throws on auth-tag mismatch during unwrap (corrupted row) or unknown KEK
 * version (rotation rehearsal will surface the operator drill defect early).
 */
export function rotateDek(s: EncryptedSecret, newKekVersion: number): EncryptedSecret {
  // Step 1: unwrap with old KEK.
  const oldKek = loadKek(s.kekVersion);
  const d = createDecipheriv(ALG, oldKek, s.dekIv);
  d.setAuthTag(s.dekTag);
  const dek = Buffer.concat([d.update(s.wrappedDek), d.final()]);

  try {
    // Step 2: re-wrap with new KEK.
    const newKek = loadKek(newKekVersion);
    const newDekIv = randomBytes(NONCE_BYTES);
    const c = createCipheriv(ALG, newKek, newDekIv);
    const newWrappedDek = Buffer.concat([c.update(dek), c.final()]);
    const newDekTag = c.getAuthTag();

    return {
      secretCt: s.secretCt, // unchanged
      secretIv: s.secretIv, // unchanged
      secretTag: s.secretTag, // unchanged
      wrappedDek: newWrappedDek,
      dekIv: newDekIv,
      dekTag: newDekTag,
      kekVersion: newKekVersion,
    };
  } finally {
    dek.fill(0);
  }
}
