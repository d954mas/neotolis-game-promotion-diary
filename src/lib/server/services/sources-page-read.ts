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
import { youtubeChannels, telegramChannels } from "../db/schema/index.js";
import { dataSourceChannelState } from "../db/schema/data-source-channel-state.js";
import { redditSubreddits, redditAccounts } from "$lib/sources/reddit/server/schema/index.js";
import { events } from "../db/schema/events.js";
import { auditLog } from "../db/schema/audit-log.js";
import { getSourceById, listSources } from "./data-sources.js";
import { toDataSourceDto, type DataSourceDto } from "../dto.js";
import { loadUserQuota, loadQuotaPlatforms } from "./quota-read.js";
import type { QuotaPlatformView, RedditQuotaView } from "./quota-read.js";
import { NotFoundError } from "./errors.js";
import { QUEUES } from "../queues.js";

// Per-user quota types now live in quota-read.ts (D-03, single source of
// truth). Re-exported here so existing importers of these names from
// sources-page-read.ts keep working.
export type { QuotaPlatformView, RedditQuotaView } from "./quota-read.js";

const REFRESH_CONTENT_COOLDOWN_MS = 5 * 60_000;
const PULLING_SOURCE_KIND_BY_QUEUE = new Map<string, DataSourceDto["kind"]>([
  [QUEUES.YOUTUBE_BACKFILL_CHANNEL, "youtube_channel"],
  [QUEUES.REDDIT_BACKFILL_ACCOUNT, "reddit_account"],
  [QUEUES.REDDIT_BACKFILL_ACCOUNT_LEGACY, "reddit_account"],
  [QUEUES.REDDIT_BACKFILL_SUBREDDIT, "reddit_subreddit"],
  [QUEUES.REDDIT_BACKFILL_SUBREDDIT_LEGACY, "reddit_subreddit"],
]);

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
  await enrichTelegramSourcesWithChannelTitle(dtos);
  await enrichWithChannelState(dtos);
  await enrichWithChannelState(dtos, telegramChannelKey);
  await enrichRedditSourcesWithLastPolled(dtos);
  await enrichWithEventStats(dtos, userId, sourceIds);

  const cooldownBySource = await loadRefreshContentCooldown(userId, sourceIds);
  const pullingBySource = await loadPullingChannels(dtos, channelIds);
  const { quotaPlatforms, redditQuota } = await loadUserQuota(userId);

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
  await enrichTelegramSourcesWithChannelTitle([dto]);
  await enrichWithChannelState([dto]);
  await enrichWithChannelState([dto], telegramChannelKey);
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
 * Telegram sources have no channelId — the channel title lives on the
 * telegram_channels ENTITY (keyed by channel_key, upserted from the listing
 * header on every poll), deliberately NOT denormalized onto data_sources (the
 * no-denorm rule). So /sources would fall back to the raw t.me URL. Read the
 * entity title by slug (data_sources.metadata.channel) and stamp it onto
 * dto.channelTitle — the SAME field YouTube uses — so SourceRow's
 * channelTitle-first precedence renders the channel name (e.g. "d954mas | …")
 * instead of the URL. Mirrors enrichDataSourceDtosWithYoutubeChannelTitles.
 *
 * A never-polled channel has no entity row yet → channelTitle stays null and
 * SourceRow falls back to the @handle (deriveTelegramHandle), never the bare URL.
 * Joining on the slug (the user-registered handle === the current entity slug in
 * the common case) is consistent with how the walker keys telegram channel-state.
 */
export async function enrichTelegramSourcesWithChannelTitle(dtos: DataSourceDto[]): Promise<void> {
  const slugs: string[] = [];
  for (const s of dtos) {
    if (s.kind !== "telegram_channel") continue;
    const md = (s.metadata ?? {}) as { channel?: unknown };
    if (typeof md.channel === "string" && md.channel) slugs.push(md.channel);
  }
  if (slugs.length === 0) return;
  const rows = await db
    .select({ slug: telegramChannels.slug, title: telegramChannels.title })
    .from(telegramChannels)
    .where(inArray(telegramChannels.slug, slugs));
  const titleBySlug = new Map<string, string | null>();
  for (const r of rows) if (r.slug !== null) titleBySlug.set(r.slug, r.title);
  for (const s of dtos) {
    if (s.kind !== "telegram_channel") continue;
    const md = (s.metadata ?? {}) as { channel?: unknown };
    if (typeof md.channel === "string" && md.channel) {
      s.channelTitle = titleBySlug.get(md.channel) ?? null;
    }
  }
}

/**
 * Reddit sources carry the walk join key in metadata (metadata.handle for
 * reddit_account, metadata.slug for reddit_subreddit — the lowercase, rename-proof
 * username / subreddit slug the rebuilt adapter persists at create time). The
 * "when did we last hear from Reddit about this subject" signal does NOT live on
 * data_source_channel_state.last_polled_at (which the walker leaves null until a
 * channel-scoped poll stamps it); it lives on the per-kind subject-entity tables.
 * Read it from there and stamp it onto the DTO so /sources shows a real
 * "updated N ago" instead of "Never pulled".
 *
 * reddit_subreddits / reddit_accounts (the Phase 12 subject-entity tables) carry
 * last_refreshed_at, stamped by the rebuilt adapter's write path on every
 * successful walk (walk-core upsertRedditAccount / upsertRedditSubreddit). The
 * metadata VALUE (handle / slug) IS the tables' primary key (username / slug), so
 * it joins directly — no separate id lookup.
 */
async function enrichRedditSourcesWithLastPolled(dtos: DataSourceDto[]): Promise<void> {
  const subreddits: string[] = [];
  const usernames: string[] = [];
  for (const s of dtos) {
    const md = (s.metadata ?? {}) as { slug?: unknown; handle?: unknown };
    if (s.kind === "reddit_subreddit" && typeof md.slug === "string" && md.slug) {
      subreddits.push(md.slug);
    } else if (s.kind === "reddit_account" && typeof md.handle === "string" && md.handle) {
      usernames.push(md.handle);
    }
  }
  if (subreddits.length === 0 && usernames.length === 0) return;

  const subBySubreddit = new Map<string, Date | null>();
  if (subreddits.length > 0) {
    const rows = await db
      .select({
        slug: redditSubreddits.slug,
        lastRefreshedAt: redditSubreddits.lastRefreshedAt,
      })
      .from(redditSubreddits)
      .where(inArray(redditSubreddits.slug, subreddits));
    for (const r of rows) subBySubreddit.set(r.slug, r.lastRefreshedAt);
  }

  const subByUsername = new Map<string, Date | null>();
  if (usernames.length > 0) {
    const rows = await db
      .select({
        username: redditAccounts.username,
        lastRefreshedAt: redditAccounts.lastRefreshedAt,
      })
      .from(redditAccounts)
      .where(inArray(redditAccounts.username, usernames));
    for (const r of rows) subByUsername.set(r.username, r.lastRefreshedAt);
  }

  for (const s of dtos) {
    if (s.lastPolledAt !== null && s.lastPolledAt !== undefined) continue;
    const md = (s.metadata ?? {}) as { slug?: unknown; handle?: unknown };
    if (s.kind === "reddit_subreddit" && typeof md.slug === "string") {
      s.lastPolledAt = subBySubreddit.get(md.slug) ?? null;
    } else if (s.kind === "reddit_account" && typeof md.handle === "string") {
      s.lastPolledAt = subByUsername.get(md.handle) ?? null;
    }
  }
}

/**
 * The channel-state key for a DTO. YouTube keys on the dto.channelId column
 * (the default); Telegram has no channelId — it keys on metadata.channel (the
 * @slug, which IS the data_source_channel_state.channel_key for a
 * telegram_channel row, mirroring how the walker stamps it). Returns null when
 * the DTO carries no key for its kind (skip — no enrichment).
 */
function telegramChannelKey(dto: DataSourceDto): string | null {
  const md = (dto.metadata ?? {}) as { channel?: unknown };
  return typeof md.channel === "string" && md.channel !== "" ? md.channel : null;
}

/**
 * Stamp last_polled_at / backfill state from data_source_channel_state onto the
 * DTOs, joining on a per-kind key accessor. YouTube joins on dto.channelId (the
 * default keyOf); Telegram joins on metadata.channel (its @slug), which is the
 * SAME table's channel_key — so both kinds flow through ONE query + one map
 * instead of a per-kind copy. Reddit stays separate (two caches, different
 * columns — enrichRedditSourcesWithLastPolled).
 *
 * Without this for Telegram, a telegram_channel DTO would carry lastPolledAt=null
 * and SourceRow would render "Queued" forever even after the walker has polled
 * (the bug this guards). The map is keyed `${kind}:${key}` so a YouTube channelId
 * and a Telegram slug can never cross-resolve.
 */
async function enrichWithChannelState(
  dtos: DataSourceDto[],
  keyOf: (dto: DataSourceDto) => string | null = (d) => d.channelId,
): Promise<void> {
  const keys = dtos.map(keyOf).filter((k): k is string => k !== null);
  if (keys.length === 0) return;
  const stateRows = await db
    .select({
      channelKey: dataSourceChannelState.channelKey,
      kind: dataSourceChannelState.kind,
      lastPolledAt: dataSourceChannelState.lastPolledAt,
      backfillOldestAt: dataSourceChannelState.backfillOldestAt,
      backfillComplete: dataSourceChannelState.backfillComplete,
    })
    .from(dataSourceChannelState)
    .where(inArray(dataSourceChannelState.channelKey, keys));
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
    const key = keyOf(s);
    if (key === null) continue;
    const st = stateByKey.get(`${s.kind}:${key}`);
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
 * Channel-scoped "pulling" state from the pg-boss queues. Worker payloads
 * carry channelKey (not sourceId), so a walk on a channel paints spinners
 * on ALL subscribers to that channel together — the walk is shared.
 * Queue-to-kind namespacing prevents equal keys on different platforms
 * from painting each other's sources. `to_regclass` guards a fresh
 * self-host install where the pgboss schema hasn't been created yet.
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
  const queueNameList = sql.join(
    [...PULLING_SOURCE_KIND_BY_QUEUE.keys()].map((name) => sql`${name}`),
    sql`, `,
  );
  const active = await db.execute<{ name: string; channel_key: string }>(
    sql`
      SELECT DISTINCT name, data->>'channelKey' AS channel_key
      FROM pgboss.job
      WHERE name IN (${queueNameList})
        AND state IN ('active', 'created', 'retry')
        AND data->>'channelKey' IN (${channelKeyList})
    `,
  );
  const pullingSourceKeys = new Set(
    active.rows.flatMap((row) => {
      const kind = PULLING_SOURCE_KIND_BY_QUEUE.get(row.name);
      return kind === undefined || !row.channel_key ? [] : [`${kind}:${row.channel_key}`];
    }),
  );
  const pulling: Record<string, boolean> = {};
  for (const s of dtos) {
    if (s.channelId && pullingSourceKeys.has(`${s.kind}:${s.channelId}`)) pulling[s.id] = true;
  }
  return pulling;
}
