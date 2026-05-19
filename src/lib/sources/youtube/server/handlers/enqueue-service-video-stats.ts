import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { adapterRefreshQueue } from "$lib/server/db/schema/index.js";

export type YoutubeServiceVideoFlow = "active" | "cold" | "backfill" | "no_data" | "rehab";

export async function enqueueServiceVideoStats(
  videoIds: string[],
  flow: YoutubeServiceVideoFlow,
): Promise<number> {
  const uniqueVideoIds = [...new Set(videoIds.filter((id) => id.length > 0))];
  if (uniqueVideoIds.length === 0) return 0;

  return db.transaction(async (tx) => {
    for (const videoId of [...uniqueVideoIds].sort()) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${"youtube_service_video:" + videoId}))`,
      );
    }

    // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- service_video lane scan: cron writes user_id=NULL across all tenants
    const existing = await tx
      .select({
        videoId: sql<string>`${adapterRefreshQueue.payload}->>'video_id'`,
      })
      .from(adapterRefreshQueue)
      .where(
        and(
          eq(adapterRefreshQueue.adapterKind, "youtube_channel"),
          eq(adapterRefreshQueue.queueName, "service_video"),
          inArray(adapterRefreshQueue.status, ["pending", "processing"]),
          sql`${adapterRefreshQueue.payload}->>'video_id' IN (${sql.join(
            uniqueVideoIds.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        ),
      );
    const existingIds = new Set(existing.map((row) => row.videoId));
    const rows = uniqueVideoIds
      .filter((videoId) => !existingIds.has(videoId))
      .map((videoId) => ({
        adapterKind: "youtube_channel" as const,
        queueName: "service_video",
        type: "video_stats",
        payload: { video_id: videoId, flow },
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
