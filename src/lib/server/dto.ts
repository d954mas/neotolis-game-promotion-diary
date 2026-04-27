// PITFALL P3 (DTO discipline) — every response that includes user or session
// data MUST go through these projections. The point: adding a column to the
// schema (a new OAuth-token column or the Google subject identifier on
// `account.account_id`) does NOT auto-leak it to the browser, because the
// projection is hand-written and only includes the fields the client should
// know about.
//
// Phase 1 establishes this pattern; every later phase inherits it.

import type { user, session } from "./db/schema/auth.js";
import type { games, gameSteamListings, youtubeChannels } from "./db/schema/index.js";

type User = typeof user.$inferSelect;
type Session = typeof session.$inferSelect;
type GameRow = typeof games.$inferSelect;
type SteamListingRow = typeof gameSteamListings.$inferSelect;
type YoutubeChannelRow = typeof youtubeChannels.$inferSelect;

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
 * YoutubeChannelDto — DTO for `youtube_channels` rows. The table has no
 * `deletedAt` (channels live at user level, never soft-deleted per D-24);
 * this DTO mirrors that.
 */
export interface YoutubeChannelDto {
  id: string;
  handleUrl: string;
  channelId: string | null;
  displayName: string | null;
  isOwn: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function toYoutubeChannelDto(r: YoutubeChannelRow): YoutubeChannelDto {
  return {
    id: r.id,
    handleUrl: r.handleUrl,
    channelId: r.channelId,
    displayName: r.displayName,
    isOwn: r.isOwn,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
