// Warm auto-refresh producer — enqueues service_post rows into
// adapter_refresh_queue (#70). Mirrors youtube enqueue-service-video-stats.ts:
// advisory-lock per id (serialize concurrent producers) + skip-if-pending dedup
// (the auto path MUST dedup — between enqueue and processing last_polled_at is
// still stale, so the next warm tick would re-select the same post; the manual
// user_post path stays cooldown-only). user_id=NULL → public-data cron lane.

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { adapterRefreshQueue } from "$lib/server/db/schema/index.js";

const ADAPTER_KIND = "instagram_account";
const QUEUE_NAME = "service_post";

export async function enqueueServiceInstagramPostStats(postIds: string[]): Promise<number> {
  const unique = [...new Set(postIds.filter((id) => id.length > 0))];
  if (unique.length === 0) return 0;

  return db.transaction(async (tx) => {
    // Deterministic lock order (sorted) avoids deadlocks between concurrent ticks.
    for (const postId of [...unique].sort()) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${"instagram_service_post:" + postId}))`,
      );
    }

    // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- service_post lane scan: cron writes user_id=NULL across all tenants
    const existing = await tx
      .select({ postId: sql<string>`${adapterRefreshQueue.payload}->>'post_id'` })
      .from(adapterRefreshQueue)
      .where(
        and(
          eq(adapterRefreshQueue.adapterKind, ADAPTER_KIND),
          eq(adapterRefreshQueue.queueName, QUEUE_NAME),
          inArray(adapterRefreshQueue.status, ["pending", "processing"]),
          sql`${adapterRefreshQueue.payload}->>'post_id' IN (${sql.join(
            unique.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        ),
      );
    const existingIds = new Set(existing.map((row) => row.postId));

    const rows = unique
      .filter((postId) => !existingIds.has(postId))
      .map((postId) => ({
        adapterKind: ADAPTER_KIND,
        queueName: QUEUE_NAME,
        type: "post_stats",
        payload: { post_id: postId },
        userId: null,
        priority: 10,
        status: "pending" as const,
      }));

    if (rows.length === 0) return 0;
    const inserted = await tx
      .insert(adapterRefreshQueue)
      .values(rows)
      .returning({ id: adapterRefreshQueue.id });
    return inserted.length;
  });
}
