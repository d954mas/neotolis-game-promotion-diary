// Telegram warm auto-refresh — eligibility predicate + producer handler (Phase 9
// Plan 04). Mirrors instagram-warm-eligibility.test.ts MINUS the throttle /
// provider mocks: Telegram is FREE, so the producer has NO gate to mock and the
// predicate has NO budget axis.
//
// selectWarmTelegramPostIds is the bounded selection: event-attached posts that
// are YOUNG (< TELEGRAM_WARM_WINDOW_DAYS, default 7) AND STALE (last_polled_at
// older than TELEGRAM_WARM_STALENESS_HOURS, default 12), minus genuinely-terminal
// (not_found/private) and persistently-failing (poll_failure_count >= max) posts.
//
// Real Postgres via ./helpers.js; selection asserts via toContain on the
// per-test post ids (the predicate is service-wide, so never assert exact arrays).

import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";

const { db } = await import("../../src/lib/server/db/client.js");
const { telegramPosts, adapterRefreshQueue, events } =
  await import("../../src/lib/server/db/schema/index.js");
const { createEvent } = await import("../../src/lib/server/services/events-mutation.js");
const { selectWarmTelegramPostIds } =
  await import("../../src/lib/sources/telegram/server/warm-eligibility.js");
const { handleTelegramWarmRefresh } =
  await import("../../src/lib/sources/telegram/server/handlers/warm-refresh.js");
const { env } = await import("../../src/lib/server/config/env.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);
const DAY = 86_400_000;
const HOUR = 3_600_000;

interface SeedOpts {
  publishedAgoDays: number;
  lastPolledAgoHours: number | null;
  lastPollStatus?: string | null;
  pollFailureCount?: number;
  attachEvent?: boolean; // default true
  deleteEvent?: boolean; // default false
}

/** Seed a public-data telegram_posts row with precise polling state + (by
 *  default) one alive event referencing it. Returns the post_id
 *  ("<channel>/<messageId>"). */
async function seedCandidate(userId: string, opts: SeedOpts): Promise<string> {
  const postId = `warmch_${uniq()}/${Math.floor(Math.random() * 1e6)}`;
  const now = Date.now();
  await db.insert(telegramPosts).values({
    postId,
    publishedAt: new Date(now - opts.publishedAgoDays * DAY),
    lastPolledAt:
      opts.lastPolledAgoHours === null ? null : new Date(now - opts.lastPolledAgoHours * HOUR),
    lastPollStatus: opts.lastPollStatus ?? null,
    pollFailureCount: opts.pollFailureCount ?? 0,
  });
  if (opts.attachEvent !== false) {
    const ev = await createEvent(
      userId,
      {
        kind: "telegram_post",
        title: "warm",
        externalId: postId, // no url → re-derivation skipped; externalId kept verbatim
        occurredAt: new Date().toISOString(),
        gameIds: [],
      },
      "127.0.0.1",
    );
    if (opts.deleteEvent === true) {
      await db.update(events).set({ deletedAt: new Date() }).where(eq(events.id, ev.id));
    }
  }
  return postId;
}

describe("selectWarmTelegramPostIds predicate (Phase 9)", () => {
  it("INCLUDES a young (<7d) AND stale (last_polled_at older than 12h) event-attached post", async () => {
    const u = await seedUserDirectly({ email: `tgwarm-inc-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, { publishedAgoDays: 2, lastPolledAgoHours: 18 });
    const warm = await selectWarmTelegramPostIds(new Date());
    expect(warm).toContain(id);
  });

  it("INCLUDES a never-polled young post (bootstrap)", async () => {
    const u = await seedUserDirectly({ email: `tgwarm-null-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, { publishedAgoDays: 1, lastPolledAgoHours: null });
    const warm = await selectWarmTelegramPostIds(new Date());
    expect(warm).toContain(id);
  });

  it("EXCLUDES a fresh post (last_polled_at within 12h — kept warm by the 6h listing poll)", async () => {
    const u = await seedUserDirectly({ email: `tgwarm-fresh-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, { publishedAgoDays: 2, lastPolledAgoHours: 4 });
    const warm = await selectWarmTelegramPostIds(new Date());
    expect(warm).not.toContain(id);
  });

  it("EXCLUDES a post older than the 7d warm window (frozen)", async () => {
    const u = await seedUserDirectly({ email: `tgwarm-old-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, { publishedAgoDays: 10, lastPolledAgoHours: 18 });
    const warm = await selectWarmTelegramPostIds(new Date());
    expect(warm).not.toContain(id);
  });

  it("EXCLUDES terminal not_found / private posts (stop fetching a gone post)", async () => {
    const u = await seedUserDirectly({ email: `tgwarm-term-${uniq()}@t.io` });
    const gone = await seedCandidate(u.id, {
      publishedAgoDays: 2,
      lastPolledAgoHours: 18,
      lastPollStatus: "not_found",
    });
    const priv = await seedCandidate(u.id, {
      publishedAgoDays: 2,
      lastPolledAgoHours: 18,
      lastPollStatus: "private",
    });
    const warm = await selectWarmTelegramPostIds(new Date());
    expect(warm).not.toContain(gone);
    expect(warm).not.toContain(priv);
  });

  it("EXCLUDES a post at the poll_failure_count bound (persistent failure stops churn)", async () => {
    const u = await seedUserDirectly({ email: `tgwarm-bound-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, {
      publishedAgoDays: 2,
      lastPolledAgoHours: 18,
      lastPollStatus: "rate_limited",
      pollFailureCount: env.TELEGRAM_WARM_MAX_FAILURES, // == 5 default
    });
    const warm = await selectWarmTelegramPostIds(new Date());
    expect(warm).not.toContain(id);
  });

  it("respects the 12h staleness boundary exactly (11h excluded, 13h included)", async () => {
    const u = await seedUserDirectly({ email: `tgwarm-edge-${uniq()}@t.io` });
    const justFresh = await seedCandidate(u.id, { publishedAgoDays: 2, lastPolledAgoHours: 11 });
    const justStale = await seedCandidate(u.id, { publishedAgoDays: 2, lastPolledAgoHours: 13 });
    const warm = await selectWarmTelegramPostIds(new Date());
    expect(warm).not.toContain(justFresh);
    expect(warm).toContain(justStale);
  });

  it("EXCLUDES a post with NO alive event (warm refresh is event-attached only)", async () => {
    const u = await seedUserDirectly({ email: `tgwarm-noevt-${uniq()}@t.io` });
    const orphan = await seedCandidate(u.id, {
      publishedAgoDays: 2,
      lastPolledAgoHours: 18,
      attachEvent: false,
    });
    const deleted = await seedCandidate(u.id, {
      publishedAgoDays: 2,
      lastPolledAgoHours: 18,
      deleteEvent: true,
    });
    const warm = await selectWarmTelegramPostIds(new Date());
    expect(warm).not.toContain(orphan);
    expect(warm).not.toContain(deleted);
  });
});

describe("handleTelegramWarmRefresh producer (Phase 9 — free, NO throttle gate)", () => {
  it("enqueues a service_post row per warm post with NO budget gate (Telegram is free)", async () => {
    const u = await seedUserDirectly({ email: `tgwarm-h-ok-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, { publishedAgoDays: 2, lastPolledAgoHours: 18 });

    await handleTelegramWarmRefresh({ id: "tg-warm-job" });

    const rows = await db
      .select({ id: adapterRefreshQueue.id, queueName: adapterRefreshQueue.queueName })
      .from(adapterRefreshQueue)
      .where(eq(sql`${adapterRefreshQueue.payload}->>'post_id'`, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.queueName).toBe("service_post");
  });

  it("does NOT double-enqueue on a second run (skip-if-pending dedup)", async () => {
    const u = await seedUserDirectly({ email: `tgwarm-h-dedup-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, { publishedAgoDays: 2, lastPolledAgoHours: 18 });

    await handleTelegramWarmRefresh({ id: "tg-warm-job-1" });
    await handleTelegramWarmRefresh({ id: "tg-warm-job-2" });

    const rows = await db
      .select({ id: adapterRefreshQueue.id })
      .from(adapterRefreshQueue)
      .where(eq(sql`${adapterRefreshQueue.payload}->>'post_id'`, id));
    expect(rows).toHaveLength(1); // still ONE — the second run skipped the pending row
  });
});
