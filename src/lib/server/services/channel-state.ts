// channel-state service — channel-scoped polling state.
//
// One row per (kind, channelKey) shared across all subscribers.
//
// CROSS-TENANT BY DESIGN. Channels are global; per-user state lives in
// data_sources (target_since, auto_import, etc.). Tenant scoping happens
// at the events INSERT fan-out layer, not here. This file does NOT take a
// userId parameter — the channel state is owned by the platform, not by
// any single tenant. The tenant-scope ESLint rule does NOT fire on
// data_source_channel_state (not in the rule's TENANT_TABLES list);
// queries deliberately omit a userId filter.
//
// Race-safety: markChannelBackfillFrontier WHERE-guards the deeper-only
// move; other helpers are last-write-wins (cosmetic — last_polled_at,
// backfill_complete are monotonic-ish state).

import { and, eq, sql } from "drizzle-orm";
import { db, type DbOrTx } from "../db/client.js";
import { dataSourceChannelState } from "../db/schema/data-source-channel-state.js";
import type { SourceKind } from "$lib/sources/adapter.js";

export type ChannelStateRow = typeof dataSourceChannelState.$inferSelect;

/**
 * Lookup channel state by (kind, channelKey). Returns undefined if no row
 * exists (channel never polled by anyone). Caller decides whether to
 * upsert-on-first-walk or treat as cold-start.
 */
export async function getChannelState(
  kind: SourceKind,
  channelKey: string,
  dbCtx: DbOrTx = db,
): Promise<ChannelStateRow | undefined> {
  const rows = await dbCtx
    .select()
    .from(dataSourceChannelState)
    .where(
      and(eq(dataSourceChannelState.kind, kind), eq(dataSourceChannelState.channelKey, channelKey)),
    )
    .limit(1);
  return rows[0];
}

/**
 * Insert-or-touch the channel state row. Used at first walk to materialize
 * a row when none exists. Idempotent — concurrent inserts collide on PK
 * and fall through to UPDATE with no field changes.
 */
export async function ensureChannelState(
  kind: SourceKind,
  channelKey: string,
  dbCtx: DbOrTx = db,
): Promise<void> {
  await dbCtx
    .insert(dataSourceChannelState)
    .values({ kind, channelKey })
    .onConflictDoNothing({
      target: [dataSourceChannelState.kind, dataSourceChannelState.channelKey],
    });
}

/**
 * Stamp `last_polled_at = NOW()` on this channel. Called from EVERY
 * successful walk regardless of trigger (cron incremental, cron
 * auto-backfill, user click). UI displays this value verbatim across
 * all subscribers.
 *
 * Auto-creates the row if it doesn't exist (cold-start path).
 */
export async function markChannelLastPolledAt(
  kind: SourceKind,
  channelKey: string,
  dbCtx: DbOrTx = db,
): Promise<void> {
  await dbCtx
    .insert(dataSourceChannelState)
    .values({ kind, channelKey, lastPolledAt: new Date() })
    .onConflictDoUpdate({
      target: [dataSourceChannelState.kind, dataSourceChannelState.channelKey],
      set: { lastPolledAt: new Date(), updatedAt: new Date() },
    });
}

/**
 * Move the auto-import frontier (deepest-walked event timestamp). The
 * UPDATE is WHERE-guarded so concurrent walks (cron + manual click) cannot
 * race-rollback the frontier. Only deeper writes win. Auto-creates row.
 */
export async function markChannelBackfillFrontier(
  kind: SourceKind,
  channelKey: string,
  oldestAt: Date,
  dbCtx: DbOrTx = db,
): Promise<void> {
  await dbCtx
    .insert(dataSourceChannelState)
    .values({ kind, channelKey, backfillOldestAt: oldestAt })
    .onConflictDoUpdate({
      target: [dataSourceChannelState.kind, dataSourceChannelState.channelKey],
      set: { backfillOldestAt: oldestAt, updatedAt: new Date() },
      // Race-safe: only move frontier deeper, never roll it back.
      setWhere: sql`(${dataSourceChannelState.backfillOldestAt} IS NULL OR ${dataSourceChannelState.backfillOldestAt} > ${oldestAt})`,
    });
}

/**
 * Mark the channel's backfill complete (adapter returned endOfPlaylist).
 * Cron auto-backfill picker excludes complete channels; daily incremental
 * cron still walks them (page-1 only) to discover new uploads.
 */
export async function markChannelBackfillComplete(
  kind: SourceKind,
  channelKey: string,
  dbCtx: DbOrTx = db,
): Promise<void> {
  await dbCtx
    .insert(dataSourceChannelState)
    .values({ kind, channelKey, backfillComplete: true })
    .onConflictDoUpdate({
      target: [dataSourceChannelState.kind, dataSourceChannelState.channelKey],
      set: { backfillComplete: true, updatedAt: new Date() },
    });
}

/**
 * Persistent backfill pagination cursor. Adapter returns `nextPageToken`
 * from each walk; worker stores it here so the next walk resumes from the
 * saved position instead of re-fetching the same first MAX_PAGES of pages.
 *
 * Pass `null` to clear (end-of-playlist reached or walked past target).
 *
 * Auto-creates row on first call. Atomic JSON merge preserves any other
 * adapter-specific metadata fields.
 */
export async function setChannelBackfillPageToken(
  kind: SourceKind,
  channelKey: string,
  pageToken: string | null,
  dbCtx: DbOrTx = db,
): Promise<void> {
  await dbCtx
    .insert(dataSourceChannelState)
    .values({
      kind,
      channelKey,
      metadata:
        pageToken === null
          ? sql`'{}'::jsonb`
          : sql`jsonb_build_object('lastBackfillPageToken', ${pageToken}::text)`,
    })
    .onConflictDoUpdate({
      target: [dataSourceChannelState.kind, dataSourceChannelState.channelKey],
      set: {
        metadata:
          pageToken === null
            ? sql`COALESCE(${dataSourceChannelState.metadata}, '{}'::jsonb) - 'lastBackfillPageToken'`
            : sql`jsonb_set(COALESCE(${dataSourceChannelState.metadata}, '{}'::jsonb), '{lastBackfillPageToken}', to_jsonb(${pageToken}::text), true)`,
        updatedAt: new Date(),
      },
    });
}
