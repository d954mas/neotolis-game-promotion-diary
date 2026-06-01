// DTO discipline — every response that includes user or session data
// MUST go through these projections. The point: adding a column to the
// schema (a new OAuth-token column or the Google subject identifier on
// `account.account_id`) does NOT auto-leak it to the browser, because
// the projection is hand-written and only includes the fields the client
// should know about.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "./db/client.js";
import { eventGames } from "./db/schema/event-games.js";
import { eventKindToSourceKind } from "$lib/sources/event-to-source-kind.js";
import { getAdapter, hasAdapter } from "$lib/sources/registry.js";
import type { SourceKind } from "$lib/sources/adapter.js";
import type { user, session } from "./db/schema/auth.js";
import type {
  games,
  gameSteamListings,
  dataSources,
  apiKeysSteam,
  events,
} from "./db/schema/index.js";
import type { auditLog } from "./db/schema/audit-log.js";
import type { youtubeVideoSnapshots, youtubeChannels } from "./db/schema/index.js";
import type { wishlistSnapshots } from "./db/schema/wishlist-snapshots.js";

type User = typeof user.$inferSelect;
type Session = typeof session.$inferSelect;
type GameRow = typeof games.$inferSelect;
type SteamListingRow = typeof gameSteamListings.$inferSelect;
type DataSourceRow = typeof dataSources.$inferSelect;
type ApiKeySteamRow = typeof apiKeysSteam.$inferSelect;
type EventRow = typeof events.$inferSelect;
type AuditEntryRow = typeof auditLog.$inferSelect;

/**
 * UserDto — what we send to authenticated clients.
 *
 * INTENTIONALLY OMITTED:
 *   - the OAuth provider subject id (lives on `account.account_id` —
 *     that column carries the Google "sub" claim). Leaking it would let
 *     an attacker pivot to other services using the same login.
 *   - all OAuth tokens (live on the `account` table only); never
 *     returned to the browser under any circumstance.
 *   - `emailVerified` — PII reveal that has no client-side use in MVP.
 *   - `createdAt` / `updatedAt` — timing reveal (account-age
 *     fingerprinting).
 */
export interface UserDto {
  id: string;
  email: string;
  name: string;
  image: string | null;
  // deletedAt is exposed for the AccountDeletedBanner conditional
  // mounted in src/routes/+layout.svelte. Cleared (NULL) means the
  // account is active; non-null means the user soft-deleted their
  // account and the banner should render with the restore CTA.
  // exportAccountJson's envelope-strip test in tests/unit/dto.test.ts
  // continues to pass — deletedAt is a timestamp, NOT a ciphertext
  // column.
  deletedAt: Date | string | null;
}

export function toUserDto(u: User): UserDto {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    image: u.image,
    // deletedAt exposed for /settings/account banner; the export
    // envelope test in tests/unit/dto.test.ts asserts ciphertext-only
    // fields are stripped.
    deletedAt: u.deletedAt ?? null,
  };
}

/**
 * SessionDto — what we send when listing the user's active sessions
 * (settings UI).
 *
 * INTENTIONALLY OMITTED:
 *   - `token` — the session-cookie value. Returning it would defeat HTTP-only.
 *   - `userId` — the caller already knows it (their own session); echoing it
 *     adds nothing and risks accidentally surfacing OTHER users' sessions in
 *     a buggy admin context.
 */
export interface SessionDto {
  id: string;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export function toSessionDto(s: Session): SessionDto {
  return {
    id: s.id,
    expiresAt: s.expiresAt,
    ipAddress: s.ipAddress,
    userAgent: s.userAgent,
    createdAt: s.createdAt,
  };
}

// ---- entity DTOs (projection discipline) ----
//
// Each projection lists fields EXPLICITLY (no spread) so adding a column
// to the underlying table does NOT auto-leak it to the browser. The
// `userId` field is intentionally OMITTED from every entity DTO — the
// caller already knows their own id (it's their session). Echoing it
// back adds nothing useful and risks accidentally surfacing OTHER users'
// ids in a buggy admin/aggregate view.

/**
 * GameDto — the per-game DTO returned by /api/games and embedded in many
 * other endpoints. Mirrors the `games` table minus `userId`, PLUS two
 * fields (`releaseDate` + `releaseTba`) derived at LOADER time from the
 * game's non-deleted Steam listings.
 *
 * `releaseDate` / `releaseTba` — the games table NO LONGER carries these
 * columns (migration drizzle/0047 dropped them per denormalization-audit-2.md
 * V-2 / AGENTS.md no-denorm rule). The owning row is `game_steam_listings.release_date`:
 *   - releaseDate: earliest non-null release_date across non-deleted listings,
 *     or null when the game has no listings or every listing has NULL.
 *   - releaseTba: true when any non-deleted listing has release_date IS NULL
 *     (Steam's "Coming soon / TBA" sentinel for unannounced dates).
 * Loaders call `deriveReleaseInfoForGames` to compute the per-game map,
 * then pass each game's `{releaseDate, releaseTba}` into `toGameDto`.
 *
 * `description` (nullable text) is projected — non-secret per-game prose
 * set by the user via the GameEditDialog modal on /games/[gameId].
 */
export interface GameDto {
  id: string;
  title: string;
  coverUrl: string | null;
  releaseDate: string | null;
  releaseTba: boolean;
  tags: string[];
  notes: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** Derived release info — computed via JOIN with game_steam_listings.
 *  Loaders MUST pass this in to `toGameDto`; the games row no longer
 *  carries the underlying columns. */
export interface DerivedReleaseInfo {
  releaseDate: string | null;
  releaseTba: boolean;
}

const EMPTY_RELEASE: DerivedReleaseInfo = { releaseDate: null, releaseTba: false };

export function toGameDto(r: GameRow, derived: DerivedReleaseInfo = EMPTY_RELEASE): GameDto {
  return {
    id: r.id,
    title: r.title,
    coverUrl: r.coverUrl,
    releaseDate: derived.releaseDate,
    releaseTba: derived.releaseTba,
    tags: r.tags,
    notes: r.notes,
    description: r.description ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    deletedAt: r.deletedAt,
  };
}

/**
 * GameSteamListingDto — DTO for `game_steam_listings` rows.
 *
 * INTENTIONALLY OMITTED:
 *   - `userId` — caller knows their own id.
 *   - `rawAppdetails` — the full Steam payload is too large for typical
 *     UI rendering and may carry asset URLs / promo references the UI
 *     doesn't need. Future-proofs against accidental exposure when Steam
 *     adds new fields. Forensics callers read the column directly.
 */
export interface GameSteamListingDto {
  id: string;
  gameId: string;
  appId: number;
  label: string;
  // Steam game name (e.g. "Portal 2"). NULL when the appdetails fetch
  // failed at INSERT time (Steam down) or the row predates the column.
  // UI fallback: `App {appId}`.
  name: string | null;
  coverUrl: string | null;
  releaseDate: string | null;
  comingSoon: string | null;
  steamGenres: string[];
  steamCategories: string[];
  apiKeyId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export function toGameSteamListingDto(r: SteamListingRow): GameSteamListingDto {
  return {
    id: r.id,
    gameId: r.gameId,
    appId: r.appId,
    label: r.label,
    name: r.name,
    coverUrl: r.coverUrl,
    releaseDate: r.releaseDate,
    comingSoon: r.comingSoon,
    steamGenres: r.steamGenres,
    steamCategories: r.steamCategories,
    apiKeyId: r.apiKeyId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    deletedAt: r.deletedAt,
  };
}

/**
 * DataSourceDto — DTO for `data_sources` rows.
 *
 * INTENTIONALLY OMITTED:
 *   - userId — caller knows their own id. The behavioural test in
 *     tests/unit/dto.test.ts asserts the strip happens at runtime even
 *     when an input row literal carries userId.
 *
 * INTENTIONALLY KEPT:
 *   - metadata — non-secret per-kind config (e.g. `uploads_playlist_id`
 *     for youtube_channel; nothing yet for the other kinds since they
 *     are schema-only). NOT a secret-shaped field — secrets live in
 *     `api_keys_*`. If a future kind needs a secret, it goes there, not
 *     into `data_sources.metadata`.
 *   - deletedAt — soft-delete state surfaces to UI for the restore flow.
 */
export interface DataSourceDto {
  id: string;
  kind:
    | "youtube_channel"
    | "reddit_account"
    | "reddit_subreddit"
    | "twitter_account"
    | "telegram_channel"
    | "discord_server";
  handleUrl: string;
  channelId: string | null;
  displayName: string | null;
  // Free-form per-user remark. NULL = unset. UI renders it under the
  // (read-only canonical) title row when truthy, or shows a "+ Add note"
  // ghost button when null.
  note: string | null;
  isOwnedByMe: boolean;
  autoImport: boolean;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  // The YouTube channel's title as returned by channels.list — distinct
  // from `displayName` (which is the user's own label for this tracking
  // record). The /feed loader populates this via JOIN with
  // youtube_channels when channelId is set. Null for non-YouTube kinds,
  // for YouTube sources whose channel hasn't been resolved yet, and for
  // any DTO projected outside the /feed loader (other call sites just
  // pass it through unchanged).
  channelTitle: string | null;
  // AdapterError surface fields. Operational metadata (NOT secrets — no
  // envelope-encryption strip applies). The /sources/[id] page renders a
  // "Reconnect required" banner when needsReconnect=true, and a "Last
  // error: <kind> @ <time>" badge when lastErrorAt is non-null. A future
  // Reconnect CTA will reset needsReconnect once credentials are
  // refreshed.
  needsReconnect: boolean;
  lastErrorAt: Date | null;
  lastErrorKind: string | null;
  // Channel-scoped state. Populated by /sources loaders via JOIN with
  // data_source_channel_state on (kind, channel_id = channel_key). UI
  // components read them as before. The base toDataSourceDto projection
  // sets null/false defaults — loaders override with channel-state
  // values.
  lastPolledAt: Date | null;
  backfillOldestAt: Date | null;
  backfillComplete: boolean;
  backfillTargetSince: Date | null;
  // Populated by the /sources loader from a separate aggregate-events
  // query (see sources/+page.server.ts). Null when no events exist for
  // this source. Not part of toDataSourceDto's base projection — DTO
  // consumers that don't need the range simply leave these undefined.
  firstEventAt?: Date | null;
  lastEventAt?: Date | null;
  eventCount?: number;
}

export function toDataSourceDto(r: DataSourceRow): DataSourceDto {
  return {
    id: r.id,
    kind: r.kind,
    handleUrl: r.handleUrl,
    channelId: r.channelId,
    displayName: r.displayName,
    note: r.note,
    isOwnedByMe: r.isOwnedByMe,
    autoImport: r.autoImport,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    deletedAt: r.deletedAt,
    channelTitle: null,
    needsReconnect: r.needsReconnect,
    lastErrorAt: r.lastErrorAt,
    lastErrorKind: r.lastErrorKind,
    // Channel-scoped fields — null/false defaults; loaders override by
    // JOIN with data_source_channel_state.
    lastPolledAt: null,
    backfillOldestAt: null,
    backfillComplete: false,
    backfillTargetSince: r.backfillTargetSince,
  };
}

/**
 * ApiKeySteamDto — DTO for `api_keys_steam` rows. The cornerstone of
 * ciphertext discipline.
 *
 * INTENTIONALLY OMITTED (every column listed below is a secret-shaped
 * field that MUST NEVER cross the HTTP boundary):
 *   - `userId` — caller knows their own id.
 *   - `secretCt`, `secretIv`, `secretTag` — AES-256-GCM ciphertext +
 *     nonce + tag for the user's plaintext API key. Returning any of
 *     these would leak the wrapping that envelope encryption is built to
 *     hide.
 *   - `wrappedDek`, `dekIv`, `dekTag` — KEK-wrapped DEK + nonce + tag.
 *     Leaking these turns a stolen DB into a stolen-DB-plus-DEK; with
 *     the KEK still in env, the plaintext key would decrypt offline.
 *   - `kekVersion` — operational metadata; the client has no use for the
 *     KEK rotation version and exposing it would aid a planning-phase
 *     attacker.
 *
 * INTENTIONALLY KEPT:
 *   - `last4` — last-4-of-key forensics aid. Already shown in masked
 *     UI; including it here makes the response self-documenting (the
 *     user can match the masked label visually).
 *   - `label` — the user's own free-text name for the key. Not a secret.
 *   - `createdAt` / `updatedAt` / `rotatedAt` — operational timestamps;
 *     `rotatedAt = null` until the user rotates.
 *
 * The projection function is the load-bearing runtime guard (not the
 * TypeScript interface). TypeScript erases types at runtime; only this
 * function decides what crosses the wire. tests/unit/dto.test.ts
 * asserts the strip happens behaviourally — even when a row literal
 * carries ciphertext-shaped Buffers, they MUST NOT appear in the
 * projected output.
 */
export interface ApiKeySteamDto {
  id: string;
  label: string;
  last4: string;
  createdAt: Date;
  updatedAt: Date;
  rotatedAt: Date | null;
}

export function toApiKeySteamDto(r: ApiKeySteamRow): ApiKeySteamDto {
  return {
    id: r.id,
    label: r.label,
    last4: r.last4,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    rotatedAt: r.rotatedAt,
  };
}

// The unified `events` table carries `kind=youtube_video` rows; their
// projection runs through `toEventDto` below.

/**
 * EventDto — DTO for `events` rows. Kind is the closed picklist from
 * the eventKindEnum. `userId` omitted per DTO discipline.
 *
 * Events relate to ZERO-or-MORE games via the `event_games` junction
 * table — `gameIds: string[]` carries the junction-derived list. The
 * `toEventDto` signature takes the loaded gameIds as a second argument
 * so callers explicitly pass the junction row set (the projection
 * function does NOT issue its own DB query — that would tangle DB I/O
 * with pure projection). Callers use the `loadGameIdsForEvent` (single)
 * or `mapEventsToDtos` (batch) helpers below to load the junction
 * efficiently.
 *
 * `metadata` is kept (jsonb) — it carries `inbox.dismissed=true` for
 * dismissed inbox events plus per-platform fields like `author_url`,
 * `author_name`, `thumbnail_url` for YouTube paste rows. There is no
 * secret-shaped data in `events.metadata`; the redact list in logger.ts
 * does not need an addition.
 */
export interface EventDto {
  id: string;
  // M:N junction-derived list. Empty array === inbox; non-empty === at
  // least one attached game. Order is implementation-defined (matches
  // junction-table SELECT order); UI consumers should not assume
  // ordering and should sort if rendering needs determinism.
  gameIds: string[];
  sourceId: string | null;
  kind:
    | "youtube_video"
    | "reddit_post"
    | "conference"
    | "talk"
    | "twitter_post"
    | "telegram_post"
    | "discord_drop"
    | "press"
    | "other"
    | "post";
  authorIsMe: boolean;
  occurredAt: Date;
  title: string;
  url: string | null;
  notes: string | null;
  metadata: unknown;
  externalId: string | null;
  // Polling state lives on `youtube_videos` (per-video, not per-event).
  // The DTO field names stay for UI compatibility (PollingBadge and
  // FeedCard read these names); the loader sources them via JOIN on
  // external_id. Multiple events for the same video share the same
  // values by construction.
  //   - publishedAt — youtube_videos.published_at; NULL while
  //     channel-context-backfill has not yet run for this external_id
  //     (the 'pending' tier window).
  //   - lastPolledAt — youtube_videos.last_polled_at; null on freshly
  //     ingested events whose video has not been polled yet.
  //   - lastPollStatus — youtube_videos.last_poll_status; null on the same.
  publishedAt: Date | null;
  lastPolledAt: Date | null;
  lastPollStatus: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  // Latest stats snapshot for the event, when one is available. The
  // /feed loader populates this for kind=youtube_video events only —
  // joining the most-recent youtube_video_snapshots row by external_id.
  // Other kinds + events without a snapshot row return null. UI
  // consumers (FeedCard) render an inline view-count line when present.
  stats: { viewCount: number; likeCount: number; commentCount: number; polledAt: Date } | null;
  // channelTitle for kind=youtube_video events (auto-imported AND
  // manual paste). Loader joins youtube_videos cache by external_id.
  // FeedCard renders the chip for ALL YouTube events.
  channelTitle?: string | null;
}

/**
 * toEventDto — pure projection — no DB I/O. Callers MUST load the
 * junction rows separately (via loadGameIdsForEvent for single events
 * or mapEventsToDtos for lists) and pass the result.
 *
 * The `userId` field on EventRow is intentionally NOT projected.
 * Defensive copy of `gameIds` so a downstream caller mutating the array
 * doesn't leak back to the source. Tests in tests/unit/dto.test.ts
 * verify the strip happens at runtime even when the input row literal
 * carries userId.
 *
 * Optional `videoData` carries the joined youtube_videos columns;
 * loaders that JOIN pass it, others pass null and the DTO carries null
 * polling fields (UI handles missing data gracefully — PollingBadge
 * falls back to a generic Manual variant).
 */
export function toEventDto(
  r: EventRow,
  gameIds: string[],
  videoData: {
    publishedAt: Date | null;
    lastPolledAt: Date | null;
    lastPollStatus: string | null;
  } | null = null,
): EventDto {
  return {
    id: r.id,
    gameIds: [...gameIds],
    sourceId: r.sourceId,
    kind: r.kind,
    authorIsMe: r.authorIsMe,
    occurredAt: r.occurredAt,
    title: r.title,
    url: r.url,
    notes: r.notes,
    metadata: r.metadata,
    externalId: r.externalId,
    publishedAt: videoData?.publishedAt ?? null,
    lastPolledAt: videoData?.lastPolledAt ?? null,
    lastPollStatus: videoData?.lastPollStatus ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    deletedAt: r.deletedAt,
    stats: null,
  };
}

/**
 * Batched junction loader for list response paths. Two queries per
 * request: one for events (caller's responsibility), one for the
 * junction filtered by user_id + event_ids IN (...). Returns
 * Map<eventId, gameIds[]>. Avoids the N+1 query that would fire if
 * every toEventDto call issued its own junction lookup.
 *
 * Tenant scope: the userId WHERE clause is the literal column the
 * ESLint tenant-scope rule walks for. Cross-tenant eventId values
 * yield zero rows by construction (the userId AND eventId constraint
 * is the load-bearing privacy guard).
 */
export async function loadGameIdsForEvents(
  userId: string,
  eventIds: string[],
): Promise<Map<string, string[]>> {
  if (eventIds.length === 0) return new Map();
  const rows = await db
    .select({ eventId: eventGames.eventId, gameId: eventGames.gameId })
    .from(eventGames)
    .where(and(eq(eventGames.userId, userId), inArray(eventGames.eventId, eventIds)));
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const existing = map.get(r.eventId) ?? [];
    existing.push(r.gameId);
    map.set(r.eventId, existing);
  }
  return map;
}

/**
 * Convenience: load the gameIds for one event. Single-event detail
 * pages use this so they don't need to wrap a single id in an array.
 */
export async function loadGameIdsForEvent(userId: string, eventId: string): Promise<string[]> {
  const map = await loadGameIdsForEvents(userId, [eventId]);
  return map.get(eventId) ?? [];
}

/**
 * Convenience: project a list of EventRows to DTOs with gameIds
 * populated. Two queries: one for the events (caller's), one for the
 * junction (this function).
 */
export async function mapEventsToDtos(userId: string, rows: EventRow[]): Promise<EventDto[]> {
  const [gameIdsMap, videoMap] = await Promise.all([
    loadGameIdsForEvents(
      userId,
      rows.map((e) => e.id),
    ),
    loadVideoDataForEvents(userId, rows),
  ]);
  return rows.map((e) =>
    toEventDto(e, gameIdsMap.get(e.id) ?? [], videoMap.get(e.externalId ?? "") ?? null),
  );
}

/**
 * Batched JOIN loader for the polling state that lives on
 * `youtube_videos`. Returns Map<external_id, videoData> for all
 * youtube_video events in the input list. Skips events with no
 * external_id (manual `other` entries) and non-youtube_video kinds.
 *
 * PUBLIC-DATA TABLE — no userId filter on the youtube_videos query (the
 * table is tenant-agnostic). However, the function takes `userId` and
 * filters input rows to that tenant before extracting external_ids —
 * defense-in-depth: callers are tenant-scoped today, but a future
 * refactor that hands a cross-tenant EventRow[] to this function would
 * silently load video data for rows the caller had no business reading.
 * Symmetrical with loadGameIdsForEvents which already takes userId for
 * the same reason.
 */
export async function loadVideoDataForEvents(
  userId: string,
  rows: EventRow[],
): Promise<
  Map<
    string,
    { publishedAt: Date | null; lastPolledAt: Date | null; lastPollStatus: string | null }
  >
> {
  // Adapter-driven poll-state lookup.
  //
  // Cross-source code never queries youtube_videos / future per-source
  // tables directly. Each adapter exposes fetchPollStateMap which knows
  // its own table + key shape. We:
  //   1. Group input rows by their adapter (via eventKindToSourceKind +
  //      registry), filtering tenant + presence of externalId.
  //   2. Call adapter.fetchPollStateMap(userId, externalIds) per adapter
  //      that has any externalIds in this batch.
  //   3. Merge the per-adapter Maps into one. ExternalId collisions
  //      across adapters are unlikely (YouTube videoId vs other source
  //      post ids have different shapes) but the merge is
  //      last-write-wins and kind-tagged at the call site, so no data
  //      leaks.
  //
  // Adding a new pollable kind = implement fetchPollStateMap on its
  // adapter; this code stays unchanged.
  const merged = new Map<
    string,
    { publishedAt: Date | null; lastPolledAt: Date | null; lastPollStatus: string | null }
  >();
  // Group externalIds by source-kind via eventKindToSourceKind, skipping
  // event kinds that have no source-kind mapping (conference, talk, press,
  // other) — those rows can never carry a poll state.
  const idsByKind = new Map<SourceKind, Set<string>>();
  for (const r of rows) {
    if (r.userId !== userId || r.externalId === null) continue;
    const sourceKind = eventKindToSourceKind(r.kind);
    if (sourceKind === null) continue;
    const set = idsByKind.get(sourceKind) ?? new Set<string>();
    set.add(r.externalId);
    idsByKind.set(sourceKind, set);
  }
  for (const [sourceKind, ids] of idsByKind) {
    if (!hasAdapter(sourceKind)) continue;
    const adapter = getAdapter(sourceKind);
    if (adapter.fetchPollStateMap === undefined) continue;
    const partial = await adapter.fetchPollStateMap(userId, [...ids]);
    for (const [k, v] of partial) merged.set(k, v);
  }
  return merged;
}

/**
 * AuditEntryDto — DTO for `audit_log` rows.
 *
 * INTENTIONALLY OMITTED:
 *   - `userId` — caller knows their own id; the listing is scoped to
 *     the caller by listAuditPage's WHERE clause.
 *
 * INTENTIONALLY KEPT:
 *   - `metadata` — jsonb column. For `key.*` actions, the schema is
 *     `{kind, key_id, label, last4}`; the consumer renders the chip.
 *     The metadata is sanitized at the writer layer (see audit.ts
 *     header) — callers pass only their own tenant's data, so the
 *     projection just forwards the column.
 *   - `ipAddress` — surfaced in the user-visible audit log so the user
 *     can spot a sign-in from an unfamiliar IP.
 */
export interface AuditEntryDto {
  id: string;
  action: string;
  ipAddress: string;
  userAgent: string | null;
  metadata: unknown;
  createdAt: Date;
}

export function toAuditEntryDto(r: AuditEntryRow): AuditEntryDto {
  return {
    id: r.id,
    action: r.action,
    ipAddress: r.ipAddress,
    userAgent: r.userAgent,
    metadata: r.metadata,
    createdAt: r.createdAt,
  };
}

// ---- public-data DTOs ----
//
// These tables carry no `user_id` column and no secret-shaped fields, so
// the projection functions are existence-only: they enumerate every
// column the response wire format includes so a future column addition
// forces a review touchpoint rather than auto-leaking. Mirrors the
// discipline for tenant-owned tables without the strip semantics
// (nothing to strip).

type YoutubeVideoSnapshotRow = typeof youtubeVideoSnapshots.$inferSelect;
type YoutubeChannelMetadataCacheRow = typeof youtubeChannels.$inferSelect;

/**
 * YoutubeVideoSnapshotDto — DTO for `youtube_video_snapshots` rows.
 *
 * Public-data table. Worker writes one row per successful refresh-poll;
 * counters are bigint (mode: 'number' on the Drizzle side, JS number on
 * the wire). Chart endpoints read from this table; no projection-layer
 * strip is required.
 */
export interface YoutubeVideoSnapshotDto {
  id: string;
  videoId: string;
  polledAt: Date;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  createdAt: Date;
}

export function toYoutubeVideoSnapshotDto(r: YoutubeVideoSnapshotRow): YoutubeVideoSnapshotDto {
  return {
    id: r.id,
    videoId: r.videoId,
    polledAt: r.polledAt,
    viewCount: r.viewCount,
    likeCount: r.likeCount,
    commentCount: r.commentCount,
    createdAt: r.createdAt,
  };
}

/**
 * YoutubeChannelMetadataCacheDto — DTO for `youtube_channels` rows.
 *
 * Public-data cache. The channel-context-backfill worker populates this
 * on first paste of a video from an unknown channel; the row is shared
 * across all tenants who paste videos from the same channel.
 */
export interface YoutubeChannelMetadataCacheDto {
  channelId: string;
  uploadsPlaylistId: string;
  channelTitle: string | null;
  lastBackfillAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toYoutubeChannelMetadataCacheDto(
  r: YoutubeChannelMetadataCacheRow,
): YoutubeChannelMetadataCacheDto {
  return {
    channelId: r.channelId,
    uploadsPlaylistId: r.uploadsPlaylistId,
    channelTitle: r.channelTitle,
    lastBackfillAt: r.lastBackfillAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/**
 * WishlistSnapshotDto — DTO for `wishlist_snapshots` rows.
 *
 * Tenant-scoped data (commercially-sensitive per-user wishlist counts).
 * `userId` is OMITTED per DTO discipline — the caller already knows their
 * own id, and echoing it back risks surfacing OTHER users' ids in a buggy
 * aggregate view. There are no ciphertext columns on this table, so the
 * projection is existence-only (enumerate every wire field so a future
 * column addition forces a review touchpoint).
 *
 * NO DENORMALIZATION: the listing/game display name is NOT projected here —
 * it is owned by `game_steam_listings` and read via the `listingId` FK.
 */
export interface WishlistSnapshotDto {
  id: string;
  listingId: string;
  date: string;
  adds: number | null;
  deletes: number | null;
  purchasesAndActivations: number | null;
  gifts: number | null;
  balance: number;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

type WishlistSnapshotRow = typeof wishlistSnapshots.$inferSelect;

export function toWishlistSnapshotDto(r: WishlistSnapshotRow): WishlistSnapshotDto {
  return {
    id: r.id,
    listingId: r.listingId,
    date: r.date,
    adds: r.adds,
    deletes: r.deletes,
    purchasesAndActivations: r.purchasesAndActivations,
    gifts: r.gifts,
    balance: r.balance,
    source: r.source,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ---- admin-quota DTOs ----
//
// Re-export from the service layer so callers can import the projection
// types + functions from a single barrel (`dto.ts`) consistent with the
// rest of the DTO discipline. The shapes themselves live in
// `services/admin-quota-read.ts` because they're computed from the row
// plus the threshold constants exported by
// `$lib/sources/youtube/server/quota.ts`.
//
// No ciphertext-strip semantics: youtube_service_quota_usage carries no
// secret-shaped fields, and the cross-tenant audit projection
// intentionally surfaces only verb + metadata + time (user_id omitted;
// see admin-quota-read.ts).

export {
  type QuotaKeyRow,
  type ServiceAuditEntry,
  toServiceAuditEntry,
} from "./services/admin-quota-read.js";
