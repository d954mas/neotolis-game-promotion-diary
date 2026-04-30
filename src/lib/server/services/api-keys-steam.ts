// API Keys (Steam) service — KEYS-03..06, the typed-per-kind credential
// example (D-08). The implementation pattern here is the template Phase 3
// will copy for `api_keys_youtube` and `api_keys_reddit`.
//
// Pattern 1 (tenant scope): EVERY function takes `userId: string` first;
// EVERY Drizzle query .where()-clauses on `eq(apiKeysSteam.userId, userId)`.
// The custom ESLint rule `tenant-scope/no-unfiltered-tenant-query` (Plan
// 02-02) fires on any query that omits this filter — so the absence of
// warnings on this file is a load-bearing assertion, not a stylistic
// preference. Disable comments are NOT allowed in this file.
//
// Envelope encryption (D-12): plaintext NEVER persists. `encryptSecret`
// produces a tuple of {secretCt, secretIv, secretTag, wrappedDek, dekIv,
// dekTag, kekVersion}; we INSERT every field explicitly (NOT a `...enc`
// spread) so the schema-DTO mapping stays reviewable and a future schema
// change can't silently widen what hits the row.
//
// Validation order (D-17): every write path runs `validateSteamKey` BEFORE
// `encryptSecret` BEFORE persist. 4xx Steam → AppError 422 (caller's
// problem); 5xx Steam → AppError 502 (Steam's problem, retry hint per
// RESEARCH.md Pitfall 9). On validation failure NOTHING is written —
// the row is whole or absent.
//
// Audit (D-32, D-34): every successful write produces one audit row
// with shape {kind:'steam', key_id, label, last4}. last4 is NOT a
// secret (already shown in masked UI) and is INTENTIONALLY in the
// audit metadata as the forensics path. Pino redact does not match
// `last4` (verified Phase 1 plan 01-01 redact paths).
//
// `removeSteamKey` AUDITS BEFORE the DELETE (D-32 forensics): even if
// the DELETE fails for any reason, the attempt is logged. The reverse
// order would let a transient DB error swallow the security signal.

import { and, eq, desc } from "drizzle-orm";
import { db } from "../db/client.js";
import { apiKeysSteam } from "../db/schema/api-keys-steam.js";
import { writeAudit } from "../audit.js";
import { encryptSecret, decryptSecret } from "../crypto/envelope.js";
import { validateSteamKey } from "../integrations/steam-api.js";
import { AppError, NotFoundError } from "./errors.js";

export type ApiKeySteamRow = typeof apiKeysSteam.$inferSelect;

export interface CreateSteamKeyInput {
  label: string;
  plaintext: string;
}

export interface RotateSteamKeyInput {
  plaintext: string;
}

const LABEL_MIN = 1;
const LABEL_MAX = 100;
const PLAINTEXT_MIN = 1;

function validateLabel(label: string): void {
  if (label.length < LABEL_MIN || label.length > LABEL_MAX) {
    throw new AppError(
      `label must be between ${LABEL_MIN} and ${LABEL_MAX} characters`,
      "validation_failed",
      422,
    );
  }
}

function validatePlaintext(plaintext: string): void {
  if (plaintext.length < PLAINTEXT_MIN) {
    throw new AppError("steam api key must not be empty", "validation_failed", 422);
  }
}

/**
 * Validate the plaintext against Steam's IWishlistService probe and translate
 * the (boolean | error) outcome into AppError semantics. Returns void on
 * success; throws AppError(422 / 502) on the two well-defined failure modes.
 *
 * Network errors / aborts escape — the route layer surfaces those as 500.
 * That's deliberate: a DNS failure on the validator is operator-scope, not
 * user-scope; logging at the route layer produces the right alert path.
 */
async function probeSteamKey(plaintext: string): Promise<void> {
  let ok: boolean;
  try {
    ok = await validateSteamKey(plaintext);
  } catch (err) {
    if ((err as Error).message === "steam_api_5xx") {
      throw new AppError("steam api unavailable", "steam_api_unavailable", 502);
    }
    throw err;
  }
  if (!ok) {
    throw new AppError("invalid steam key", "validation_failed", 422);
  }
}

/**
 * Create a Steam API key record for `userId`. The full pipeline:
 *
 *   1. Validate input shape (label length 1..100, plaintext length >= 1)
 *      → AppError(422) BEFORE any external call.
 *   2. Label-collision pre-check (D-13/B-3 multi-key UI) — UNIQUE(user_id,
 *      label) at the DB layer is the load-bearing guarantee; this check
 *      exists so the user gets a clean Paraglide-keyed error code instead
 *      of a Postgres 23505 unique-violation. Plan 02-08 maps
 *      `steam_key_label_exists` → 422.
 *   3. Probe Steam (`validateSteamKey`) → AppError(422) on 4xx,
 *      AppError(502) on 5xx.
 *   4. `encryptSecret(plaintext)` → fresh DEK + ciphertext tuple.
 *   5. Compute `last4` from plaintext (NOT a secret per D-34; forensic).
 *   6. INSERT, RETURNING only the DTO-shaped columns (NOT the ciphertext —
 *      keeps the in-process variable used for the response narrow so a
 *      future logger.info({ row }) can't accidentally serialize ciphertext).
 *   7. `writeAudit({action:'key.add', metadata:{kind, key_id, label, last4}})`.
 *
 * The order is load-bearing: validation before encryption (no wasted DEK on
 * a typo), encryption before persist (no plaintext on disk ever), persist
 * before audit (the audit row references the persisted id).
 */
export async function createSteamKey(
  userId: string,
  input: CreateSteamKeyInput,
  ipAddress: string,
): Promise<ApiKeySteamRow> {
  validateLabel(input.label);
  validatePlaintext(input.plaintext);

  // Label-collision pre-check (D-13/B-3 multi-key UI). The DB-level
  // UNIQUE(user_id, label) is the load-bearing safety net; this check
  // exists so the route layer can map `steam_key_label_exists` → 422
  // with a Paraglide-keyed error message instead of leaking 23505.
  const existing = await db
    .select({ id: apiKeysSteam.id })
    .from(apiKeysSteam)
    .where(and(eq(apiKeysSteam.userId, userId), eq(apiKeysSteam.label, input.label)))
    .limit(1);
  if (existing.length > 0) {
    throw new AppError("a key with this label already exists", "steam_key_label_exists", 422);
  }

  await probeSteamKey(input.plaintext);

  const enc = encryptSecret(input.plaintext);
  const last4 = input.plaintext.slice(-4);

  // Explicit field listing (NOT `...enc`) — keeps the schema-DTO mapping
  // reviewable. RETURNING projects ONLY the DTO-shaped fields so a future
  // `logger.info({ row })` cannot serialize ciphertext.
  const [row] = await db
    .insert(apiKeysSteam)
    .values({
      userId,
      label: input.label,
      last4,
      secretCt: enc.secretCt,
      secretIv: enc.secretIv,
      secretTag: enc.secretTag,
      wrappedDek: enc.wrappedDek,
      dekIv: enc.dekIv,
      dekTag: enc.dekTag,
      kekVersion: enc.kekVersion,
    })
    .returning();
  if (!row) {
    throw new Error("createSteamKey: INSERT returned no row");
  }

  await writeAudit({
    userId,
    action: "key.add",
    ipAddress,
    metadata: { kind: "steam", key_id: row.id, label: row.label, last4: row.last4 },
  });

  return row;
}

/**
 * List the caller's Steam API keys. Returned rows include ciphertext
 * columns (the row-level type is `ApiKeySteamRow`); callers MUST run each
 * row through `toApiKeySteamDto` before serializing to a response. The
 * service does not project here because rotate / decrypt paths need the
 * full row.
 */
export async function listSteamKeys(userId: string): Promise<ApiKeySteamRow[]> {
  return db
    .select()
    .from(apiKeysSteam)
    .where(eq(apiKeysSteam.userId, userId))
    .orderBy(desc(apiKeysSteam.createdAt));
}

/**
 * Read one Steam key row scoped to userId. Throws NotFoundError on miss
 * or cross-tenant attempt (PRIV-01: 404, never 403).
 *
 * Used internally by rotate / remove / decrypt-for-operator. NOT directly
 * mapped to a route — Plan 02-08's GET /api/keys/steam/:id (if any)
 * would call `listSteamKeys` and project, OR call this and project; in
 * either case the route runs `toApiKeySteamDto` before responding.
 */
export async function getSteamKeyById(userId: string, keyId: string): Promise<ApiKeySteamRow> {
  const rows = await db
    .select()
    .from(apiKeysSteam)
    .where(and(eq(apiKeysSteam.userId, userId), eq(apiKeysSteam.id, keyId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError();
  return row;
}

/**
 * Rotate a Steam API key. The user supplies a NEW plaintext (this is NOT
 * a KEK-only rotation — `rotateDek` in envelope.ts is for the operator-
 * driven KEK rotation drill; this function is the user-driven "I lost my
 * key" path).
 *
 * Validation order matches `createSteamKey`: probe Steam → encrypt →
 * UPDATE all 7 ciphertext columns + bump `rotatedAt` and `updatedAt`.
 * On validation failure NOTHING is written — the previous ciphertext
 * stands intact.
 *
 * Throws NotFoundError if the key does not belong to userId (cross-tenant
 * 404 per PRIV-01).
 */
export async function rotateSteamKey(
  userId: string,
  keyId: string,
  input: RotateSteamKeyInput,
  ipAddress: string,
): Promise<ApiKeySteamRow> {
  validatePlaintext(input.plaintext);

  // Confirm the key exists + belongs to userId BEFORE the (paid) Steam
  // probe call. Cross-tenant rotation attempts must not even hit Steam.
  await getSteamKeyById(userId, keyId);

  await probeSteamKey(input.plaintext);

  const enc = encryptSecret(input.plaintext);
  const last4 = input.plaintext.slice(-4);
  const now = new Date();

  const [row] = await db
    .update(apiKeysSteam)
    .set({
      secretCt: enc.secretCt,
      secretIv: enc.secretIv,
      secretTag: enc.secretTag,
      wrappedDek: enc.wrappedDek,
      dekIv: enc.dekIv,
      dekTag: enc.dekTag,
      kekVersion: enc.kekVersion,
      last4,
      rotatedAt: now,
      updatedAt: now,
    })
    .where(and(eq(apiKeysSteam.userId, userId), eq(apiKeysSteam.id, keyId)))
    .returning();
  // Defensive: getSteamKeyById above already guaranteed a row exists, but
  // a concurrent removeSteamKey could race in between. Treat as 404.
  if (!row) throw new NotFoundError();

  await writeAudit({
    userId,
    action: "key.rotate",
    ipAddress,
    metadata: { kind: "steam", key_id: row.id, label: row.label, last4: row.last4 },
  });

  return row;
}

/**
 * Hard-delete a Steam API key. Order:
 *
 *   1. SELECT label + last4 scoped to userId+id; throw NotFoundError on miss.
 *   2. `writeAudit({action:'key.remove', ...})` — BEFORE the DELETE so even
 *      if the DELETE fails the attempt is logged.
 *   3. DELETE scoped to userId+id.
 *
 * The Postgres FK `game_steam_listings.api_key_id ON DELETE SET NULL` (Plan
 * 02-03 schema) clears the FK on any listings that referenced this key —
 * that's a deliberate D-13 choice: listings persist; only the key linkage
 * is severed. The user can attach a new key later.
 */
export async function removeSteamKey(
  userId: string,
  keyId: string,
  ipAddress: string,
): Promise<void> {
  const rows = await db
    .select({ id: apiKeysSteam.id, label: apiKeysSteam.label, last4: apiKeysSteam.last4 })
    .from(apiKeysSteam)
    .where(and(eq(apiKeysSteam.userId, userId), eq(apiKeysSteam.id, keyId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError();

  // Audit BEFORE delete (D-32 forensics).
  await writeAudit({
    userId,
    action: "key.remove",
    ipAddress,
    metadata: { kind: "steam", key_id: row.id, label: row.label, last4: row.last4 },
  });

  await db
    .delete(apiKeysSteam)
    .where(and(eq(apiKeysSteam.userId, userId), eq(apiKeysSteam.id, keyId)));
}

/**
 * Decrypt a Steam API key plaintext. INTERNAL USE ONLY.
 *
 * **DO NOT EXPOSE THIS VIA AN HTTP ROUTE.** Phase 2 only uses this in tests
 * (envelope-encryption round-trip proof). Phase 3's wishlist polling worker
 * is the only future production caller — and even there the decrypted
 * plaintext lives only inside the worker's per-job try block, never logged,
 * never returned to a client.
 *
 * The function-scope `plaintext` cannot be wiped (V8 strings are immutable)
 * but Pino's redact paths (D-24) catch any accidental log emission by
 * field-shape match. Callers should hand the plaintext to the Steam API
 * call and let it go out of scope immediately.
 */
export async function decryptSteamKeyForOperator(userId: string, keyId: string): Promise<string> {
  const row = await getSteamKeyById(userId, keyId);
  return decryptSecret({
    secretCt: row.secretCt,
    secretIv: row.secretIv,
    secretTag: row.secretTag,
    wrappedDek: row.wrappedDek,
    dekIv: row.dekIv,
    dekTag: row.dekTag,
    kekVersion: row.kekVersion,
  });
}
