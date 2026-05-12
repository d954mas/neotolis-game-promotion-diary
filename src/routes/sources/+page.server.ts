import type { PageServerLoad } from "./$types";
import { listSources } from "$lib/server/services/data-sources.js";
import { toDataSourceDto } from "$lib/server/dto.js";
import {
  getUserQuotaUsedToday,
  getUserQuotaLifetime,
  nextPacificMidnight,
} from "$lib/server/services/quota.js";
import { allAdapters } from "$lib/sources/registry.js";
import { db } from "$lib/server/db/client.js";
import { youtubeChannels } from "$lib/server/db/schema/index.js";
import { dataSourceChannelState } from "$lib/server/db/schema/data-source-channel-state.js";
import { events } from "$lib/server/db/schema/events.js";
import { auditLog } from "$lib/server/db/schema/audit-log.js";
import { and, eq, isNull, inArray, sql, gte, max, count } from "drizzle-orm";

/**
 * /sources loader — list the caller's data_sources, partitioned active vs
 * soft-deleted.
 *
 * Each row gains the YouTube channel title from the youtube_channels cache
 * so the page shows BOTH the user's own label (displayName) AND the real
 * channel name. Same pattern as the /feed loader.
 */
export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user)
    return {
      active: [],
      deleted: [],
      quotaPlatforms: [],
    };
  const all = await listSources(locals.user.id, { includeDeleted: true });
  const dtos = all.map(toDataSourceDto);

  const channelIds = dtos.map((s) => s.channelId).filter((c): c is string => c !== null);
  if (channelIds.length > 0) {
    const cache = await db
      .select({
        channelId: youtubeChannels.channelId,
        channelTitle: youtubeChannels.channelTitle,
      })
      .from(youtubeChannels)
      .where(inArray(youtubeChannels.channelId, channelIds));
    const titleByChannel = new Map<string, string | null>();
    for (const r of cache) titleByChannel.set(r.channelId, r.channelTitle);
    for (const s of dtos) {
      if (s.channelId) s.channelTitle = titleByChannel.get(s.channelId) ?? null;
    }

    // Channel-scoped state JOIN. lastPolledAt / backfillOldestAt /
    // backfillComplete now live on data_source_channel_state (one row per
    // channel, shared across subscribers). UI reads channel-level
    // last-poll value verbatim ("Channel last checked: 2 min ago").
    const stateRows = await db
      .select({
        channelKey: dataSourceChannelState.channelKey,
        kind: dataSourceChannelState.kind,
        lastPolledAt: dataSourceChannelState.lastPolledAt,
        backfillOldestAt: dataSourceChannelState.backfillOldestAt,
        backfillComplete: dataSourceChannelState.backfillComplete,
      })
      .from(dataSourceChannelState)
      .where(inArray(dataSourceChannelState.channelKey, channelIds));
    const stateByKey = new Map<
      string,
      { lastPolledAt: Date | null; backfillOldestAt: Date | null; backfillComplete: boolean }
    >();
    for (const r of stateRows) {
      stateByKey.set(`${r.kind}:${r.channelKey}`, {
        lastPolledAt: r.lastPolledAt,
        backfillOldestAt: r.backfillOldestAt,
        backfillComplete: r.backfillComplete,
      });
    }
    for (const s of dtos) {
      if (s.channelId) {
        const st = stateByKey.get(`${s.kind}:${s.channelId}`);
        if (st) {
          s.lastPolledAt = st.lastPolledAt;
          s.backfillOldestAt = st.backfillOldestAt;
          s.backfillComplete = st.backfillComplete;
        }
      }
    }
  }

  // First/last event date per source. Surfaces «what's the time range we
  // have for this source» on the row so user doesn't need to open detail
  // to see it. Single grouped query — same as /feed's per-source
  // date-range query.
  const sourceIds = dtos.map((s) => s.id);
  const eventStats = new Map<string, { first: Date; last: Date; count: number }>();
  if (sourceIds.length > 0) {
    const rows = await db
      .select({
        sourceId: events.sourceId,
        first: sql<Date>`MIN(${events.occurredAt})`,
        last: max(events.occurredAt),
        cnt: count(),
      })
      .from(events)
      .where(
        and(
          eq(events.userId, locals.user.id),
          inArray(events.sourceId, sourceIds),
          isNull(events.deletedAt),
        ),
      )
      .groupBy(events.sourceId);
    for (const r of rows) {
      if (r.sourceId !== null && r.first !== null && r.last !== null) {
        eventStats.set(r.sourceId, { first: r.first, last: r.last, count: Number(r.cnt) });
      }
    }
  }
  for (const s of dtos) {
    const stat = eventStats.get(s.id);
    s.firstEventAt = stat?.first ?? null;
    s.lastEventAt = stat?.last ?? null;
    s.eventCount = stat?.count ?? 0;
  }

  // Refresh-content cooldown state. The 5min cooldown was client-only
  // — F5 used to reset it. Server queries the latest refresh-content
  // INTENT audit row per source within the cooldown window and computes
  // remaining seconds. RefreshContentButton initializes from this state
  // so reload doesn't lose the gate.
  //
  // INTENT rows are the ones without `flow` field (worker COMPLETION rows
  // set flow=incremental/historical).
  const COOLDOWN_MS = 5 * 60_000;
  const cooldownSince = new Date(Date.now() - COOLDOWN_MS);
  const cooldownMap = new Map<string, number>(); // sourceId → remaining seconds
  if (sourceIds.length > 0) {
    const recent = await db
      .select({
        sourceId: sql<string>`metadata->>'source_id'`,
        latest: max(auditLog.createdAt),
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.userId, locals.user.id),
          eq(auditLog.action, "source.refresh_content_requested"),
          sql`${auditLog.metadata}->>'flow' IS NULL`,
          gte(auditLog.createdAt, cooldownSince),
        ),
      )
      .groupBy(sql`metadata->>'source_id'`)
      .catch(() => [] as { sourceId: string; latest: Date | null }[]);
    const now = Date.now();
    for (const r of recent) {
      if (r.sourceId !== null && r.latest !== null) {
        const elapsed = now - r.latest.getTime();
        const remaining = Math.max(0, Math.ceil((COOLDOWN_MS - elapsed) / 1000));
        if (remaining > 0) cooldownMap.set(r.sourceId, remaining);
      }
    }
  }
  const cooldownBySource: Record<string, number> = Object.fromEntries(cooldownMap);

  // Channel-scoped «pulling» state from pgboss queue. Worker payload
  // carries channelKey (not sourceId) — pulling is channel-level: ALL
  // subscribers to a channel see the spinner together when ANY user
  // triggered a walk on it (shared walk, shared visual state).
  const pullingMap = new Map<string, boolean>();
  if (channelIds.length > 0) {
    // pgboss schema guard — to_regclass returns NULL when missing
    // (fresh self-host install before any worker boot).
    const channelKeyList = sql.join(
      channelIds.map((c) => sql`${c}`),
      sql`, `,
    );
    const active = await db
      .execute<{ channel_key: string }>(
        sql`
      SELECT DISTINCT data->>'channelKey' AS channel_key
      FROM pgboss.job
      WHERE name = 'youtube.backfill.channel'
        AND state IN ('active', 'created', 'retry')
        AND data->>'channelKey' IN (${channelKeyList})
        AND to_regclass('pgboss.job') IS NOT NULL
    `,
      )
      .catch(() => ({ rows: [] as { channel_key: string }[] }));
    const pullingChannelKeys = new Set(active.rows.map((r) => r.channel_key).filter(Boolean));
    for (const s of dtos) {
      if (s.channelId && pullingChannelKeys.has(s.channelId)) {
        pullingMap.set(s.id, true);
      }
    }
  }
  const pullingBySource: Record<string, boolean> = Object.fromEntries(pullingMap);

  // Quota status per platform (today + lifetime). Banner surfaces all
  // platforms — adding a new source kind adds a row automatically via
  // allAdapters iteration. Each adapter declares own userQuotaCap (or
  // omits — banner shows count + "no limit").
  const userId = locals.user.id;
  const resetAt = nextPacificMidnight();
  const resetsInMs = Math.max(0, resetAt.getTime() - Date.now());
  const quotaPlatforms = await Promise.all(
    allAdapters.map(async (a) => {
      const today = await getUserQuotaUsedToday(userId, a.kind);
      const lifetime = await getUserQuotaLifetime(userId, a.kind);
      return {
        kind: a.kind,
        today,
        lifetime,
        cap: {
          requestsPerDay: a.observability.userQuotaCap?.requestsPerDay,
          eventsPerDay: a.observability.userQuotaCap?.eventsPerDay,
        },
        resetsInMs,
      };
    }),
  );

  return {
    active: dtos.filter((s) => s.deletedAt === null),
    deleted: dtos.filter((s) => s.deletedAt !== null),
    quotaPlatforms,
    cooldownBySource,
    pullingBySource,
  };
};
