// /sources/[id] loader. Renders one source's detail page just enough to
// host the RefreshContentButton.
//
// AGENTS.md invariants:
//   1. Tenant scoping — getSourceById(userId, params.id) is the only DB
//      read; cross-tenant access throws NotFoundError → SvelteKit error(404).
//   2. Cross-tenant 404 not 403 — error(404) carries the literal "Not
//      Found"; the SvelteKit error layout never emits "forbidden" /
//      "permission" text for tenant-owned resources.
//   5. DTO discipline — toDataSourceDto strips userId at projection time.
//      The page renders only fields surfaced by the DTO.
//
// Soft-deleted rows surface as 404 (matches GET /api/sources/:id pattern:
// the tombstone is invisible to detail navigation; users see them only on
// /sources via the Recently-deleted dialog).

import type { PageServerLoad } from "./$types.js";
import { error } from "@sveltejs/kit";
import { getSourceById } from "$lib/server/services/data-sources.js";
import { toDataSourceDto } from "$lib/server/dto.js";
import {
  getUserQuotaUsedToday,
  getUserQuotaLifetime,
  nextPacificMidnight,
} from "$lib/server/services/quota.js";
import { allAdapters } from "$lib/sources/registry.js";
import { NotFoundError } from "$lib/server/services/errors.js";
import { db } from "$lib/server/db/client.js";
import { youtubeChannels } from "$lib/server/db/schema/index.js";
import { dataSourceChannelState } from "$lib/server/db/schema/data-source-channel-state.js";
import { auditLog } from "$lib/server/db/schema/audit-log.js";
import { eq, and, gte, max, sql } from "drizzle-orm";

export const load: PageServerLoad = async ({ params, locals }) => {
  const userId = locals.user?.id;
  if (userId == null) {
    error(401);
  }
  try {
    const row = await getSourceById(userId, params.id);
    if (row.deletedAt !== null) {
      error(404);
    }

    // Quota status per platform (banner on detail page).
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

    // Populate channelTitle from youtube_channels cache. /sources list
    // loader has this JOIN already; detail loader was missing it so heading
    // fell back to handleUrl. Same code path as the list loader (single-row
    // case).
    const dto = toDataSourceDto(row);
    if (dto.channelId !== null) {
      const [cache] = await db
        .select({ channelTitle: youtubeChannels.channelTitle })
        .from(youtubeChannels)
        .where(eq(youtubeChannels.channelId, dto.channelId))
        .limit(1);
      dto.channelTitle = cache?.channelTitle ?? null;

      // Populate channel-scoped state from data_source_channel_state.
      // Per-source state columns dropped in migration 0028; channel-level
      // state shared across all subscribers.
      const [state] = await db
        .select({
          lastPolledAt: dataSourceChannelState.lastPolledAt,
          backfillOldestAt: dataSourceChannelState.backfillOldestAt,
          backfillComplete: dataSourceChannelState.backfillComplete,
        })
        .from(dataSourceChannelState)
        .where(
          and(
            eq(dataSourceChannelState.kind, dto.kind),
            eq(dataSourceChannelState.channelKey, dto.channelId),
          ),
        )
        .limit(1);
      if (state) {
        dto.lastPolledAt = state.lastPolledAt;
        dto.backfillOldestAt = state.backfillOldestAt;
        dto.backfillComplete = state.backfillComplete;
      }
    }

    // Refresh cooldown state from server. Same query as /sources list
    // loader: latest INTENT audit row within the 5-minute singletonKey
    // window. Lets RefreshContentButton resume the cooldown ticker on page
    // reload (pre-fix it was client-only).
    const COOLDOWN_MS = 5 * 60_000;
    const cooldownSince = new Date(Date.now() - COOLDOWN_MS);
    const [recent] = await db
      .select({ latest: max(auditLog.createdAt) })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.userId, userId),
          eq(auditLog.action, "source.refresh_content_requested"),
          sql`${auditLog.metadata}->>'flow' IS NULL`,
          sql`${auditLog.metadata}->>'source_id' = ${dto.id}`,
          gte(auditLog.createdAt, cooldownSince),
        ),
      );
    const cooldownSec = recent?.latest
      ? Math.max(0, Math.ceil((COOLDOWN_MS - (Date.now() - recent.latest.getTime())) / 1000))
      : 0;

    // Channel-scoped pulling state. Spinner reflects ANY user's walk on
    // this channel. pgboss schema guard: to_regclass NULL → fall back to
    // false on fresh self-host where worker hasn't booted.
    let pulling = false;
    if (dto.channelId !== null) {
      const activeJobs = await db
        .execute<{ exists: boolean }>(
          sql`
        SELECT EXISTS (
          SELECT 1 FROM pgboss.job
          WHERE name = 'youtube.backfill.channel'
            AND state IN ('active', 'created', 'retry')
            AND data->>'channelKey' = ${dto.channelId}
            AND to_regclass('pgboss.job') IS NOT NULL
        ) AS exists
      `,
        )
        .catch(() => ({ rows: [{ exists: false }] }));
      pulling = Boolean(activeJobs.rows[0]?.exists);
    }

    return { source: dto, quotaPlatforms, cooldownSec, pulling };
  } catch (err) {
    if (err instanceof NotFoundError) {
      error(404);
    }
    throw err;
  }
};
