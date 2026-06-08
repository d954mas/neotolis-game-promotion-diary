// Instagram warm auto-refresh — eligibility predicate + producer handler (#70).
//
// selectWarmInstagramPostIds is the cost-bounded selection: event-attached posts
// that are YOUNG (< INSTAGRAM_WARM_WINDOW_DAYS, default 7) AND STALE (last_polled_at
// older than INSTAGRAM_WARM_STALENESS_HOURS, default 22), minus genuinely-terminal
// (not_found/private) and persistently-failing (poll_failure_count >= max) posts.
//
// The crux (#70 P1-A): auth_error is NOT excluded. IG's HTTP seam collapses
// transient + budget-exhaustion into auth_error, so excluding it (as YouTube's
// UNAVAILABLE_POLL_STATUSES does) would freeze a post out of auto-refresh on a
// single blip. Bounded churn via poll_failure_count instead.
//
// Real Postgres via ./helpers.js; selection asserts via toContain on the
// per-test post ids (the predicate is service-wide, so never assert exact arrays).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";

let throttle: "ok" | "eighty" | "ninetyfive" = "ok";
vi.mock("../../src/lib/sources/instagram/server/quota.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getSocialThrottleState: async () => throttle };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { instagramPosts, adapterRefreshQueue, events } =
  await import("../../src/lib/server/db/schema/index.js");
const { createEvent } = await import("../../src/lib/server/services/events-mutation.js");
const { selectWarmInstagramPostIds } =
  await import("../../src/lib/sources/instagram/server/warm-eligibility.js");
const { handleInstagramWarmRefresh } =
  await import("../../src/lib/sources/instagram/server/handlers/warm-refresh.js");

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

/** Seed a public-data instagram_posts row with precise polling state + (by
 *  default) one alive event referencing it. Returns the media id. */
async function seedCandidate(userId: string, opts: SeedOpts): Promise<string> {
  const postId = `warm_${uniq()}`;
  const now = Date.now();
  await db.insert(instagramPosts).values({
    postId,
    permalink: `https://www.instagram.com/p/${uniq()}/`,
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
        kind: "instagram_post",
        title: "warm",
        externalId: postId, // no url → E re-derivation skipped; externalId kept verbatim
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

beforeEach(() => {
  throttle = "ok";
});

describe("selectWarmInstagramPostIds predicate (#70)", () => {
  it("INCLUDES a young + stale event-attached post", async () => {
    const u = await seedUserDirectly({ email: `warm-inc-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, { publishedAgoDays: 2, lastPolledAgoHours: 30 });
    const warm = await selectWarmInstagramPostIds(new Date());
    expect(warm).toContain(id);
  });

  it("EXCLUDES a young post that is still FRESH (kept warm by the free account poll)", async () => {
    const u = await seedUserDirectly({ email: `warm-fresh-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, { publishedAgoDays: 2, lastPolledAgoHours: 1 });
    const warm = await selectWarmInstagramPostIds(new Date());
    expect(warm).not.toContain(id);
  });

  it("EXCLUDES a post older than the warm window (frozen)", async () => {
    const u = await seedUserDirectly({ email: `warm-old-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, { publishedAgoDays: 10, lastPolledAgoHours: 30 });
    const warm = await selectWarmInstagramPostIds(new Date());
    expect(warm).not.toContain(id);
  });

  it("INCLUDES a never-polled young post (bootstrap)", async () => {
    const u = await seedUserDirectly({ email: `warm-null-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, { publishedAgoDays: 1, lastPolledAgoHours: null });
    const warm = await selectWarmInstagramPostIds(new Date());
    expect(warm).toContain(id);
  });

  it("EXCLUDES terminal not_found / private posts (stop paying for a gone post)", async () => {
    const u = await seedUserDirectly({ email: `warm-term-${uniq()}@t.io` });
    const gone = await seedCandidate(u.id, {
      publishedAgoDays: 2,
      lastPolledAgoHours: 30,
      lastPollStatus: "not_found",
    });
    const priv = await seedCandidate(u.id, {
      publishedAgoDays: 2,
      lastPolledAgoHours: 30,
      lastPollStatus: "private",
    });
    const warm = await selectWarmInstagramPostIds(new Date());
    expect(warm).not.toContain(gone);
    expect(warm).not.toContain(priv);
  });

  it("INCLUDES an auth_error post under the failure bound (transient — NOT frozen) (#70 P1-A)", async () => {
    const u = await seedUserDirectly({ email: `warm-auth-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, {
      publishedAgoDays: 2,
      lastPolledAgoHours: 30,
      lastPollStatus: "auth_error", // IG collapses transient/budget here — must self-heal
      pollFailureCount: 1,
    });
    const warm = await selectWarmInstagramPostIds(new Date());
    expect(warm).toContain(id);
  });

  it("EXCLUDES a post at the poll_failure_count bound (persistent failure stops churn)", async () => {
    const u = await seedUserDirectly({ email: `warm-bound-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, {
      publishedAgoDays: 2,
      lastPolledAgoHours: 30,
      lastPollStatus: "auth_error",
      pollFailureCount: 5, // == INSTAGRAM_WARM_MAX_FAILURES default
    });
    const warm = await selectWarmInstagramPostIds(new Date());
    expect(warm).not.toContain(id);
  });

  it("EXCLUDES a post with NO alive event (warm refresh is event-attached only)", async () => {
    const u = await seedUserDirectly({ email: `warm-noevt-${uniq()}@t.io` });
    const orphan = await seedCandidate(u.id, {
      publishedAgoDays: 2,
      lastPolledAgoHours: 30,
      attachEvent: false,
    });
    const deleted = await seedCandidate(u.id, {
      publishedAgoDays: 2,
      lastPolledAgoHours: 30,
      deleteEvent: true,
    });
    const warm = await selectWarmInstagramPostIds(new Date());
    expect(warm).not.toContain(orphan);
    expect(warm).not.toContain(deleted);
  });
});

describe("handleInstagramWarmRefresh producer (#70)", () => {
  it("at throttle 'ok' enqueues a dedup'd service_post row per warm post", async () => {
    const u = await seedUserDirectly({ email: `warm-h-ok-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, { publishedAgoDays: 2, lastPolledAgoHours: 30 });
    throttle = "ok";

    await handleInstagramWarmRefresh({ id: "warm-job" });

    const rows = await db
      .select({ id: adapterRefreshQueue.id })
      .from(adapterRefreshQueue)
      .where(eq(sql`${adapterRefreshQueue.payload}->>'post_id'`, id));
    expect(rows).toHaveLength(1);
  });

  it("at throttle 'eighty' skips entirely (warm is non-essential background spend)", async () => {
    const u = await seedUserDirectly({ email: `warm-h-80-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, { publishedAgoDays: 2, lastPolledAgoHours: 30 });
    throttle = "eighty";

    await handleInstagramWarmRefresh({ id: "warm-job-80" });

    const rows = await db
      .select({ id: adapterRefreshQueue.id })
      .from(adapterRefreshQueue)
      .where(eq(sql`${adapterRefreshQueue.payload}->>'post_id'`, id));
    expect(rows).toHaveLength(0);
  });
});
