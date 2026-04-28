// PITFALL P3 (DTO discipline) — every response that includes user or session
// data MUST go through these projections. The point: adding a column to the
// schema (a new OAuth-token column or the Google subject identifier on
// `account.account_id`) does NOT auto-leak it to the browser, because the
// projection is hand-written and only includes the fields the client should
// know about.
//
// Phase 1 establishes this pattern; every later phase inherits it.

import type { user, session } from "./db/schema/auth.js";
import type {
  games,
  gameSteamListings,
  dataSources,
  apiKeysSteam,
  events,
} from "./db/schema/index.js";
import type { auditLog } from "./db/schema/audit-log.js";

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
 * INTENTIONALLY OMITTED (per PITFALL P3):
 *   - the OAuth provider subject id (lives on `account.account_id` — that
 *     column carries the Google "sub" claim). Leaking it would let an
 *     attacker pivot to other services using the same login.
 *   - all OAuth tokens (lives on the `account` table only); never returned
 *     to the browser under any circumstance.
 *   - `emailVerified` — PII reveal that has no client-side use in MVP.
 *   - `createdAt` / `updatedAt` — timing reveal (account-age fingerprinting).
 */
export interface UserDto {
  id: string;
  email: string;
  name: string;
  image: string | null;
}

export function toUserDto(u: User): UserDto {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    image: u.image,
  };
}

/**
 * SessionDto — what we send when listing the user's active sessions
 * (Phase 2 / settings UI). Phase 1 establishes the shape; the read endpoint
 * lands later.
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

// ---- Phase 2 entity DTOs (D-39 projection discipline) ----
//
// Each projection lists fields EXPLICITLY (no spread) so adding a column to
// the underlying table does NOT auto-leak it to the browser. The `userId`
// field is intentionally OMITTED from every Phase 2 DTO — the caller already
// knows their own id (it's their session). Echoing it back adds nothing
// useful and risks accidentally surfacing OTHER users' ids in a buggy
// admin/aggregate view.

/**
 * GameDto — the per-game DTO returned by /api/games and embedded in many
 * other endpoints. Mirrors the `games` table minus `userId` (P3 discipline).
 */
export interface GameDto {
  id: string;
  title: string;
  coverUrl: string | null;
  releaseDate: string | null;
  releaseTba: boolean;
  tags: string[];
  notes: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export function toGameDto(r: GameRow): GameDto {
  return {
    id: r.id,
    title: r.title,
    coverUrl: r.coverUrl,
    releaseDate: r.releaseDate,
    releaseTba: r.releaseTba,
    tags: r.tags,
    notes: r.notes,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    deletedAt: r.deletedAt,
  };
}

/**
 * GameSteamListingDto — DTO for `game_steam_listings` rows.
 *
 * INTENTIONALLY OMITTED:
 *   - `userId` — P3 discipline (caller knows their own id).
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
 * DataSourceDto — DTO for `data_sources` rows (Phase 2.1 SOURCES-01).
 *
 * INTENTIONALLY OMITTED:
 *   - userId — P3 discipline (caller knows their own id). The behavioural
 *     test in tests/unit/dto.test.ts asserts the strip happens at runtime
 *     even when an input row literal carries userId.
 *
 * INTENTIONALLY KEPT:
 *   - metadata — non-secret per-kind config (e.g. `uploads_playlist_id` for
 *     youtube_channel; nothing in 2.1 for the other kinds since they are
 *     schema-only — RESEARCH §5/§10). NOT a secret-shaped field — secrets
 *     live in `api_keys_*`. If a future kind needs a secret, it goes there,
 *     not into `data_sources.metadata`.
 *   - deletedAt — soft-delete state surfaces to UI for the restore flow.
 *
 * Replaces the Phase 2 `toYoutubeChannelDto` projection.
 */
export interface DataSourceDto {
  id: string;
  kind:
    | "youtube_channel"
    | "reddit_account"
    | "twitter_account"
    | "telegram_channel"
    | "discord_server";
  handleUrl: string;
  channelId: string | null;
  displayName: string | null;
  isOwnedByMe: boolean;
  autoImport: boolean;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export function toDataSourceDto(r: DataSourceRow): DataSourceDto {
  return {
    id: r.id,
    kind: r.kind,
    handleUrl: r.handleUrl,
    channelId: r.channelId,
    displayName: r.displayName,
    isOwnedByMe: r.isOwnedByMe,
    autoImport: r.autoImport,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    deletedAt: r.deletedAt,
  };
}

/**
 * ApiKeySteamDto — DTO for `api_keys_steam` rows. The cornerstone of D-39 /
 * PITFALL P3 ciphertext discipline.
 *
 * INTENTIONALLY OMITTED (every column listed below is a secret-shaped field
 * that MUST NEVER cross the HTTP boundary):
 *   - `userId` — P3 discipline (caller knows their own id).
 *   - `secretCt`, `secretIv`, `secretTag` — AES-256-GCM ciphertext + nonce +
 *     tag for the user's plaintext API key. Returning any of these would
 *     leak the wrapping that envelope encryption is built to hide.
 *   - `wrappedDek`, `dekIv`, `dekTag` — KEK-wrapped DEK + nonce + tag.
 *     Leaking these turns a stolen DB into a stolen-DB-plus-DEK; with the
 *     KEK still in env, the plaintext key would decrypt offline.
 *   - `kekVersion` — operational metadata; the client has no use for the
 *     KEK rotation version and exposing it would aid a planning-phase
 *     attacker.
 *
 * INTENTIONALLY KEPT:
 *   - `last4` — D-34 last-4-of-key forensics aid. Already shown in masked UI;
 *     including it here makes the response self-documenting (the user can
 *     match the masked label visually).
 *   - `label` — the user's own free-text name for the key. Not a secret.
 *   - `createdAt` / `updatedAt` / `rotatedAt` — operational timestamps;
 *     `rotatedAt = null` until the user rotates.
 *
 * The projection function is the load-bearing runtime guard (not the
 * TypeScript interface). TypeScript erases types at runtime; only this
 * function decides what crosses the wire. tests/unit/dto.test.ts asserts
 * the strip happens behaviourally — even when a row literal carries
 * ciphertext-shaped Buffers, they MUST NOT appear in the projected
 * output (P3 / D-39).
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

// `toYoutubeVideoDto` was removed in Phase 2.1 Plan 02.1-04 alongside the
// retirement of the `tracked_youtube_videos` schema (Plan 02.1-01). The
// unified `events` table now carries `kind=youtube_video` rows; their
// projection runs through `toEventDto` (Plan 02.1-05 owns the extension).

/**
 * EventDto — DTO for `events` rows. Kind is the closed picklist from the
 * eventKindEnum. `userId` omitted per P3 discipline.
 *
 * Phase 2.1 Plan 02.1-04 (this plan) lands the minimum-compile shape: kind
 * union widened to include the new `youtube_video` / `reddit_post` values
 * and `gameId` widened to `string | null` (inbox semantics — events.game_id
 * is now nullable per Plan 02.1-01). Plan 02.1-05 extends this DTO to add
 * `authorIsMe`, `sourceId`, `metadata`, `lastPolledAt`, `lastPollStatus`
 * per RESEARCH §10.2 — that work belongs to the events service rewrite that
 * actually consumes the new fields.
 */
export interface EventDto {
  id: string;
  gameId: string | null;
  kind:
    | "youtube_video"
    | "reddit_post"
    | "conference"
    | "talk"
    | "twitter_post"
    | "telegram_post"
    | "discord_drop"
    | "press"
    | "other";
  occurredAt: Date;
  title: string;
  url: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export function toEventDto(r: EventRow): EventDto {
  return {
    id: r.id,
    gameId: r.gameId,
    kind: r.kind,
    occurredAt: r.occurredAt,
    title: r.title,
    url: r.url,
    notes: r.notes,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    deletedAt: r.deletedAt,
  };
}

/**
 * AuditEntryDto — DTO for `audit_log` rows (PRIV-02 — Plan 02-07).
 *
 * INTENTIONALLY OMITTED:
 *   - `userId` — P3 discipline (caller knows their own id; the listing is
 *     scoped to the caller by listAuditPage's WHERE clause).
 *
 * INTENTIONALLY KEPT:
 *   - `metadata` — jsonb column. For `key.*` actions D-34 specifies
 *     `{kind, key_id, label, last4}`; the consumer renders the chip. The
 *     metadata is sanitized at the writer layer (see audit.ts file header) —
 *     callers pass only their own tenant's data, so the projection just
 *     forwards the column.
 *   - `ipAddress` — surfaced in the user-visible audit log so the user can
 *     spot a sign-in from an unfamiliar IP.
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
