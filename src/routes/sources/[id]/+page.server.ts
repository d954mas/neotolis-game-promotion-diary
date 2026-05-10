// /sources/[id] loader — Phase 03.0.1 Plan 10. Renders one source's detail
// page just enough to host the RefreshContentButton (the user-facing payoff
// of the Wave 0-8 source-plugin refactor).
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

    // Phase 03.0.1 — quota status per platform (banner на detail page).
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

    // Phase 03.0.1 (post-review UAT 2026-05-10) — populate channelTitle
    // from youtube_channels cache. /sources list loader has this JOIN
    // already; detail loader was missing it so heading fell back to
    // handleUrl. Same code path as the list loader (single-row case).
    const dto = toDataSourceDto(row);
    if (dto.channelId !== null) {
      const [cache] = await db
        .select({ channelTitle: youtubeChannels.channelTitle })
        .from(youtubeChannels)
        .where(eq(youtubeChannels.channelId, dto.channelId))
        .limit(1);
      dto.channelTitle = cache?.channelTitle ?? null;
    }

    // Phase 03.0.1 (post-review UAT) — refresh cooldown state from server.
    // Same query as /sources list loader: latest INTENT audit row within
    // the 5-minute singletonKey window. Lets RefreshContentButton resume
    // the cooldown ticker on page reload (pre-fix it was client-only).
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

    // «Pulling» state from pgboss queue — same query as /sources list
    // but for one source.
    const activeJobs = await db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM pgboss.job
        WHERE name = 'youtube.backfill.user'
          AND state IN ('active', 'created', 'retry')
          AND data->>'sourceId' = ${dto.id}
      ) AS exists
    `);
    const pulling = Boolean(activeJobs.rows[0]?.exists);

    return { source: dto, quotaPlatforms, cooldownSec, pulling };
  } catch (err) {
    if (err instanceof NotFoundError) {
      error(404);
    }
    throw err;
  }
};
