// Better Auth adapter wrapper that envelope-encrypts OAuth provider tokens at
// rest in the `account` table.
//
// CLAUDE.md "Secrets at rest" constraint: API keys and OAuth refresh tokens
// must be envelope-encrypted with a per-row DEK wrapped by an env-loaded KEK
// (D-09, D-10, D-11). The Better Auth canonical `account` schema stores
// `accessToken` / `refreshToken` / `idToken` as plain `text` columns by
// default — a DB exfil leaks these directly. This wrapper sits between
// Better Auth and the official `drizzleAdapter`, intercepting create/update
// so token columns are written as JSON-encoded `EncryptedSecret` blobs, and
// intercepting findOne/findMany so reads return plaintext to Better Auth's
// internal session/refresh logic.
//
// Approach A from the post-Phase-1 review:
//   * The wrapper preserves the `text` column type (still `account.refreshToken
//     text`) — column shape is unchanged, no migration required. The contents
//     change from `<plaintext>` to `{"v":1,"secretCt":"...","wrappedDek":"...",
//     "secretIv":"...","secretTag":"...","dekIv":"...","dekTag":"...",
//     "kekVersion":1}` (JSON, fields base64-encoded so the column stays text).
//   * Encryption is best-effort: if the Better Auth `account` model is not
//     involved, the wrapper transparently delegates. Existing plaintext rows
//     (e.g. seeded by integration test fixtures) still decrypt to themselves
//     via a graceful-fallback path so a half-migrated database does not break
//     authentication.
//   * `select` projection on findOne/findMany means a column we'd want to
//     decrypt may not be present; we only decrypt the fields that actually
//     came back.
//
// The Pino redaction list (src/lib/server/logger.ts) covers `accessToken` /
// `refreshToken` / `idToken` paths so even a panicked logger.warn(account)
// after a decryption failure does not leak the plaintext token.

import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { encryptSecret, decryptSecret, type EncryptedSecret } from "./crypto/envelope.js";
import { logger } from "./logger.js";

type DrizzleAdapterArgs = Parameters<typeof drizzleAdapter>;
type DrizzleAdapterFactory = ReturnType<typeof drizzleAdapter>;

// Better Auth's account-row token columns (camelCase as the framework sees them
// before its own field-mapping; the underlying Drizzle column name is whatever
// the schema's `.column("...")` says). We list the framework-side names because
// `transformInput` / `transformOutput` and the create/update hooks below all see
// the framework-side keys.
const ENCRYPTED_FIELDS = ["accessToken", "refreshToken", "idToken"] as const;

const ENVELOPE_PREFIX = "ev1:";

interface SerializedEnvelope {
  v: 1;
  secretCt: string;
  secretIv: string;
  secretTag: string;
  wrappedDek: string;
  dekIv: string;
  dekTag: string;
  kekVersion: number;
}

/**
 * Wrap a plaintext token into an encrypted JSON blob that fits in a `text`
 * column. The `ev1:` prefix marks a wrapped value so we never double-encrypt
 * on update (Better Auth re-writes accounts on every refresh) and so a
 * legacy plaintext row falls through to the decrypt-fallback path cleanly.
 */
function encryptField(plaintext: string): string {
  if (plaintext.startsWith(ENVELOPE_PREFIX)) {
    return plaintext;
  }
  const env = encryptSecret(plaintext);
  const blob: SerializedEnvelope = {
    v: 1,
    secretCt: env.secretCt.toString("base64"),
    secretIv: env.secretIv.toString("base64"),
    secretTag: env.secretTag.toString("base64"),
    wrappedDek: env.wrappedDek.toString("base64"),
    dekIv: env.dekIv.toString("base64"),
    dekTag: env.dekTag.toString("base64"),
    kekVersion: env.kekVersion,
  };
  return ENVELOPE_PREFIX + JSON.stringify(blob);
}

/**
 * Decrypt an `ev1:`-prefixed value to plaintext. A value missing the prefix
 * is returned as-is — covers legacy rows and the integration-test fixtures
 * that insert plaintext directly via Drizzle. A prefixed value that fails
 * to decode/decrypt throws, since that means tampering or a KEK rotation
 * defect (PITFALL P2 — fail fast).
 */
function decryptField(stored: string): string {
  if (!stored.startsWith(ENVELOPE_PREFIX)) {
    return stored;
  }
  const json = stored.slice(ENVELOPE_PREFIX.length);
  let blob: SerializedEnvelope;
  try {
    blob = JSON.parse(json) as SerializedEnvelope;
  } catch (err) {
    logger.error({ err }, "envelope: failed to parse stored token JSON");
    throw new Error("envelope: malformed stored token");
  }
  const env: EncryptedSecret = {
    secretCt: Buffer.from(blob.secretCt, "base64"),
    secretIv: Buffer.from(blob.secretIv, "base64"),
    secretTag: Buffer.from(blob.secretTag, "base64"),
    wrappedDek: Buffer.from(blob.wrappedDek, "base64"),
    dekIv: Buffer.from(blob.dekIv, "base64"),
    dekTag: Buffer.from(blob.dekTag, "base64"),
    kekVersion: blob.kekVersion,
  };
  return decryptSecret(env);
}

function encryptAccountRow<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = { ...row };
  for (const field of ENCRYPTED_FIELDS) {
    const v = out[field];
    if (typeof v === "string" && v.length > 0) {
      out[field] = encryptField(v);
    }
  }
  return out as T;
}

function decryptAccountRow<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = { ...row };
  for (const field of ENCRYPTED_FIELDS) {
    const v = out[field];
    if (typeof v === "string" && v.length > 0) {
      try {
        out[field] = decryptField(v);
      } catch (err) {
        // Fail closed: surface the error to Better Auth so the auth flow
        // returns a clean error rather than a corrupted token. The redaction
        // list keeps the stored ciphertext from leaking.
        logger.error({ err, field }, "envelope: account row decrypt failed");
        throw err;
      }
    }
  }
  return out as T;
}

/**
 * Build a Better-Auth-compatible adapter that delegates to `drizzleAdapter`
 * for everything but transparently envelope-encrypts/decrypts the
 * `account.{accessToken,refreshToken,idToken}` columns. The wrapped factory
 * has the same call signature Better Auth expects:
 *   `(options) => DBAdapter`.
 */
export function encryptedDrizzleAdapter(...args: DrizzleAdapterArgs): DrizzleAdapterFactory {
  const inner = drizzleAdapter(...args);
  return ((options) => {
    const adapter = inner(options);
    const isAccount = (model: string): boolean =>
      // Better Auth normalizes the model to the schema key ("account") even when
      // the underlying table is plural — be lenient here to cover plural-table
      // configs in case a future schema config flips that knob.
      model === "account" || model === "accounts";

    return {
      ...adapter,
      create: (async (data: Parameters<typeof adapter.create>[0]) => {
        if (isAccount(data.model)) {
          const enriched = { ...data, data: encryptAccountRow(data.data) };
          const result = (await adapter.create(enriched)) as Record<string, unknown> | null;
          return (result ? decryptAccountRow(result) : result) as ReturnType<
            typeof adapter.create
          > extends Promise<infer R>
            ? R
            : never;
        }
        return adapter.create(data) as ReturnType<typeof adapter.create> extends Promise<infer R>
          ? R
          : never;
      }) as typeof adapter.create,
      update: (async (data: Parameters<typeof adapter.update>[0]) => {
        if (isAccount(data.model)) {
          const enriched = { ...data, update: encryptAccountRow(data.update) };
          const result = (await adapter.update(enriched)) as Record<string, unknown> | null;
          return (result ? decryptAccountRow(result) : result) as ReturnType<
            typeof adapter.update
          > extends Promise<infer R>
            ? R
            : never;
        }
        return adapter.update(data) as ReturnType<typeof adapter.update> extends Promise<infer R>
          ? R
          : never;
      }) as typeof adapter.update,
      updateMany: (async (data: Parameters<typeof adapter.updateMany>[0]) => {
        if (isAccount(data.model)) {
          const enriched = { ...data, update: encryptAccountRow(data.update) };
          return adapter.updateMany(enriched);
        }
        return adapter.updateMany(data);
      }) as typeof adapter.updateMany,
      findOne: (async (data: Parameters<typeof adapter.findOne>[0]) => {
        const result = (await adapter.findOne(data)) as Record<string, unknown> | null;
        if (result && isAccount(data.model)) {
          return decryptAccountRow(result) as ReturnType<typeof adapter.findOne> extends Promise<
            infer R
          >
            ? R
            : never;
        }
        return result as ReturnType<typeof adapter.findOne> extends Promise<infer R> ? R : never;
      }) as typeof adapter.findOne,
      findMany: (async (data: Parameters<typeof adapter.findMany>[0]) => {
        const result = (await adapter.findMany(data)) as Record<string, unknown>[];
        if (isAccount(data.model)) {
          return result.map((r) => decryptAccountRow(r)) as ReturnType<
            typeof adapter.findMany
          > extends Promise<infer R>
            ? R
            : never;
        }
        return result as ReturnType<typeof adapter.findMany> extends Promise<infer R> ? R : never;
      }) as typeof adapter.findMany,
    };
  }) as DrizzleAdapterFactory;
}
