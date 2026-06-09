// Telegram cron listing-poll picker — A2 dedup integration tests (real Postgres).
//
// The cron picker enqueues ONE service_source listing_poll row per channel with
// an active auto-import telegram_channel source, but SKIPS a channel that already
// has a listing_poll OR a backfill_page in flight. The backfill walker
// materializes feed events from its own pages (initial + historical); a
// concurrent listing_poll on the same window would double-fan the newest page on
// onboarding. So exactly ONE site materializes a channel per window (A2). No DB
// mocks (CLAUDE.md).

import { describe, it, expect } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import { adapterRefreshQueue } from "../../src/lib/server/db/schema/index.js";
import { createSource } from "../../src/lib/server/services/data-sources.js";
import { enqueueServiceListingPolls } from "../../src/lib/sources/telegram/server/index.js";
import { seedUserDirectly } from "./helpers.js";

const uniq = (): string => Math.random().toString(36).slice(2, 10);

const KIND = "telegram_channel" as const;

async function laneRows(
  channel: string,
  type: "listing_poll" | "backfill_page",
): Promise<number> {
  const rows = await db
    .select({ id: adapterRefreshQueue.id })
    .from(adapterRefreshQueue)
    .where(
      and(
        eq(adapterRefreshQueue.adapterKind, KIND),
        eq(adapterRefreshQueue.type, type),
        sql`${adapterRefreshQueue.status} IN ('pending','processing')`,
        sql`${adapterRefreshQueue.payload}->>'channel' = ${channel}`,
      ),
    );
  return rows.length;
}

/** Seed an auto-import telegram source (autoImport=false so onSourceCreated does
 *  NOT enqueue an onboarding backfill_page — the test controls the lane rows). */
async function seedSource(channel: string): Promise<void> {
  const user = await seedUserDirectly({ email: `tg-cron-${uniq()}@test.local` });
  await createSource(
    user.id,
    {
      kind: KIND,
      handleUrl: `https://t.me/${channel}`,
      isOwnedByMe: false,
      autoImport: true,
      // autoImport=true is required for the picker to pick the channel; we delete
      // any onboarding backfill row below to isolate the picker's own decision.
    },
    "127.0.0.1",
  );
  await db
    .delete(adapterRefreshQueue)
    .where(
      and(
        eq(adapterRefreshQueue.adapterKind, KIND),
        sql`${adapterRefreshQueue.payload}->>'channel' = ${channel}`,
      ),
    );
}

describe("telegram cron listing-poll picker dedup (A2)", () => {
  it("enqueues a listing_poll for a channel with no in-flight lane row", async () => {
    const channel = `cron_ok_${uniq()}`;
    await seedSource(channel);
    await enqueueServiceListingPolls("active", "job-1");
    expect(await laneRows(channel, "listing_poll")).toBe(1);
  });

  it("does NOT enqueue a listing_poll for a channel with an in-flight backfill_page", async () => {
    const channel = `cron_bf_${uniq()}`;
    await seedSource(channel);
    // Simulate an onboarding / deep-walk page in flight on the user lane.
    await db.insert(adapterRefreshQueue).values({
      adapterKind: KIND,
      queueName: "user_source",
      type: "backfill_page",
      payload: { channel },
      userId: null,
      priority: -10,
      status: "pending",
    });

    await enqueueServiceListingPolls("active", "job-2");
    // The picker skipped it — only the walker materializes during backfill.
    expect(await laneRows(channel, "listing_poll")).toBe(0);
    expect(await laneRows(channel, "backfill_page")).toBe(1);
  });

  it("does NOT stack a second listing_poll when one is already pending", async () => {
    const channel = `cron_dup_${uniq()}`;
    await seedSource(channel);
    await db.insert(adapterRefreshQueue).values({
      adapterKind: KIND,
      queueName: "service_source",
      type: "listing_poll",
      payload: { channel },
      userId: null,
      priority: 0,
      status: "pending",
    });
    await enqueueServiceListingPolls("active", "job-3");
    expect(await laneRows(channel, "listing_poll")).toBe(1);
  });
});
