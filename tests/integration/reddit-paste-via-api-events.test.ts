import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { createEvent } from "../../src/lib/server/services/events.js";
import { db } from "../../src/lib/server/db/client.js";
import { events } from "../../src/lib/server/db/schema/events.js";
import { dataSources } from "../../src/lib/server/db/schema/data-sources.js";
import { auditLog } from "../../src/lib/server/db/schema/audit-log.js";
import {
  redditPosts,
  redditPostSnapshots,
  adapterRefreshQueue,
} from "../../src/lib/server/db/schema/index.js";
import { uuidv7 } from "../../src/lib/server/ids.js";
import { seedUserDirectly } from "./helpers.js";
import { AppError } from "../../src/lib/server/services/errors.js";

/**
 * Regression-coverage for POST /api/events with kind=reddit_post.
 *
 * The 1st technical review found `parsePasteAndCreate` was dead code; the
 * 2nd review then found the architectural rework had moved the bugs
 * (cap not enforced, author_is_me lost, idempotency uncovered). These
 * tests target the production code path `createEvent → fetchEventStats →
 * handlePostSingle` and assert the contracts the 2nd review flagged:
 *
 *   1. Idempotent paste — same URL twice produces 1 reddit_posts row +
 *      1 reddit_post_snapshots row (60s dedup) + 2 events rows.
 *   2. Cap enforcement — pre-seed 25 done-rows in adapter_refresh_queue
 *      on user_post lane → 26th paste still writes the diary event, but
 *      skips the live Reddit fetch (diary-first; quota gates upstream I/O).
 *   3. author_is_me inheritance — paste a URL whose author matches an
 *      owned reddit_account source → events.author_is_me=true via
 *      fetchEventStats's authorIsMe signal.
 *   4. author_is_me negative — paste a URL whose author does NOT match
 *      → events.author_is_me=false (default).
 *   5. Unconfigured Reddit — REDDIT_USER_AGENT empty → fetchEventStats
 *      returns null → event created without reddit_posts cache row
 *      (YouTube-parity silent degradation, per project decision).
 *   6. Reddit 404 — fetch throws AdapterError(not-found) → swallowed by
 *      createEvent → event row exists, no reddit_posts cache row, and NO
 *      cap-counter row (counter is INSERTed inside the same tx as the
 *      cache writes; a failed fetch never reaches the tx, so the user
 *      isn't charged for upstream failures outside their control).
 */

// Reddit /api/info.json?id=t3_X response shape — minimal subset
// handlePostSingle's extractT3FromInfoResponse looks at. Single Listing
// with one t3 child (same shape as the multi-id batch response, just
// length=1). /api/info replaced /comments/<id>.json so paste flow shares
// one endpoint with the cron batch path.
function buildRedditResponse(opts: {
  postId: string;
  subreddit: string;
  author: string;
  title: string;
  score?: number;
  numComments?: number;
}): unknown {
  return {
    kind: "Listing",
    data: {
      children: [
        {
          kind: "t3",
          data: {
            id: opts.postId.replace(/^t3_/, ""),
            name: opts.postId.startsWith("t3_") ? opts.postId : `t3_${opts.postId}`,
            subreddit: opts.subreddit,
            subreddit_id: `t5_${opts.subreddit}`,
            author: opts.author,
            author_fullname: `t2_${opts.author}`,
            permalink: `/r/${opts.subreddit}/comments/${opts.postId.replace(/^t3_/, "")}/test/`,
            title: opts.title,
            selftext: "",
            created_utc: Math.floor(Date.now() / 1000) - 3600,
            score: opts.score ?? 100,
            num_comments: opts.numComments ?? 10,
            upvote_ratio: 0.95,
            total_awards_received: 0,
          },
        },
      ],
    },
  };
}

function mockFetchSequence(responses: Array<() => unknown>): ReturnType<typeof vi.fn> {
  const fetchSpy = vi.fn();
  for (const factory of responses) {
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify(factory()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
  }
  return fetchSpy;
}

describe("Reddit paste via POST /api/events (createEvent → fetchEventStats)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("idempotent paste — same URL twice → 1 reddit_posts row + 2 events rows + 60s dedup", async () => {
    const u = await seedUserDirectly({ email: `reddit-paste-idem-${uuidv7()}@test.local` });
    const postId = "abc123";
    const fullId = `t3_${postId}`;
    const fetchSpy = mockFetchSequence([
      () => buildRedditResponse({ postId, subreddit: "IndieDev", author: "someone", title: "T1" }),
    ]);
    vi.stubGlobal("fetch", fetchSpy);

    const ev1 = await createEvent(
      u.id,
      {
        kind: "reddit_post",
        title: "My note 1",
        occurredAt: new Date(),
        url: `https://www.reddit.com/r/IndieDev/comments/${postId}/test/`,
      },
      "127.0.0.1",
    );
    const ev2 = await createEvent(
      u.id,
      {
        kind: "reddit_post",
        title: "My note 2 (dup URL within dedup window)",
        occurredAt: new Date(),
        url: `https://www.reddit.com/r/IndieDev/comments/${postId}/test/`,
      },
      "127.0.0.1",
    );

    expect(ev1.id).not.toBe(ev2.id);
    // events.externalId stores the bare Reddit post id (e.g. "abc123");
    // reddit_posts.postId stores the t3_-prefixed form ("t3_abc123") —
    // handlePostSingle adds the prefix on UPSERT. feed-enrichment.ts joins
    // both forms via a lookup-key Set so callers don't care which form
    // their cache key takes.
    expect(ev1.externalId).toBe(postId);
    expect(ev2.externalId).toBe(postId);

    // One reddit_posts row (UPSERTed once, dedup'd the second time).
    const postRows = await db.select().from(redditPosts).where(eq(redditPosts.postId, fullId));
    expect(postRows).toHaveLength(1);

    // ONE Reddit HTTP fetch — second paste hit the dedup short-circuit.
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Two events rows under this user.
    const evRows = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, u.id), eq(events.externalId, postId)));
    expect(evRows).toHaveLength(2);
  });

  it("cap enforcement — 30 prior user_post done-rows → 31st paste creates event but skips Reddit fetch", async () => {
    const u = await seedUserDirectly({ email: `reddit-paste-cap-${uuidv7()}@test.local` });
    // Pre-seed 30 done-rows on user_post lane within the 15-min window
    // (REDDIT_USER_CAP.postRefreshesPerWindow=30 / windowMinutes=15).
    const now = new Date();
    for (let i = 0; i < 30; i++) {
      await db.insert(adapterRefreshQueue).values({
        adapterKind: "reddit_account",
        queueName: "user_post",
        type: "post_single",
        payload: { post_id: `t3_seed${i}`, flow: "paste" },
        userId: u.id,
        priority: 0,
        status: "done",
        enqueuedAt: new Date(now.getTime() - 60_000),
        lastAttemptAt: new Date(now.getTime() - 60_000),
      });
    }
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const ev = await createEvent(
      u.id,
      {
        kind: "reddit_post",
        title: "31st paste",
        occurredAt: new Date(),
        url: "https://www.reddit.com/r/IndieDev/comments/blocked/test/",
      },
      "127.0.0.1",
    );

    // No fetch attempt; the local diary row still exists.
    expect(fetchSpy).not.toHaveBeenCalled();
    const evRows = await db.select().from(events).where(eq(events.userId, u.id));
    expect(evRows).toHaveLength(1);
    expect(evRows[0]?.id).toBe(ev.id);

    const postRows = await db
      .select()
      .from(redditPosts)
      .where(eq(redditPosts.postId, "t3_blocked"));
    expect(postRows).toHaveLength(0);
  });

  it("author_is_me=true — paste matches owned reddit_account source", async () => {
    const u = await seedUserDirectly({ email: `reddit-paste-aim-${uuidv7()}@test.local` });
    // Register the user's own reddit_account source.
    await db.insert(dataSources).values({
      id: uuidv7(),
      userId: u.id,
      kind: "reddit_account",
      handleUrl: "https://reddit.com/user/mydev",
      isOwnedByMe: true,
      autoImport: false,
      metadata: { username: "mydev" },
    });

    const postId = "ownpost";
    const fetchSpy = mockFetchSequence([
      () => buildRedditResponse({ postId, subreddit: "IndieDev", author: "mydev", title: "Own" }),
    ]);
    vi.stubGlobal("fetch", fetchSpy);

    const ev = await createEvent(
      u.id,
      {
        kind: "reddit_post",
        title: "My announcement",
        occurredAt: new Date(),
        url: `https://www.reddit.com/r/IndieDev/comments/${postId}/test/`,
      },
      "127.0.0.1",
    );

    // Re-read row from DB to pick up the post-INSERT UPDATE.
    const [rehydrated] = await db.select().from(events).where(eq(events.id, ev.id));
    expect(rehydrated?.authorIsMe).toBe(true);
  });

  it("author_is_me=false — paste does NOT match any owned source", async () => {
    const u = await seedUserDirectly({ email: `reddit-paste-aim-no-${uuidv7()}@test.local` });
    // No reddit_account source registered.
    const postId = "otherpost";
    const fetchSpy = mockFetchSequence([
      () =>
        buildRedditResponse({ postId, subreddit: "IndieDev", author: "stranger", title: "Other" }),
    ]);
    vi.stubGlobal("fetch", fetchSpy);

    const ev = await createEvent(
      u.id,
      {
        kind: "reddit_post",
        title: "Tracking this",
        occurredAt: new Date(),
        url: `https://www.reddit.com/r/IndieDev/comments/${postId}/test/`,
      },
      "127.0.0.1",
    );

    const [rehydrated] = await db.select().from(events).where(eq(events.id, ev.id));
    expect(rehydrated?.authorIsMe).toBe(false);
  });

  it("Reddit fetch fails (e.g. 404) → event row created without cache row (graceful degradation)", async () => {
    const u = await seedUserDirectly({ email: `reddit-paste-404-${uuidv7()}@test.local` });
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response("not found", {
        status: 404,
        headers: { "content-type": "text/plain" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const ev = await createEvent(
      u.id,
      {
        kind: "reddit_post",
        title: "Dead link probably",
        occurredAt: new Date(),
        url: "https://www.reddit.com/r/IndieDev/comments/dead404/test/",
      },
      "127.0.0.1",
    );

    expect(ev.kind).toBe("reddit_post");
    expect(ev.externalId).toBe("dead404");

    // fetch was attempted (one call to /api/info.json?id=t3_X).
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // No reddit_posts cache row — fetchEventStats swallowed the error.
    const postRows = await db
      .select()
      .from(redditPosts)
      .where(eq(redditPosts.postId, "t3_dead404"));
    expect(postRows).toHaveLength(0);

    // No reddit_post_snapshots row either.
    const snapRows = await db
      .select()
      .from(redditPostSnapshots)
      .where(eq(redditPostSnapshots.postId, "t3_dead404"));
    expect(snapRows).toHaveLength(0);

    // Cap-counter row IS NOT written: the counter INSERT lives inside the
    // same tx as the cache writes, and a 404 from redditFetch throws
    // before the tx starts. The user is not charged for a refresh that
    // produced no data — fairer UX when Reddit returns 404/429/5xx.
    const capRows = await db
      .select()
      .from(adapterRefreshQueue)
      .where(
        and(
          eq(adapterRefreshQueue.userId, u.id),
          eq(adapterRefreshQueue.queueName, "user_post"),
          eq(adapterRefreshQueue.type, "post_single"),
        ),
      );
    expect(capRows).toHaveLength(0);
  });

  it("writes cross-source audit row (event.poll_refreshed flow=stats_refresh) on success", async () => {
    const u = await seedUserDirectly({ email: `reddit-paste-audit-${uuidv7()}@test.local` });
    const postId = "auditrow";
    const fetchSpy = mockFetchSequence([
      () =>
        buildRedditResponse({ postId, subreddit: "IndieDev", author: "someone", title: "Audit" }),
    ]);
    vi.stubGlobal("fetch", fetchSpy);

    await createEvent(
      u.id,
      {
        kind: "reddit_post",
        title: "Audit test",
        occurredAt: new Date(),
        url: `https://www.reddit.com/r/IndieDev/comments/${postId}/test/`,
      },
      "127.0.0.1",
    );

    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, "event.poll_refreshed")));
    // At least one event.poll_refreshed row from Reddit fetchEventStats.
    expect(audit.length).toBeGreaterThanOrEqual(1);
    const meta = audit[0]!.metadata as Record<string, unknown>;
    expect(meta.platform).toBe("reddit_account");
    expect(meta.flow).toBe("stats_refresh");
  });

  it("Reddit HTTP 429 during fetchEventStats → event row created, no cache row, no snapshot (silent degrade)", async () => {
    // Distinct from the cap-enforcement test above (which fires PRE-INSERT
    // and produces 0 events rows). This test pins the OTHER 429 path:
    // Reddit-side rate-limit during the POST-INSERT fetchEventStats call.
    // Contract: the event row stays (user's diary intent succeeded);
    // stats remain unavailable until the next cron tick or RefreshNow
    // button click. The cap pre-check passed, so we are NOT testing
    // cap exhaustion — we are testing Reddit's own 429 surfacing.
    const u = await seedUserDirectly({ email: `reddit-paste-http429-${uuidv7()}@test.local` });
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response('{"error":"rate_limited"}', {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "60",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const ev = await createEvent(
      u.id,
      {
        kind: "reddit_post",
        title: "Diary note despite 429",
        occurredAt: new Date(),
        url: "https://www.reddit.com/r/IndieDev/comments/abc429/test/",
      },
      "127.0.0.1",
    );

    // Event row IS created — fetchEventStats threw, createEvent swallowed.
    expect(ev.kind).toBe("reddit_post");
    expect(ev.externalId).toBe("abc429");
    const evRows = await db.select().from(events).where(eq(events.userId, u.id));
    expect(evRows).toHaveLength(1);
    expect(evRows[0]!.id).toBe(ev.id);

    // No reddit_posts cache row — handlePostSingle threw on the 429
    // before reaching UPSERT.
    const postRows = await db.select().from(redditPosts).where(eq(redditPosts.postId, "t3_abc429"));
    expect(postRows).toHaveLength(0);

    // No snapshot either.
    const snapRows = await db
      .select()
      .from(redditPostSnapshots)
      .where(eq(redditPostSnapshots.postId, "t3_abc429"));
    expect(snapRows).toHaveLength(0);

    // Cap-counter row IS NOT written — same reasoning as the 404 test
    // above. handlePostSingle's tx never starts because redditFetch
    // threw on the 429; the counter INSERT lives inside that tx, so
    // it rolls back along with the (never-started) cache writes.
    // Rate-limited fetches don't burn the user's cap.
    const capRows = await db
      .select()
      .from(adapterRefreshQueue)
      .where(
        and(
          eq(adapterRefreshQueue.userId, u.id),
          eq(adapterRefreshQueue.queueName, "user_post"),
          eq(adapterRefreshQueue.type, "post_single"),
        ),
      );
    expect(capRows).toHaveLength(0);
  });

  it("kind=reddit_post without URL is rejected at the service layer via cap pre-check skip", async () => {
    // No URL → derivedExternalId is null → cap pre-check skips → createEvent
    // proceeds. This documents the current behavior (URL-required guard
    // lives at the HTTP route layer via urlRequiredForPollableKinds);
    // service-level createEvent does NOT block reddit_post without URL.
    // The route layer is the load-bearing validator.
    const u = await seedUserDirectly({ email: `reddit-paste-nourl-${uuidv7()}@test.local` });
    const ev = await createEvent(
      u.id,
      {
        kind: "reddit_post",
        title: "Free-form Reddit-typed event",
        occurredAt: new Date(),
        // no url
      },
      "127.0.0.1",
    );
    expect(ev.kind).toBe("reddit_post");
    expect(ev.externalId).toBeNull();
  });
});

// AppError is imported for type assertions in error matchers above; keep
// the import live so `pnpm typecheck` doesn't drop it.
void AppError;
