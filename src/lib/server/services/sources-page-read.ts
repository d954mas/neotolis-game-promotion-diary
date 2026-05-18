// Read-model for the /sources page loader. Aggregates everything the
// page needs into a single shape so +page.server.ts stays a thin
// composition layer instead of a 6-query loader.
//
// All queries here filter by `userId` first (tenant scope), then bulk-
// load by `inArray` for the user's rows only — never spanning tenants.
// Cross-tenant lookups (YouTube channels, pgboss jobs) are scoped by
// the userId-derived channelIds the user actually owns.
//
// Routes call this; nobody else. The +page.server.ts loader is a
// SvelteKit-style "route" per AGENTS.md "Routes call services" — same
// rule applies as Hono handlers.

import { and, eq, isNull, inArray, sql, gte, max, count } from "drizzle-orm";
import { db } from "../db/client.js";
import { youtubeChannels } from "../db/schema/index.js";
import { dataSourceChannelState } from "../db/schema/data-source-channel-state.js";
import {
  redditSubredditsCache,
  redditUsersCache,
} from "$lib/sources/reddit/server/schema/index.js";
import { events } from "../db/schema/events.js";
import { auditLog } from "../db/schema/audit-log.js";
import { allAdapters } from "$lib/sources/registry.js";
import { redditAdapter, getRecentLoad } from "$lib/sources/reddit/server/index.js";
import { checkRedditUserCap } from "$lib/sources/reddit/server/quota.js";
import { getSourceById, listSources } from "./data-sources.js";
import { toDataSourceDto, type DataSourceDto } from "../dto.js";
import { getUserQuotaUsedToday, getUserQuotaLifetime, nextPacificMidnight } from "./quota.js";
import { NotFoundError } from "./errors.js";

const REFRESH_CONTENT_COOLDOWN_MS = 5 * 60_000;

export interface QuotaPlatformView {
  kind: string;
  today: { requests: number; events: number };
  lifetime: { requests: number; events: number };
  cap: { requestsPerDay?: number; eventsPerDay?: number };
  resetsInMs: number;
}

export type RedditQuotaView =
  | {
      isOperatorConfigured: true;
      sourceActions: { used: number; cap: number; windowMinutes: number };
      postRefreshes: { used: number; cap: number; windowMinutes: number };
      serviceLoad: { used: number; capacity: number };
    }
  | { isOperatorConfigured: false };

export interface SourcesPageData {
  active: DataSourceDto[];
  deleted: DataSourceDto[];
  quotaPlatforms: QuotaPlatformView[];
  redditQuota: RedditQuotaView;
  cooldownBySource: Record<string, number>;
  pullingBySource: Record<string, boolean>;
}

export interface SourceDetailPageData {
  source: DataSourceDto;
  quotaPlatforms: QuotaPlatformView[];
  cooldownSec: number;
  pulling: boolean;
}

/**
 * Top-level read for /sources. Composes the per-aspect loaders below.
 * Keeping each block in its own helper lets future tests target one
 * dimension without setting up six fixtures.
 */
export async function loadSourcesPage(userId: string): Promise<SourcesPageData> {
  const all = await listSources(userId, { includeDeleted: true });
  const dtos = all.map(toDataSourceDto);

  const channelIds = dtos.map((s) => s.channelId).filter((c): c is string => c !== null);
  const sourceIds = dtos.map((s) => s.id);

  await enrichDataSourceDtosWithYoutubeChannelTitles(dtos);
  await enrichWithChannelState(dtos, channelIds);
  await enrichRedditSourcesWithLastPolled(dtos);
  await enrichWithEventStats(dtos, userId, sourceIds);

  const cooldownBySource = await loadRefreshContentCooldown(userId, sourceIds);
  const pullingBySource = await loadPullingChannels(dtos, channelIds);
  const quotaPlatforms = await loadQuotaPlatforms(userId);
  const redditQuota = await loadRedditQuota(userId);

  return {
    active: dtos.filter((s) => s.deletedAt === null),
    deleted: dtos.filter((s) => s.deletedAt !== null),
    quotaPlatforms,
    redditQuota,
    cooldownBySource,
    pullingBySource,
  };
}

export async function loadSourceDetailPage(
  userId: string,
  sourceId: string,
): Promise<SourceDetailPageData> {
  const row = await getSourceById(userId, sourceId);
  if (row.deletedAt !== null) {
    throw new NotFoundError();
  }

  const dto = toDataSourceDto(row);
  const channelIds = dto.channelId === null ? [] : [dto.channelId];

  await enrichDataSourceDtosWithYoutubeChannelTitles([dto]);
  await enrichWithChannelState([dto], channelIds);
  await enrichRedditSourcesWithLastPolled([dto]);

  const [quotaPlatforms, cooldownBySource, pullingBySource] = await Promise.all([
    loadQuotaPlatforms(userId),
    loadRefreshContentCooldown(userId, [dto.id]),
    loadPullingChannels([dto], channelIds),
  ]);

  return {
    source: dto,
    quotaPlatforms,
    cooldownSec: cooldownBySource[dto.id] ?? 0,
    pulling: pullingBySource[dto.id] ?? false,
  };
}

export async function enrichDataSourceDtosWithYoutubeChannelTitles(
  dtos: DataSourceDto[],
): Promise<void> {
  const channelIds = dtos.map((s) => s.channelId).filter((c): c is string => c !== null);
  if (channelIds.length === 0) return;
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
}

/**
 * Reddit sources don't have a channelId (they key on metadata.username
 * for reddit_account or metadata.subreddit for reddit_subreddit), so
 * `enrichWithChannelState` above misses them — they would show
 * "Never pulled" on /sources even after the worker has been polling
 * for days. Read last_metadata_refresh_at from the per-kind PUBLIC-
 * DATA caches and stamp it onto the DTO.
 *
 * reddit_subreddits_cache / reddit_users_cache are upserted by the
 * adapter's poll handlers (sub_poll, author_poll, post_single) on
 * every successful drain, so last_metadata_refresh_at is the same
 * "when did we last hear from Reddit about this subject" signal that
 * data_source_channel_state.last_polled_at gives YouTube.
 */
async function enrichRedditSourcesWithLastPolled(dtos: DataSourceDto[]): Promise<void> {
  const subreddits: string[] = [];
  const usernames: string[] = [];
  for (const s of dtos) {
    const md = (s.metadata ?? {}) as { subreddit?: unknown; username?: unknown };
    if (s.kind === "reddit_subreddit" && typeof md.subreddit === "string" && md.subreddit) {
      subreddits.push(md.subreddit);
    } else if (s.kind === "reddit_account" && typeof md.username === "string" && md.username) {
      usernames.push(md.username);
    }
  }
  if (subreddits.length === 0 && usernames.length === 0) return;

  const subBySubreddit = new Map<string, Date | null>();
  if (subreddits.length > 0) {
    const rows = await db
      .select({
        name: redditSubredditsCache.name,
        lastMetadataRefreshAt: redditSubredditsCache.lastMetadataRefreshAt,
      })
      .from(redditSubredditsCache)
      .where(inArray(redditSubredditsCache.name, subreddits));
    for (const r of rows) subBySubreddit.set(r.name, r.lastMetadataRefreshAt);
  }

  const subByUsername = new Map<string, Date | null>();
  if (usernames.length > 0) {
    const rows = await db
      .select({
        username: redditUsersCache.username,
        lastMetadataRefreshAt: redditUsersCache.lastMetadataRefreshAt,
      })
      .from(redditUsersCache)
      .where(inArray(redditUsersCache.username, usernames));
    for (const r of rows) subByUsername.set(r.username, r.lastMetadataRefreshAt);
  }

  for (const s of dtos) {
    if (s.lastPolledAt !== null && s.lastPolledAt !== undefined) continue;
    const md = (s.metadata ?? {}) as { subreddit?: unknown; username?: unknown };
    if (s.kind === "reddit_subreddit" && typeof md.subreddit === "string") {
      s.lastPolledAt = subBySubreddit.get(md.subreddit) ?? null;
    } else if (s.kind === "reddit_account" && typeof md.username === "string") {
      s.lastPolledAt = subByUsername.get(md.username) ?? null;
    }
  }
}

async function enrichWithChannelState(dtos: DataSourceDto[], channelIds: string[]): Promise<void> {
  if (channelIds.length === 0) return;
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
    if (!s.channelId) continue;
    const st = stateByKey.get(`${s.kind}:${s.channelId}`);
    if (!st) continue;
    s.lastPolledAt = st.lastPolledAt;
    s.backfillOldestAt = st.backfillOldestAt;
    s.backfillComplete = st.backfillComplete;
  }
}

async function enrichWithEventStats(
  dtos: DataSourceDto[],
  userId: string,
  sourceIds: string[],
): Promise<void> {
  if (sourceIds.length === 0) return;
  const rows = await db
    .select({
      sourceId: events.sourceId,
      first: sql<Date>`MIN(${events.occurredAt})`,
      last: max(events.occurredAt),
      cnt: count(),
    })
    .from(events)
    .where(
      and(eq(events.userId, userId), inArray(events.sourceId, sourceIds), isNull(events.deletedAt)),
    )
    .groupBy(events.sourceId);
  const eventStats = new Map<string, { first: Date; last: Date; count: number }>();
  for (const r of rows) {
    if (r.sourceId !== null && r.first !== null && r.last !== null) {
      eventStats.set(r.sourceId, { first: r.first, last: r.last, count: Number(r.cnt) });
    }
  }
  for (const s of dtos) {
    const stat = eventStats.get(s.id);
    s.firstEventAt = stat?.first ?? null;
    s.lastEventAt = stat?.last ?? null;
    s.eventCount = stat?.count ?? 0;
  }
}

/**
 * Refresh-content button cooldown. The 5-min window was originally
 * client-only — F5 reset it. Server-side, we read the latest
 * refresh-content INTENT audit row per source within the cooldown
 * window and compute remaining seconds. INTENT rows are the ones with
 * no `flow` field (worker COMPLETION rows set flow).
 */
async function loadRefreshContentCooldown(
  userId: string,
  sourceIds: string[],
): Promise<Record<string, number>> {
  if (sourceIds.length === 0) return {};
  const cooldownSince = new Date(Date.now() - REFRESH_CONTENT_COOLDOWN_MS);
  const recent = await db
    .select({
      sourceId: sql<string>`metadata->>'source_id'`,
      latest: max(auditLog.createdAt),
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.userId, userId),
        eq(auditLog.action, "source.refresh_content_requested"),
        sql`${auditLog.metadata}->>'flow' IS NULL`,
        gte(auditLog.createdAt, cooldownSince),
      ),
    )
    .groupBy(sql`metadata->>'source_id'`);
  const cooldown: Record<string, number> = {};
  const now = Date.now();
  for (const r of recent) {
    if (r.sourceId === null || r.latest === null) continue;
    const latest = r.latest instanceof Date ? r.latest : new Date(r.latest as string | number);
    const elapsed = now - latest.getTime();
    const remaining = Math.max(0, Math.ceil((REFRESH_CONTENT_COOLDOWN_MS - elapsed) / 1000));
    if (remaining > 0) cooldown[r.sourceId] = remaining;
  }
  return cooldown;
}

/**
 * Channel-scoped "pulling" state from the pg-boss queue. Worker payload
 * carries channelKey (not sourceId), so a walk on a channel paints
 * spinners on ALL subscribers to that channel together — the walk is
 * shared. `to_regclass` guards a fresh self-host install where the
 * pgboss schema hasn't been created yet.
 */
async function loadPullingChannels(
  dtos: DataSourceDto[],
  channelIds: string[],
): Promise<Record<string, boolean>> {
  if (channelIds.length === 0) return {};
  const regclass = await db.execute<{ exists: boolean }>(
    sql`SELECT to_regclass('pgboss.job') IS NOT NULL AS exists`,
  );
  if (regclass.rows[0]?.exists !== true) return {};

  const channelKeyList = sql.join(
    channelIds.map((c) => sql`${c}`),
    sql`, `,
  );
  const active = await db.execute<{ channel_key: string }>(
    sql`
      SELECT DISTINCT data->>'channelKey' AS channel_key
      FROM pgboss.job
      WHERE name = 'youtube.backfill.channel'
        AND state IN ('active', 'created', 'retry')
        AND data->>'channelKey' IN (${channelKeyList})
    `,
  );
  const pullingChannelKeys = new Set(active.rows.map((r) => r.channel_key).filter(Boolean));
  const pulling: Record<string, boolean> = {};
  for (const s of dtos) {
    if (s.channelId && pullingChannelKeys.has(s.channelId)) pulling[s.id] = true;
  }
  return pulling;
}

/**
 * Per-adapter quota usage (today + lifetime) for the QuotaStatusBanner.
 * Iterates allAdapters so a new source kind adds a row automatically —
 * no edits needed here.
 */
async function loadQuotaPlatforms(userId: string): Promise<QuotaPlatformView[]> {
  const resetAt = nextPacificMidnight();
  const resetsInMs = Math.max(0, resetAt.getTime() - Date.now());
  return Promise.all(
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
}

/**
 * Reddit-specific block. The Reddit tab in QuotaStatusBanner renders a
 * 3-line view (source-actions / post-refreshes / service-load) instead
 * of the YouTube two-axis bars; when the operator hasn't configured
 * REDDIT_USER_AGENT we surface the "not configured" empty state.
 */
async function loadRedditQuota(userId: string): Promise<RedditQuotaView> {
  if (!redditAdapter.observability.auth.isOperatorConfigured) {
    return { isOperatorConfigured: false };
  }
  const [sourceActionsResult, postRefreshesResult, serviceLoad] = await Promise.all([
    checkRedditUserCap(db, userId, "source-actions"),
    checkRedditUserCap(db, userId, "post-refreshes"),
    getRecentLoad(60),
  ]);
  return {
    isOperatorConfigured: true,
    sourceActions: {
      used: sourceActionsResult.used,
      cap: sourceActionsResult.cap,
      windowMinutes: sourceActionsResult.window_minutes,
    },
    postRefreshes: {
      used: postRefreshesResult.used,
      cap: postRefreshesResult.cap,
      windowMinutes: postRefreshesResult.window_minutes,
    },
    serviceLoad,
  };
}
