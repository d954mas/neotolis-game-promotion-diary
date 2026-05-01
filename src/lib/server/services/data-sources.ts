// Data Sources service — Phase 2.1 SOURCES-01 / SOURCES-02.
//
// Replaces the Phase 2 `youtube-channels` service. One unified per-tenant
// registry keyed on (kind, handle_url). YouTube is functional in 2.1; Reddit
// / Twitter / Telegram / Discord rows are rejected with a clean
// AppError('kind_not_yet_functional', 422) at the service boundary so the
// schema-only kinds never hit the DB until their Phase 3+ adapters land
// (RESEARCH §5.4 — a passive 200 would silently persist orphan rows).
//
// Pattern 1 (tenant scope): EVERY function takes `userId: string` first;
// EVERY Drizzle query .where()-clauses on `eq(dataSources.userId, userId)`.
// The custom ESLint rule `tenant-scope/no-unfiltered-tenant-query` (Plan
// 02.1-01 updated TENANT_TABLES to include dataSources) fires on any query
// that omits this filter — so the absence of warnings on this file is a
// load-bearing assertion, not a stylistic preference. Disable comments are
// NOT allowed in this file.
//
// Cross-tenant access throws `NotFoundError` (404, never 403) per AGENTS.md
// Privacy invariant 2 + PRIV-01. The 403 error class is reserved for
// Phase 6+ admin endpoints and MUST NEVER fire on tenant-owned resources.
//
// Soft-delete + RETENTION_DAYS (SOURCES-02): `softDeleteSource` sets
// `deleted_at`; `restoreSource` clears it only when within
// env.RETENTION_DAYS of the deletion. The schema's partial unique index
// over `(user_id, handle_url) WHERE deleted_at IS NULL` (Plan 02.1-01)
// means a soft-deleted handle does NOT block re-adding the same handle
// later — the user can resurrect a removed source by re-adding it.
//
// Audit (D-32 forensics ordering — Phase 2 STATE.md "removeSteamKey audits
// BEFORE the DELETE — even if DELETE fails the security signal is captured"):
// `softDeleteSource` writes `source.removed` BEFORE the soft-delete UPDATE
// so the security signal lands even if the UPDATE later fails.

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { dataSources } from "../db/schema/data-sources.js";
import type { SourceKind } from "../integrations/data-source-adapter.js";
import { writeAudit } from "../audit.js";
import { env } from "../config/env.js";
import { AppError, NotFoundError } from "./errors.js";
import { assertQuota } from "./quota.js";
import { isPgUniqueViolation } from "../db/postgres-errors.js";

export type DataSourceRow = typeof dataSources.$inferSelect;

// Functional kinds in Phase 2.1 (RESEARCH §5.4). The other four schema-only
// kinds are rejected at `createSource` with a clean 422.
const FUNCTIONAL_KINDS: ReadonlySet<SourceKind> = new Set<SourceKind>(["youtube_channel"]);

// Phase mapping for the 'kind_not_yet_functional' error metadata. The /sources
// page renders the user-facing string from the response code; this map gives
// the Phase 3+ kicker without forcing the UI to hard-code the timeline.
const KIND_PHASE: Readonly<Record<SourceKind, string>> = {
  youtube_channel: "Phase 2.1",
  reddit_account: "Phase 3",
  twitter_account: "v2 (paid Twitter API gated)",
  telegram_channel: "Phase 5+",
  discord_server: "Phase 5+",
};

// Defense-in-depth mirror of the schema's source_kind pgEnum. The pgEnum
// (Plan 02.1-01) is the load-bearing constraint at INSERT time; this set is
// the service-level check that surfaces a clean validation_failed AppError
// instead of a Postgres "invalid input value for enum" 5xx.
const VALID_SOURCE_KINDS: readonly SourceKind[] = [
  "youtube_channel",
  "reddit_account",
  "twitter_account",
  "telegram_channel",
  "discord_server",
] as const;

export interface CreateSourceInput {
  kind: SourceKind;
  handleUrl: string;
  displayName?: string | null;
  channelId?: string | null;
  isOwnedByMe?: boolean;
  autoImport?: boolean;
  metadata?: Record<string, unknown>;
}

export interface UpdateSourcePatch {
  displayName?: string | null;
  autoImport?: boolean;
  metadata?: Record<string, unknown>;
}

const HANDLE_URL_MIN = 1;
const HANDLE_URL_MAX = 2048;

function validateKind(kind: string): asserts kind is SourceKind {
  if (!(VALID_SOURCE_KINDS as readonly string[]).includes(kind)) {
    throw new AppError(`unknown source kind '${kind}'`, "validation_failed", 422, {
      field: "kind",
    });
  }
}

function validateHandleUrl(handleUrl: string): void {
  if (typeof handleUrl !== "string" || handleUrl.trim().length < HANDLE_URL_MIN) {
    throw new AppError("handle_url must be a non-empty string", "validation_failed", 422, {
      field: "handle_url",
    });
  }
  if (handleUrl.length > HANDLE_URL_MAX) {
    throw new AppError(
      `handle_url must be at most ${HANDLE_URL_MAX} characters`,
      "validation_failed",
      422,
      { field: "handle_url" },
    );
  }
}

// Plan 02.1-29 — `isPgUniqueViolation` extracted to
// src/lib/server/db/postgres-errors.ts (shared with
// services/game-steam-listings.ts addSteamListing's 23505 translation).
// The cause-chain walker shape and the depth=5 bound stay the same — the
// only change is the import surface.

/**
 * Create a data_source for `userId`. Rejects schema-only kinds with
 * AppError(422 'kind_not_yet_functional') BEFORE any DB call (RESEARCH §5.4
 * — passive 200 would silently persist orphan rows that Phase 3+ workers
 * couldn't poll).
 *
 * Translates Postgres 23505 unique_violation on the partial unique index
 * `data_sources_user_handle_active_unq` into a clean
 * AppError(422 'duplicate_source'). This is the **EXCEPTION** to the
 * no-try/catch-around-INSERT rule (D-19): we are NOT cleaning up a
 * half-write — we are mapping a known DB constraint to a clean HTTP code.
 * The Phase 2 `items-youtube.createTrackedYoutubeVideo` precedent applies
 * (Phase 2 STATE.md decision).
 *
 * Audit: writes `source.added` with metadata `{source_id, kind, handle_url}`.
 */
export async function createSource(
  userId: string,
  input: CreateSourceInput,
  ipAddress: string,
  userAgent?: string,
): Promise<DataSourceRow> {
  await assertQuota(userId, "data_sources", ipAddress);
  validateKind(input.kind);
  validateHandleUrl(input.handleUrl);
  if (!FUNCTIONAL_KINDS.has(input.kind)) {
    throw new AppError(
      `kind '${input.kind}' is not yet functional (schema-only in Phase 2.1)`,
      "kind_not_yet_functional",
      422,
      { kind: input.kind, available_phase: KIND_PHASE[input.kind] },
    );
  }

  let row: DataSourceRow | undefined;
  try {
    [row] = await db
      .insert(dataSources)
      .values({
        userId,
        kind: input.kind,
        handleUrl: input.handleUrl,
        channelId: input.channelId ?? null,
        displayName: input.displayName ?? null,
        isOwnedByMe: input.isOwnedByMe ?? true,
        autoImport: input.autoImport ?? true,
        metadata: input.metadata ?? {},
      })
      .returning();
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      throw new AppError("data source already registered", "duplicate_source", 422, {
        handle_url: input.handleUrl,
      });
    }
    throw err;
  }
  if (!row) {
    throw new Error("createSource: INSERT returned no row");
  }

  await writeAudit({
    userId,
    action: "source.added",
    ipAddress,
    userAgent,
    metadata: { source_id: row.id, kind: row.kind, handle_url: row.handleUrl },
  });

  return row;
}

/**
 * List the caller's data_sources. By default omits soft-deleted rows. Pass
 * `includeDeleted: true` for the trash view (Wave 2 routes wire this).
 */
export async function listSources(
  userId: string,
  options: { includeDeleted?: boolean } = {},
): Promise<DataSourceRow[]> {
  if (options.includeDeleted) {
    return db
      .select()
      .from(dataSources)
      .where(eq(dataSources.userId, userId))
      .orderBy(dataSources.createdAt);
  }
  return db
    .select()
    .from(dataSources)
    .where(and(eq(dataSources.userId, userId), isNull(dataSources.deletedAt)))
    .orderBy(dataSources.createdAt);
}

/**
 * Read one data_source by id, scoped to `userId`. Throws `NotFoundError` on
 * miss OR cross-tenant access (PRIV-01: 404, never 403). Soft-deleted rows
 * are returned — Wave 2's restore endpoint needs them.
 *
 * The double-condition (`userId AND id`) is the Pattern 1 invariant — the
 * only way a row comes back is when both the resource id and the caller id
 * agree, so cross-tenant fetches are indistinguishable from "this id never
 * existed" by construction.
 */
export async function getSourceById(userId: string, sourceId: string): Promise<DataSourceRow> {
  const [row] = await db
    .select()
    .from(dataSources)
    .where(and(eq(dataSources.userId, userId), eq(dataSources.id, sourceId)))
    .limit(1);
  if (!row) throw new NotFoundError();
  return row;
}

/**
 * Update a data_source's mutable fields (displayName / autoImport / metadata).
 *
 * Cross-tenant 404 via the `eq(userId)` filter on the UPDATE itself; soft-
 * deleted rows are excluded by `isNull(deletedAt)` (you cannot edit a
 * tombstone — restore it first).
 *
 * Audit: writes `source.toggled_auto_import` with `{source_id, kind, from, to}`
 * ONLY when `autoImport` actually changes value. Other field edits are not
 * audited — the audit_action enum is a closed picklist (D-32).
 */
export async function updateSource(
  userId: string,
  sourceId: string,
  patch: UpdateSourcePatch,
  ipAddress: string,
  userAgent?: string,
): Promise<DataSourceRow> {
  const existing = await getSourceById(userId, sourceId);
  if (existing.deletedAt !== null) throw new NotFoundError();

  const update: Partial<typeof dataSources.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (patch.displayName !== undefined) update.displayName = patch.displayName;
  if (patch.autoImport !== undefined) update.autoImport = patch.autoImport;
  if (patch.metadata !== undefined) update.metadata = patch.metadata;

  const [row] = await db
    .update(dataSources)
    .set(update)
    .where(
      and(
        eq(dataSources.userId, userId),
        eq(dataSources.id, sourceId),
        isNull(dataSources.deletedAt),
      ),
    )
    .returning();
  if (!row) throw new NotFoundError();

  if (patch.autoImport !== undefined && patch.autoImport !== existing.autoImport) {
    await writeAudit({
      userId,
      action: "source.toggled_auto_import",
      ipAddress,
      userAgent,
      metadata: {
        source_id: row.id,
        kind: row.kind,
        from: existing.autoImport,
        to: patch.autoImport,
      },
    });
  }

  return row;
}

/**
 * Soft-delete a data_source.
 *
 * D-32 FORENSICS ORDER: the `source.removed` audit row is written BEFORE the
 * UPDATE so the security signal is captured even if the UPDATE later fails.
 * Mirrors the Phase 2 `removeSteamKey` precedent (Phase 2 STATE.md decision).
 *
 * Idempotency: a second call on an already-deleted row throws NotFoundError
 * (the row has already been removed from the user's perspective). Mirrors
 * the Phase 2 D-23 idempotency pattern.
 *
 * Returns the soft-deleted row so Wave 2 routes can render the retention
 * badge from the response without a follow-up GET.
 */
export async function softDeleteSource(
  userId: string,
  sourceId: string,
  ipAddress: string,
  userAgent?: string,
): Promise<DataSourceRow> {
  const existing = await getSourceById(userId, sourceId);
  if (existing.deletedAt !== null) throw new NotFoundError();

  // Audit BEFORE the soft-delete update (D-32 forensics).
  await writeAudit({
    userId,
    action: "source.removed",
    ipAddress,
    userAgent,
    metadata: {
      source_id: existing.id,
      kind: existing.kind,
      handle_url: existing.handleUrl,
    },
  });

  const now = new Date();
  const [row] = await db
    .update(dataSources)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(dataSources.userId, userId),
        eq(dataSources.id, sourceId),
        isNull(dataSources.deletedAt),
      ),
    )
    .returning();
  if (!row) throw new NotFoundError();
  return row;
}

/**
 * Restore a soft-deleted data_source.
 *
 * Refuses restore when the soft-delete is older than `env.RETENTION_DAYS`
 * (Phase 2 retention window inherited; SOURCES-02 reuses it). Throws
 * AppError(422 'retention_expired') with metadata so the route layer can
 * surface a Paraglide-keyed message.
 *
 * NotFoundError on miss / cross-tenant / not-deleted. The latter case is
 * intentional: restore on an already-active row is a programming error
 * the UI should not surface; treat as "nothing to restore".
 */
export async function restoreSource(
  userId: string,
  sourceId: string,
  _ipAddress: string,
  _userAgent?: string,
): Promise<DataSourceRow> {
  const [existing] = await db
    .select()
    .from(dataSources)
    .where(and(eq(dataSources.userId, userId), eq(dataSources.id, sourceId)))
    .limit(1);
  if (!existing) throw new NotFoundError();
  if (existing.deletedAt === null) throw new NotFoundError();

  const cutoff = new Date(Date.now() - env.RETENTION_DAYS * 86_400_000);
  if (existing.deletedAt < cutoff) {
    throw new AppError("retention window expired", "retention_expired", 422, {
      source_id: existing.id,
      deleted_at: existing.deletedAt.toISOString(),
      retention_days: env.RETENTION_DAYS,
    });
  }

  const [row] = await db
    .update(dataSources)
    .set({ deletedAt: null, updatedAt: new Date() })
    .where(and(eq(dataSources.userId, userId), eq(dataSources.id, sourceId)))
    .returning();
  if (!row) throw new NotFoundError();
  // No audit verb for restore — RESEARCH §4.4 reserves the audit_action enum
  // for security-relevant actions; restoration of a user's own resource is a
  // low-risk operator action. If a verb is needed in the future, file a
  // Phase 6 housekeeping ticket; do NOT add ad-hoc here.
  return row;
}

/**
 * INGEST-03 author_is_me inheritance — given an oEmbed `author_url` parsed
 * from a pasted YouTube video URL, return the matching active YouTube
 * channel data_source for `userId` (if any).
 *
 * Match is on `handleUrl` directly: the YouTube channel data_source's
 * `handleUrl` IS the canonical author URL (e.g.
 * `https://www.youtube.com/@RickAstleyYT`). No separate `author_url`
 * column exists in 2.1; if Plan 02.1-05's ingest path discovers oEmbed
 * returns a different canonical form, that plan adapts (Rule 1 fix in
 * Plan 02.1-05's scope).
 *
 * Returns the row when a match exists (Plan 02.1-05's events service sets
 * `author_is_me=true` on the event being inserted), or null otherwise
 * (`author_is_me=false`, blogger / community coverage).
 */
export async function findSourceByAuthorUrl(
  userId: string,
  authorUrl: string,
): Promise<DataSourceRow | null> {
  const [row] = await db
    .select()
    .from(dataSources)
    .where(
      and(
        eq(dataSources.userId, userId),
        eq(dataSources.kind, "youtube_channel"),
        eq(dataSources.isOwnedByMe, true),
        eq(dataSources.handleUrl, authorUrl),
        isNull(dataSources.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}
