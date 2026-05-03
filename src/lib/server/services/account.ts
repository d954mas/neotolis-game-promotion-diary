// Phase 02.2 D-15 / D-16: account export + soft-delete + restore.
//
// Soft-cascade clones Phase 2 D-23 from services/games.ts:
//   - capture ONE Date once
//   - mark user.deleted_at + cascade to user-owned tables that carry
//     deletedAt (games, game_steam_listings, data_sources, events)
//   - HARD-delete api_keys_steam rows (no deletedAt column on that table —
//     D-14 hard-deletes via removeSteamKey; on account-soft-delete we follow
//     the same semantics so envelope-encrypted secrets do NOT linger past
//     the user's deletion intent. Restore does NOT bring keys back; the
//     user re-enters them. Phase 6 PRIV-04 polish may add soft-delete to
//     api_keys_steam if that proves wrong.)
//   - hard-delete session rows (forces logout on next request)
//   - account (Better Auth OAuth tokens) NOT touched — restore re-uses them
//   - audit_log NOT cascaded (AGENTS.md §4 INSERT-only invariant)
// Restore reverses ONLY children whose deletedAt === user.deletedAt
// (the marker-timestamp design — children deleted earlier stay deleted).
//
// Tenant-scope contract (AGENTS.md §1, §2): every function takes userId first;
// every Drizzle query filters eq(<table>.userId, userId). Cross-tenant
// access is impossible by construction — these endpoints have no :userId
// path parameter; they operate on c.var.userId only. (AGENTS.md §2: 404 not
// 403; here that means a missing user row throws NotFoundError, never
// ForbiddenError.)

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { user, session } from "../db/schema/auth.js";
import { games } from "../db/schema/games.js";
import { gameSteamListings } from "../db/schema/game-steam-listings.js";
import { dataSources } from "../db/schema/data-sources.js";
import { events } from "../db/schema/events.js";
import { apiKeysSteam } from "../db/schema/api-keys-steam.js";
import { auditLog } from "../db/schema/audit-log.js";
import { writeAudit } from "../audit.js";
import { env } from "../config/env.js";
import { NotFoundError, AppError } from "./errors.js";
import {
  toUserDto,
  toGameDto,
  toGameSteamListingDto,
  toDataSourceDto,
  mapEventsToDtos,
  toApiKeySteamDto,
  toAuditEntryDto,
  type UserDto,
  type GameDto,
  type GameSteamListingDto,
  type DataSourceDto,
  type EventDto,
  type ApiKeySteamDto,
  type AuditEntryDto,
} from "../dto.js";

export interface AccountExportEnvelope {
  exported_at: string;
  user: UserDto;
  games: GameDto[];
  game_steam_listings: GameSteamListingDto[];
  data_sources: DataSourceDto[];
  events: EventDto[];
  api_keys_steam: ApiKeySteamDto[];
  audit_log: AuditEntryDto[];
}

export async function softDeleteAccount(userId: string, ipAddress: string): Promise<void> {
  // Captured ONCE so every UPDATE in this tx writes the same Date value
  // (D-23 marker-timestamp design — restore reverses ONLY rows whose
  // deletedAt === this exact value).
  const deletedAt = new Date();
  await db.transaction(async (tx) => {
    const result = await tx
      .update(user)
      .set({ deletedAt })
      .where(and(eq(user.id, userId), isNull(user.deletedAt)))
      .returning({ id: user.id });
    if (result.length === 0) throw new NotFoundError();

    await tx
      .update(games)
      .set({ deletedAt })
      .where(and(eq(games.userId, userId), isNull(games.deletedAt)));
    await tx
      .update(gameSteamListings)
      .set({ deletedAt })
      .where(and(eq(gameSteamListings.userId, userId), isNull(gameSteamListings.deletedAt)));
    await tx
      .update(dataSources)
      .set({ deletedAt })
      .where(and(eq(dataSources.userId, userId), isNull(dataSources.deletedAt)));
    await tx
      .update(events)
      .set({ deletedAt })
      .where(and(eq(events.userId, userId), isNull(events.deletedAt)));

    // api_keys_steam has no deletedAt column (D-14 hard-deletes via
    // removeSteamKey). Hard-delete inside the same tx so envelope-
    // encrypted secrets are gone the moment the user requests deletion;
    // restore won't bring them back — the user re-enters keys post-restore.
    await tx.delete(apiKeysSteam).where(eq(apiKeysSteam.userId, userId));

    // Hard-delete sessions (forces logout on next request).
    // account (OAuth tokens) — leave alone; restore re-uses Better Auth's
    // existing account row so the user can re-link via Google OAuth.
    await tx.delete(session).where(eq(session.userId, userId));
  });

  await writeAudit({
    userId,
    action: "account.deleted",
    ipAddress,
    metadata: { retentionDays: env.RETENTION_DAYS },
  });
}

export async function restoreAccount(userId: string, ipAddress: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [parent] = await tx
      .select({ deletedAt: user.deletedAt })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    if (!parent || parent.deletedAt === null) throw new NotFoundError();
    const markerTs = parent.deletedAt;

    const ageDays = (Date.now() - markerTs.getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays > env.RETENTION_DAYS) {
      throw new AppError(
        "account_purge_window_expired",
        "account_purge_window_expired",
        410,
      );
    }

    await tx.update(user).set({ deletedAt: null }).where(eq(user.id, userId));

    // Children deleted EXACTLY at markerTs are restored. Children
    // deleted BEFORE (manually soft-deleted by the user before account
    // delete) stay deleted — Phase 2 D-23 marker-timestamp semantics.
    // api_keys_steam was hard-deleted in softDeleteAccount and is NOT
    // restorable by this path (Phase 02.2 baseline; user re-enters keys).
    await tx
      .update(games)
      .set({ deletedAt: null })
      .where(and(eq(games.userId, userId), eq(games.deletedAt, markerTs)));
    await tx
      .update(gameSteamListings)
      .set({ deletedAt: null })
      .where(
        and(eq(gameSteamListings.userId, userId), eq(gameSteamListings.deletedAt, markerTs)),
      );
    await tx
      .update(dataSources)
      .set({ deletedAt: null })
      .where(and(eq(dataSources.userId, userId), eq(dataSources.deletedAt, markerTs)));
    await tx
      .update(events)
      .set({ deletedAt: null })
      .where(and(eq(events.userId, userId), eq(events.deletedAt, markerTs)));
  });

  await writeAudit({ userId, action: "account.restored", ipAddress });
}

export async function exportAccountJson(
  userId: string,
  ipAddress: string,
): Promise<AccountExportEnvelope> {
  const [userRow] = await db.select().from(user).where(eq(user.id, userId)).limit(1);
  if (!userRow) throw new NotFoundError();

  const gamesRows = await db.select().from(games).where(eq(games.userId, userId));
  const listingsRows = await db
    .select()
    .from(gameSteamListings)
    .where(eq(gameSteamListings.userId, userId));
  const sourcesRows = await db.select().from(dataSources).where(eq(dataSources.userId, userId));
  const eventsRows = await db.select().from(events).where(eq(events.userId, userId));
  const keysRows = await db.select().from(apiKeysSteam).where(eq(apiKeysSteam.userId, userId));
  const auditRows = await db.select().from(auditLog).where(eq(auditLog.userId, userId));

  // DTO discipline (AGENTS.md §5): every entity through its projection
  // function — runtime barrier that strips ciphertext / PII columns.
  // TypeScript erases at runtime; the projection IS the strip.
  const envelope: AccountExportEnvelope = {
    exported_at: new Date().toISOString(),
    user: toUserDto(userRow),
    games: gamesRows.map(toGameDto),
    game_steam_listings: listingsRows.map(toGameSteamListingDto),
    data_sources: sourcesRows.map(toDataSourceDto),
    events: await mapEventsToDtos(userId, eventsRows),
    api_keys_steam: keysRows.map(toApiKeySteamDto),
    audit_log: auditRows.map(toAuditEntryDto),
  };

  await writeAudit({ userId, action: "account.exported", ipAddress });

  return envelope;
}
