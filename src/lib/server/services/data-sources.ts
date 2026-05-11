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

import { and, eq, isNull, count } from "drizzle-orm";
import { db, type Tx } from "../db/client.js";
import { dataSources } from "../db/schema/data-sources.js";
import type { SourceKind } from "$lib/sources/adapter.js";
import { writeAudit } from "../audit.js";
import { env } from "../config/env.js";
import { AppError, NotFoundError } from "./errors.js";
import { withQuotaGuard } from "./quota.js";
import { isPgUniqueViolation } from "../db/postgres-errors.js";
import { getAdapter } from "$lib/sources/registry.js";
import { youtubeChannels } from "../db/schema/index.js";
import { ensureChannelState, getChannelState } from "./channel-state.js";
import { getBoss } from "../queue-client.js";
import { QUEUES } from "../queues.js";

// Phase 03.0-12 (D-09 / UI-SPEC BackfillPicker) — initial-backfill window
// presets accepted by createSource for kind=youtube_channel + autoImport.
// Plan 09's worker handler reads `job.data.backfillWindow` to size the
// snapshot-seeding window; an undefined value falls back to '30d' which
// matches the BackfillPicker default-selected preset.
export type BackfillWindow = "1d" | "7d" | "30d" | "90d" | "1y" | "everything";

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
  // Phase 03.0-12 (D-09) — only meaningful when kind === 'youtube_channel'
  // AND autoImport === true. Other kind/auto-import combinations silently
  // skip the enqueue path; the field is preserved on the row only via
  // `metadata` if the caller chooses to (this service does not stamp it).
  backfillWindow?: BackfillWindow;
}

export interface UpdateSourcePatch {
  displayName?: string | null;
  autoImport?: boolean;
  isOwnedByMe?: boolean;
  metadata?: Record<string, unknown>;
  /** Phase 03.0.1 — change earliest-event boundary user wants pulled.
   *  Worker uses this as `since` для historical catch-up; UI date picker
   *  + preset radios send absolute Date here. Sentinel 1970-01-01 = "all
   *  history". Server validates: no future dates, не past current frontier
   *  (already covered case yields no-op 202 reason='already_covered'). */
  backfillTargetSince?: Date;
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
 * Channel-level duplicate gate. MUST run inside a withQuotaGuard tx (per-
 * user advisory lock held) — the type narrows to `Tx` so a misuse with
 * the bare `db` handle is impossible at compile time.
 *
 * Why this gate exists: the DB-level partial unique covers
 * (user_id, handle_url) WHERE deleted_at IS NULL. It does NOT cover
 * (user_id, channel_id) — two different handle URLs that resolve to the
 * SAME channel (e.g. /channel/UC… vs /@handle vs short link) would both
 * INSERT cleanly. This helper closes that gap by matching on the
 * resolved channel_id.
 *
 * Policy (three states, fetch-all + classify):
 *   1. Active row for this channel exists       → duplicate_source
 *   2. Any tombstone within RETENTION_DAYS       → duplicate_source_soft_deleted
 *      (error metadata names the MOST RECENT recoverable tombstone — the
 *      row Restore would target on /sources)
 *   3. Only past-retention tombstones (or none) → fall through; caller INSERTs
 *
 * The fetch-all + JS classify shape is deliberate: encoding the policy in
 * SQL ordering is fragile (NULLS LAST/FIRST + LIMIT 1 hides the actual
 * three-state semantics). JS reads top-to-bottom and matches the spec.
 */
export async function assertNoChannelConflict(
  tx: Tx,
  userId: string,
  resolvedChannelId: string,
): Promise<void> {
  const existing = await tx
    .select()
    .from(dataSources)
    .where(and(eq(dataSources.userId, userId), eq(dataSources.channelId, resolvedChannelId)));

  const active = existing.find((r) => r.deletedAt === null);
  const cutoffMs = Date.now() - env.RETENTION_DAYS * 86_400_000;
  const recentTombstone = active
    ? null
    : (existing
        .filter((r) => r.deletedAt !== null && r.deletedAt.getTime() >= cutoffMs)
        .sort((a, b) => b.deletedAt!.getTime() - a.deletedAt!.getTime())[0] ?? null);

  const blockingRow = active ?? recentTombstone;
  if (!blockingRow) return;

  // youtubeChannels is a public-data table (no userId column); the
  // ESLint allowlist for tenant-scope covers this read.
  const cacheRow = await tx
    .select({ channelTitle: youtubeChannels.channelTitle })
    .from(youtubeChannels)
    .where(eq(youtubeChannels.channelId, resolvedChannelId))
    .limit(1);
  const channelTitle = cacheRow[0]?.channelTitle ?? null;
  const niceName = channelTitle ?? blockingRow.displayName ?? blockingRow.handleUrl;
  const isSoftDeleted = blockingRow.deletedAt !== null;
  throw new AppError(
    isSoftDeleted
      ? `You previously deleted "${niceName}". Open /sources, click "Recently deleted", and press Restore — that brings back the source plus all its history.`
      : `You already track "${niceName}"`,
    isSoftDeleted ? "duplicate_source_soft_deleted" : "duplicate_source",
    409,
    {
      handle_url: blockingRow.handleUrl,
      source_id: blockingRow.id,
      channel_id: resolvedChannelId,
      channel_title: channelTitle,
      display_name: blockingRow.displayName,
      soft_deleted: isSoftDeleted,
    },
  );
}

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
/**
 * Phase 03.0.1 (post-review P1/P2 #3) — convert UI preset to absolute date
 * for backfill_target_since column. Mirrors migration 0024's mapping for
 * existing rows so onboarding flow + legacy data agree on semantics.
 *
 * Sentinel '1970-01-01' is the migration-era «everything» mapping; new
 * createSource calls produce it for the 'everything' preset. Defensive
 * route validation (sources.ts) rejects user-pasted dates older than
 * 2005 to prevent the sentinel being indistinguishable from legitimate
 * input.
 */
/**
 * Phase 03.0.3 follow-up — when a user widens `backfillTargetSince` past the
 * channel's recorded `backfill_oldest_at` on a fully-walked channel, enqueue
 * a one-shot force-deep walk for this user. Without this override, the
 * three-branch since-derivation in `handleBackfillChannel` always routes to
 * `branch=exhausted` (D-#29-7 multi-tenant fairness prioritises the channel
 * state's exhausted flag over the per-user target), so historical events
 * below the prior depth would never surface on the next refresh-content
 * click. This function is the single per-user opt-in to override that.
 *
 * Skipped when:
 *   - new target is NOT deeper than the previous target (no widening);
 *   - channel state row missing (no prior walk — three-branch logic
 *     naturally routes to `branch=deep` on its own);
 *   - channel state's `backfillComplete` is false (three-branch logic
 *     already routes to `incremental` or `deep` based on `backfillOldestAt`);
 *   - new target is NOT deeper than `backfill_oldest_at` (we already walked
 *     past the requested depth — nothing new to find).
 *
 * Quota attribution: the trigger user (this PATCH author) pays. Subscribers
 * on the same channel free-ride on fan-out — same as a normal refresh-content
 * click. `singletonKey` is `force-deep-{channelKey}-{userId}` so each user
 * gets one job per channel, but two users widening on the same channel
 * concurrently both get their own walk.
 */
async function maybeEnqueueForceDeepWalk(opts: {
  channelKey: string;
  triggerUserId: string;
  previousTarget: Date | null;
  newTarget: Date;
}): Promise<void> {
  if (opts.previousTarget !== null && opts.newTarget.getTime() >= opts.previousTarget.getTime()) {
    return;
  }
  const state = await getChannelState("youtube_channel", opts.channelKey);
  if (!state) return;
  if (state.backfillComplete !== true) return;
  if (state.backfillOldestAt === null) return;
  if (opts.newTarget.getTime() >= state.backfillOldestAt.getTime()) return;

  const boss = await getBoss();
  await boss.send(
    QUEUES.YOUTUBE_BACKFILL_CHANNEL,
    {
      kind: "youtube_channel" as const,
      channelKey: opts.channelKey,
      triggerUserId: opts.triggerUserId,
      depthBoundIso: opts.newTarget.toISOString(),
      flow: "historical" as const,
      forceDeep: true,
    },
    {
      singletonKey: `force-deep-${opts.channelKey}-${opts.triggerUserId}`,
      priority: 1,
    },
  );
}

function backfillWindowToDate(window: BackfillWindow): Date {
  const now = Date.now();
  switch (window) {
    case "1d":
      return new Date(now - 86_400_000);
    case "7d":
      return new Date(now - 7 * 86_400_000);
    case "30d":
      return new Date(now - 30 * 86_400_000);
    case "90d":
      return new Date(now - 90 * 86_400_000);
    case "1y":
      return new Date(now - 365 * 86_400_000);
    case "everything":
      return new Date("1970-01-01T00:00:00Z");
  }
}

export async function createSource(
  userId: string,
  input: CreateSourceInput,
  ipAddress: string,
  userAgent?: string,
): Promise<DataSourceRow> {
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

  // Phase 03.0.1 Wave 4 (post-review P1) — cheap pre-checks BEFORE
  // canonicalize. Pre-fix the adapter's canonicalizeOnCreate (which can
  // call YouTube's videos.list for /watch?v= URLs) ran first, so a user
  // hitting the source quota cap or pasting an exact-duplicate handle
  // URL still burned operator-pool quota before the eventual rejection.
  //
  // Two cheap SELECTs catch the common cases:
  //   1. Source-count cap: count user's active data_sources rows; if at
  //      or above LIMIT_SOURCES_PER_USER, throw 429 quota_exceeded
  //      (audit emitted by withQuotaGuard's same check below — this is
  //      the optimistic skip).
  //   2. Exact handle_url duplicate: SELECT by user_id + handle_url
  //      catches "user pasted the same URL twice" without canonicalize.
  //      Canonicalize-discovered duplicates ("two different /watch URLs
  //      → same channel") still need the post-canonicalize path.
  //
  // The withQuotaGuard's atomic check is preserved as the race-safe
  // source of truth — these pre-checks just dodge the YouTube API call
  // for already-rejectable inputs.
  const sourceLimit = env.LIMIT_SOURCES_PER_USER;
  const [countRow] = await db
    .select({ c: count() })
    .from(dataSources)
    .where(and(eq(dataSources.userId, userId), isNull(dataSources.deletedAt)));
  const currentCount = Number(countRow?.c ?? 0);
  if (currentCount >= sourceLimit) {
    throw new AppError(
      `data_sources quota exceeded: ${currentCount}/${sourceLimit}`,
      "quota_exceeded",
      429,
      { kind: "data_sources", limit: sourceLimit, current: currentCount },
    );
  }
  const [existingDup] = await db
    .select({ id: dataSources.id })
    .from(dataSources)
    .where(
      and(
        eq(dataSources.userId, userId),
        eq(dataSources.handleUrl, input.handleUrl),
        isNull(dataSources.deletedAt),
      ),
    )
    .limit(1);
  if (existingDup) {
    throw new AppError("You already track this YouTube channel", "duplicate_source", 422, {
      handle_url: input.handleUrl,
    });
  }

  // Phase 3.0 post-build (UAT 2026-05-06): canonicalize the handle_url
  // for kind=youtube_channel sources BEFORE insert. Adapter-driven —
  // the per-source URL canonicalization (parse handle URL, dereference
  // video URL → channelId via videos.list, leave legacy /@handle / /c/
  // URLs to be resolved on first worker backfill). Phase 03.1 Reddit
  // implements canonicalizeOnCreate to resolve /user/ URLs to user_id;
  // this code stays unchanged.
  let canonicalHandleUrl = input.handleUrl;
  let resolvedChannelId = input.channelId ?? null;
  const adapter = getAdapter(input.kind);
  if (adapter.canonicalizeOnCreate !== undefined) {
    const result = await adapter.canonicalizeOnCreate(
      { handleUrl: input.handleUrl, channelId: input.channelId ?? null },
      { userId, ipAddress },
    );
    canonicalHandleUrl = result.canonicalHandleUrl;
    resolvedChannelId = result.resolvedExternalId;
  }

  // Race-free, deadlock-safe quota path. withQuotaGuard takes a per-user
  // advisory lock, runs the quota count + caller-INSERT in one tx, and
  // emits the quota.limit_hit audit AFTER the tx releases its connection.
  //
  // Throw order inside the closure:
  //   1. withQuotaGuard's quota check (current >= limit → quota_exceeded)
  //   2. assertNoChannelConflict (channel-id duplicate, only when channel
  //      is resolved synchronously — see catch block below for the
  //      handle-only path)
  //   3. INSERT (DB-level partial unique catches handle_url duplicates)
  //
  // For a tenant at quota cap with a duplicate request, quota_exceeded
  // fires first; UX-wise the user fixes the cap, then sees the duplicate.
  let row: DataSourceRow | undefined;
  try {
    row = await withQuotaGuard(userId, "data_sources", ipAddress, async (tx) => {
      if (resolvedChannelId) {
        await assertNoChannelConflict(tx, userId, resolvedChannelId);
      }
      const [r] = await tx
        .insert(dataSources)
        .values({
          userId,
          kind: input.kind,
          handleUrl: canonicalHandleUrl,
          channelId: resolvedChannelId,
          displayName: input.displayName ?? null,
          isOwnedByMe: input.isOwnedByMe ?? true,
          autoImport: input.autoImport ?? true,
          metadata: input.metadata ?? {},
          // Phase 03.0.1 (post-review P1/P2 #3) — persist user-selected
          // backfill window as absolute date so catch-up logic
          // (computeSinceForRefresh) has a target boundary to walk back
          // toward. Pre-fix the createSource code threaded backfillWindow
          // ONLY into the initial channel-context-backfill job; the column
          // stayed NULL on new rows. computeSinceForRefresh reads NULL as
          // «no historical pull» so subsequent catch-up tickets only pulled
          // newer-than-frontier — silently truncating user's selected
          // history if initial backfill hit cap (MAX_PAGES=20) before the
          // window boundary.
          backfillTargetSince: backfillWindowToDate(input.backfillWindow ?? "30d"),
        })
        .returning();
      return r;
    });
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      // Two duplicate-detection boundaries:
      //   - assertNoChannelConflict (above, inside tx): catches "same
      //     channel under different handle URLs" when channelId is
      //     resolved synchronously (input.channelId set, OR /channel/UC…
      //     URL parsed locally, OR /watch URL → fetchVideoMetadataByUrl
      //     resolved). Throws AppError(409) with explicit error codes.
      //   - This catch (DB-level partial unique on user_id + handle_url
      //     WHERE deleted_at IS NULL): catches "exact same handle URL
      //     twice" — e.g. /@handle pasted twice. The handle path defers
      //     channel-id resolution to the worker, so the channel-gate
      //     above can't see it; only the handle-level unique catches it.
      // 422 (not 409) by Phase 2.1 precedent for raw-PG-unique paths.
      throw new AppError("You already track this YouTube channel", "duplicate_source", 422, {
        handle_url: canonicalHandleUrl,
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

  // Phase 03.0.1 Wave 2 — ensure channel state row exists for the cron
  // picker. Without this row, the auto-backfill cron's INNER JOIN against
  // data_source_channel_state filters out brand-new sources entirely until
  // the first walk auto-creates the row. Idempotent — concurrent
  // createSource calls for the same (kind, channel_id) collide on the PK
  // and ON CONFLICT DO NOTHING absorbs.
  if (resolvedChannelId !== null) {
    await ensureChannelState(input.kind, resolvedChannelId);
  }

  // Phase 03.0-12 (D-09 / UI-SPEC BackfillPicker) — when the new source is
  // a YouTube channel with auto-import ON, enqueue ONE channel-context
  // backfill job carrying the user's chosen window. The handler
  // ($lib/sources/youtube/server/handlers/channel-context-backfill.ts —
  // pre-Phase 03.0.1 Plan 05 path:
  // worker/handlers/youtube-channel-context-backfill.ts) reads
  // `job.data.backfillWindow` and seeds the snapshot table accordingly.
  //
  // Idempotent via `singletonKey: source-{row.id}` — a duplicate INSERT
  // can't reach this point (PG 23505 maps to duplicate_source above), but
  // a retried request that lands on the same row id (race-window edge)
  // gets coalesced by pg-boss.
  //
  // Fire-and-forget: pg-boss / DB errors are logged at WARN. The created
  // source row is the load-bearing return value; backfill enqueue is a
  // nice-to-have that the user can re-trigger by re-toggling auto-import
  // (PATCH /api/sources/:id) if it ever silently fails.
  // Phase 03.0.1 architecture cleanup — adapter-driven post-create hook.
  // YouTube: enqueue YOUTUBE_CHANNEL_CONTEXT_BACKFILL when autoImport=true.
  // Reddit (Phase 03.1): could enqueue subreddit-rules-cache prereq.
  // Adapters that don't need a hook simply don't implement onSourceCreated.
  if (adapter.onSourceCreated !== undefined) {
    const backfillWindow: BackfillWindow = input.backfillWindow ?? "30d";
    await adapter.onSourceCreated(
      {
        id: row.id,
        userId: row.userId,
        autoImport: row.autoImport,
        handleUrl: row.handleUrl,
        metadata: (row.metadata ?? {}) as Record<string, unknown>,
        kind: row.kind,
        channelId: row.channelId,
        backfillTargetSince: row.backfillTargetSince,
        isOwnedByMe: row.isOwnedByMe,
      },
      { backfillWindow },
    );
  }

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
  if (patch.isOwnedByMe !== undefined) update.isOwnedByMe = patch.isOwnedByMe;
  if (patch.metadata !== undefined) update.metadata = patch.metadata;

  // Phase 03.0.1 — backfill_target_since change.
  // Validate: must be in past. Recompute backfill_complete based on new target:
  //   - if new target ≥ current frontier (or frontier is null) → may need to
  //     pull more historical → reset complete=false.
  //   - if new target's older than current frontier → already covered → keep
  //     complete state as-is.
  if (patch.backfillTargetSince !== undefined) {
    const now = new Date();
    if (patch.backfillTargetSince.getTime() > now.getTime()) {
      throw new AppError(`backfillTargetSince must be in the past`, "date_must_be_past", 422, {
        field: "backfillTargetSince",
      });
    }
    // Phase 03.0.1 (post-review UAT 2026-05-10 — second pass) — narrowing
    // prohibited UNCONDITIONALLY. Pre-fix sentinel («all history» =
    // 1970-01-01) had an «escape hatch» that allowed narrowing from
    // sentinel to a specific date, but user feedback confirmed: «if all
    // then all». target_since semantics: only ever moves earlier (widens)
    // or stays — never later (narrows).
    //
    // Effective rules:
    //   - current === null     → patch must be set; any past date OK.
    //   - current === sentinel → no patch allowed (sentinel is widest;
    //                            widening is impossible, narrowing
    //                            prohibited). 422 'cannot_narrow_window'.
    //   - other current        → patch must be ≤ current.
    const currentMs = existing.backfillTargetSince?.getTime() ?? null;
    if (currentMs !== null && patch.backfillTargetSince.getTime() > currentMs) {
      throw new AppError(
        `backfillTargetSince cannot move forward (would narrow window)`,
        "cannot_narrow_window",
        422,
        {
          field: "backfillTargetSince",
          current: existing.backfillTargetSince?.toISOString(),
          requested: patch.backfillTargetSince.toISOString(),
        },
      );
    }
    update.backfillTargetSince = patch.backfillTargetSince;
    // Phase 03.0.3 — widening backfillTargetSince is handled in TWO
    // places, depending on whether the channel was previously walked
    // to exhaustion:
    //
    //   1. If channel_state.backfill_complete === true AND newTarget
    //      crosses past backfill_oldest_at: immediate force-deep job
    //      enqueued for THIS user via maybeEnqueueForceDeepWalk below
    //      (Phase 03.0.3-02 D-#29-acceptance). The user pays quota for
    //      the deep walk; other subscribers free-ride on fan-out. The
    //      enqueue runs BEFORE the UPDATE for atomicity-of-intent —
    //      see the inline rationale block on the enqueue call itself.
    //
    //   2. Otherwise (channel still has unwalked history below the
    //      previous target — backfill_complete=false): no enqueue
    //      here. The next refresh-content click (or scheduler tick)
    //      lands in the three-branch since-derivation in
    //      backfill-channel.ts and picks the deep branch
    //      automatically because target < deepest_walked. This is the
    //      "lazy" path; the early refactor pass had it as the ONLY
    //      path until D-#29-7 fairness review surfaced that the
    //      exhausted-channel widen needed an explicit override.
    //
    // Pre-Phase-03.0.3 this path also eagerly flipped
    // backfill_complete=false at the CHANNEL level; that reset was
    // redundant (the three-branch since-derivation covers the
    // never-walked case) AND wrong (it re-opened the walk for ALL
    // subscribers on the channel, not just the user who widened —
    // multi-tenant fairness violation per D-#29-7). Both behaviours
    // above are per-user.
  }

  // Phase 03.0.3 follow-up (PR #31 review P2) — atomicity-of-intent.
  // The force-deep enqueue runs BEFORE the UPDATE so a transient
  // boss.send failure aborts the PATCH cleanly (HTTP 500 → user
  // retries → eventual success). Pre-fix order was UPDATE-then-enqueue;
  // on enqueue failure that committed the widen but silently lost the
  // force-deep job → user's intent to walk older history permanently
  // broken with no recovery path (a re-PATCH with the same target is a
  // no-op because previousTarget already equals the widened value).
  //
  // Source identity fields used here (existing.kind, existing.channelId)
  // cannot change via PATCH — updateSource only mutates displayName /
  // autoImport / isOwnedByMe / metadata / backfillTargetSince. Reading
  // them off `existing` instead of the post-UPDATE `row` is safe.
  //
  // Failure modes after reversal:
  //   - boss.send throws → maybeEnqueueForceDeepWalk re-throws → UPDATE
  //     never runs → user sees 500 → retries → consistent recovery.
  //   - UPDATE throws AFTER successful enqueue (extremely rare —
  //     connection drop in the ms window) → job is in queue with the
  //     new target, but data_sources still has the old target. The
  //     subsequent walker run's fan-out (backfill-channel.ts:445)
  //     filters per-subscriber by their STORED target_since → events
  //     past the user's old target are skipped at INSERT. User's
  //     PATCH retry succeeds, and a second deep walk (triggered by the
  //     same maybeEnqueueForceDeepWalk check) fan-outs the older events
  //     correctly. Cost: one wasted deep walk (~50 quota units), no
  //     correctness regression, no silent loss.
  if (
    patch.backfillTargetSince !== undefined &&
    existing.kind === "youtube_channel" &&
    existing.channelId !== null
  ) {
    await maybeEnqueueForceDeepWalk({
      channelKey: existing.channelId,
      triggerUserId: userId,
      previousTarget: existing.backfillTargetSince,
      newTarget: patch.backfillTargetSince,
    });
  }

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
 * Phase 03.0.1 Plan 08 (D-13) — flip the AdapterError surface columns when
 * an adapter throws AdapterError of category operator-issue / permanent /
 * not-found against this source.
 *
 * Pattern 1 (tenant scope): userId is the first non-optional argument and
 * the UPDATE's WHERE clause filters on `eq(dataSources.userId, userId)`.
 * The custom ESLint rule `tenant-scope/no-unfiltered-tenant-query` walks
 * for this filter; cross-tenant misuse is a compile-time block.
 *
 * Idempotency: a second call for the same source overwrites lastErrorAt /
 * lastErrorKind with the newer values. needsReconnect stays true (no path
 * downshifts it inside this helper — operator-side reconnect lands in
 * Phase 6+).
 *
 * Cross-tenant 404 NOT used: this is a system-emitted UPDATE invoked by
 * worker handlers that have already loaded job data; the userId+sourceId
 * pair is trusted (pg-boss persisted it). If the source is missing or
 * cross-tenant the UPDATE simply matches zero rows — no throw, no
 * accidental side effect (write-success is best-effort here; the worker
 * still swallows the AdapterError per its category contract).
 */
export async function markSourceNeedsReconnect(
  userId: string,
  sourceId: string,
  errorKind: "rate-limited" | "not-found" | "permanent" | "operator-issue",
): Promise<void> {
  await db
    .update(dataSources)
    .set({
      needsReconnect: true,
      lastErrorAt: new Date(),
      lastErrorKind: errorKind,
      updatedAt: new Date(),
    })
    .where(and(eq(dataSources.userId, userId), eq(dataSources.id, sourceId)));
}

// ───── Phase 03.0.1 — backfill state machine helpers ─────
// All four mark* helpers accept optional dbCtx (DbOrTx) so worker chunk
// transactions can write state alongside event INSERTs atomically. Default
// to top-level db when omitted (most callers).

/**
 * Mark "we ran a backfill action against this source just now". Updates
 * `last_polled_at` to NOW. Called from EVERY backfill flow (initial,
 * incremental, historical, stats_refresh, auto_passive) on success.
 * UI displays "обновлено N часов назад" from this column.
 */
// Phase 03.0.1 Wave 4 — channel-scoped state replaced these per-source
// helpers. See src/lib/server/services/channel-state.ts:
//   markSourceLastPolledAt        → markChannelLastPolledAt
//   markSourceBackfillFrontier    → markChannelBackfillFrontier
//   markSourceBackfillComplete    → markChannelBackfillComplete
//   setSourceBackfillPageToken    → setChannelBackfillPageToken
// Phase 03.0.3 P1 — `resetSourceBackfillComplete` and the wave-4
// channel-level reset helper were both dropped: the new three-branch
// since-derivation in backfill-channel.ts subsumes the
// "trust-but-verify" reset (D-D1 / D-#29-6 / D-#29-7).
// computeSinceForRefresh removed — channel-scoped worker passes
// depthBoundIso explicitly per trigger context (user click → user's
// target_since; cron auto-backfill → 1970 sentinel; cron incremental
// → now - INCREMENTAL_WINDOW_DAYS).

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
