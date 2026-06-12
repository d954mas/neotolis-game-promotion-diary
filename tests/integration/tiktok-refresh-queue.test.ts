// TikTok per-post Refresh lane (mirrors instagram-refresh-queue) + the Finding 2
// cache-miss recovery.
//
// Manual "Refresh now" enqueues ONE adapter_refresh_queue row per post (queue_name
// "user_post"); the TikTok lane worker claims up to N rows/tick and refreshes EXACTLY
// those posts via the single-video endpoint + writeSnapshot (incl shares — PLAT-02).
//
// FINDING 2 (the load-bearing case): a tiktok_post event created WITHOUT a preview
// keys on the URL-intrinsic aweme id (resolveCachedExternalId's URL fallback — the
// /@handle/video/<id> slug IS the id), so the event is refreshable but has NO
// tiktok_posts cache row. Pre-fix the lane's resolvePermalink cache-missed → silent
// skip → the user paid a cooldown + audit row on Refresh but fetched nothing. The fix
// recovers the canonical permalink from the event's own URL (tiktokParseUrl), so the
// fetch lands AND writeSnapshot self-heals the cache for next time. IG has no such
// state (its media id is not URL-derivable → no-preview events are saved id-less and
// aren't refreshable), so this recovery is TikTok-only.
//
// Integration test — real Postgres via ./helpers.js. The provider's getSocialProvider
// and getSocialSpendToday (claimGate throttle) are mocked; the DB is real.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { NormalizedSinglePost } from "../../src/lib/sources/social-provider.js";

interface ScriptedSinglePost {
  next: NormalizedSinglePost | null;
  throwErr: Error | null;
  calls: Array<{ url: string; origin?: string }>;
}
const single: ScriptedSinglePost = { next: null, throwErr: null, calls: [] };
let spend = { creditsUsed: 0, dailyCap: 1000, prepaidBalance: 5000 };

vi.mock("../../src/lib/sources/tiktok/server/provider/registry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isTikTokConfigured: () => true,
    getSocialProvider: (platform: string) => {
      if (platform !== "tiktok") return null;
      return {
        name: "scrapecreators",
        async fetchPostByUrl(
          _platform: string,
          url: string,
          opts: { origin?: string },
        ): Promise<NormalizedSinglePost | null> {
          single.calls.push({ url, origin: opts.origin });
          if (single.throwErr) throw single.throwErr;
          return single.next;
        },
        async fetchPosts() {
          return { posts: [], nextCursor: null, endOfFeed: true, creditsUsed: 1 };
        },
        async resolveAccount() {
          return { accountId: "acct-rq", displayName: "RQ" };
        },
      };
    },
  };
});

vi.mock("../../src/lib/sources/tiktok/server/quota.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getSocialSpendToday: async () => spend };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { tiktokPosts, tiktokPostSnapshots, adapterRefreshQueue } =
  await import("../../src/lib/server/db/schema/index.js");
const { createEvent } = await import("../../src/lib/server/services/events-mutation.js");
const { tiktokAdapter } = await import("../../src/lib/sources/tiktok/server/index.js");
const { tiktokRefreshQueueTick, __resetTikTokRefreshQueueWorkerForTest } =
  await import("../../src/lib/sources/tiktok/server/handlers/refresh-queue-tick.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

// 19-digit aweme ids — TikTok's id IS the URL slug, so external_id == aweme id.
function awemeId(): string {
  return `79${Math.floor(Math.random() * 1e17)
    .toString()
    .padStart(17, "0")}`.slice(0, 19);
}

function singlePost(
  id: string,
  overrides: Partial<NormalizedSinglePost> = {},
): NormalizedSinglePost {
  return {
    id,
    shortcode: id,
    kind: "short",
    publishedAt: new Date("2026-06-01T12:00:00Z"),
    metrics: { views: 100000, likes: 5000, comments: 200, shares: 4974 },
    caption: "rq caption",
    thumbnailUrl: "https://cdn.tiktokcdn-us.com/cover.awebp",
    ownerId: "6659752019493208069",
    ownerUsername: "stoolpresidente",
    ...overrides,
  };
}

async function snapshotCount(id: string): Promise<number> {
  const rows = await db
    .select({ id: tiktokPostSnapshots.id })
    .from(tiktokPostSnapshots)
    .where(eq(tiktokPostSnapshots.awemeId, id));
  return rows.length;
}

async function postRowCount(id: string): Promise<number> {
  const rows = await db
    .select({ awemeId: tiktokPosts.awemeId })
    .from(tiktokPosts)
    .where(eq(tiktokPosts.awemeId, id));
  return rows.length;
}

async function enqueue(eventId: string, userId: string, id: string): Promise<void> {
  await tiktokAdapter.refreshQueue!.enqueue({
    eventId,
    userId,
    externalId: id,
    eventKind: "tiktok_post",
  });
}

beforeEach(() => {
  single.next = null;
  single.throwErr = null;
  single.calls = [];
  spend = { creditsUsed: 0, dailyCap: 1000, prepaidBalance: 5000 };
  __resetTikTokRefreshQueueWorkerForTest();
});

describe("tiktok per-post refresh lane", () => {
  it("a tick refreshes the queued post from the tiktok_posts cache permalink", async () => {
    const u = await seedUserDirectly({ email: `tkrq-cache-${uniq()}@t.io` });
    const id = awemeId();
    const permalink = `https://www.tiktok.com/@stoolpresidente/video/${id}`;
    await db
      .insert(tiktokPosts)
      .values({ awemeId: id, accountId: "6659752019493208069", permalink, mediaType: "short" })
      .onConflictDoNothing();
    const ev = await createEvent(
      u.id,
      {
        kind: "tiktok_post",
        title: "tk",
        externalId: id,
        occurredAt: new Date("2026-06-02T00:00:00Z").toISOString(),
        gameIds: [],
      },
      "127.0.0.1",
    );
    single.next = singlePost(id);
    await enqueue(ev.id, u.id, id);

    await tiktokRefreshQueueTick();

    expect(single.calls).toHaveLength(1);
    expect(single.calls[0]!.url).toBe(permalink); // fetched the cached permalink
    expect(await snapshotCount(id)).toBe(1);
    const [snap] = await db
      .select()
      .from(tiktokPostSnapshots)
      .where(eq(tiktokPostSnapshots.awemeId, id));
    expect(snap!.shareCount).toBe(4974); // PLAT-02 threaded
  });

  it("FINDING 2: a no-preview event (no cache row) refreshes via the URL aweme id and SELF-HEALS the cache", async () => {
    const u = await seedUserDirectly({ email: `tkrq-nopreview-${uniq()}@t.io` });
    const id = awemeId();
    const url = `https://www.tiktok.com/@stoolpresidente/video/${id}`;

    // Create the event WITHOUT a preview: resolveCachedExternalId falls back to the
    // URL aweme id, so the event is refreshable but there is NO tiktok_posts row.
    const ev = await createEvent(
      u.id,
      {
        kind: "tiktok_post",
        title: "no preview",
        occurredAt: new Date("2026-06-02T00:00:00Z").toISOString(),
        url,
        gameIds: [],
      },
      "127.0.0.1",
    );
    expect(ev.externalId).toBe(id); // keyed on the URL-intrinsic aweme id
    expect(await postRowCount(id)).toBe(0); // no cache row yet

    single.next = singlePost(id);
    await enqueue(ev.id, u.id, id);

    await tiktokRefreshQueueTick();

    // Pre-fix the lane cache-missed and SKIPPED (no fetch). The fix recovers the
    // permalink from the event URL → the fetch lands on the canonical permalink.
    expect(single.calls).toHaveLength(1);
    expect(single.calls[0]!.url).toBe(url);
    expect(single.calls[0]!.origin).toBe("user"); // user_post → user pool

    // The snapshot landed AND the cache row was created (self-heal) so the next
    // refresh hits the fast path.
    expect(await snapshotCount(id)).toBe(1);
    expect(await postRowCount(id)).toBe(1);
    const [cached] = await db.select().from(tiktokPosts).where(eq(tiktokPosts.awemeId, id));
    expect(cached!.permalink).toBe(url);
    expect(cached!.lastPollStatus).toBe("ok");

    // The queue row completed.
    const [row] = await db
      .select({ status: adapterRefreshQueue.status })
      .from(adapterRefreshQueue)
      .where(eq(adapterRefreshQueue.userId, u.id))
      .limit(1);
    expect(row!.status).toBe("done");
  });

  it("a no-preview event with NO url and no cache row still skips gracefully (no fetch)", async () => {
    const u = await seedUserDirectly({ email: `tkrq-nourl-${uniq()}@t.io` });
    const id = awemeId();
    // An event keyed on the aweme id but with no URL (e.g. body-supplied externalId,
    // no preview, no url) → nothing to recover the permalink from → graceful skip.
    const ev = await createEvent(
      u.id,
      {
        kind: "tiktok_post",
        title: "no url",
        externalId: id,
        occurredAt: new Date("2026-06-02T00:00:00Z").toISOString(),
        gameIds: [],
      },
      "127.0.0.1",
    );
    single.next = singlePost(id);
    await enqueue(ev.id, u.id, id);

    await tiktokRefreshQueueTick();

    expect(single.calls).toHaveLength(0); // no permalink resolvable → skip, no fetch
    expect(await snapshotCount(id)).toBe(0);
    const [row] = await db
      .select({ status: adapterRefreshQueue.status })
      .from(adapterRefreshQueue)
      .where(eq(adapterRefreshQueue.userId, u.id))
      .limit(1);
    expect(row!.status).toBe("done"); // row still completes (no orphan pending)
  });

  it("is tenant-scoped: a row whose event belongs to another user is skipped (no fetch)", async () => {
    const owner = await seedUserDirectly({ email: `tkrq-owner-${uniq()}@t.io` });
    const attacker = await seedUserDirectly({ email: `tkrq-atk-${uniq()}@t.io` });
    const id = awemeId();
    const url = `https://www.tiktok.com/@stoolpresidente/video/${id}`;
    const ev = await createEvent(
      owner.id,
      {
        kind: "tiktok_post",
        title: "owned",
        occurredAt: new Date("2026-06-02T00:00:00Z").toISOString(),
        url,
        gameIds: [],
      },
      "127.0.0.1",
    );
    // Enqueue under the ATTACKER pointing at the owner's event.
    await enqueue(ev.id, attacker.id, id);

    await tiktokRefreshQueueTick();

    expect(single.calls).toHaveLength(0); // event not resolvable under attacker → no fetch
    expect(await snapshotCount(id)).toBe(0);
  });
});
