// Phase 03.1 Plan 09 — Reddit paste end-to-end (V8 + V9 + V12-paste + V24-partial).
//
// Exercises parsePasteAndCreate against a Reddit POST URL. The plan
// replaced the legacy `reddit_not_yet_supported` 422 short-circuit with a
// full synchronous fetch + UPSERT + INSERT flow (D-RDT-INGEST-REPLACE).
//
// V-row coverage:
//   V8  — paste flow end-to-end: URL → events row kind='reddit_post' +
//          transitive UPSERT into reddit_posts + reddit_subreddits_cache
//          + reddit_users_cache + reddit_post_snapshots.
//   V9  — author_is_me inheritance: owned reddit_account source whose
//          metadata.username matches the pasted post's author → events.
//          author_is_me=true. Negative complement: unowned author → false.
//   V12-paste — exhausted post-refresh cap → 429
//                'reddit_post_quota_exhausted' (D-RDT-CAP-POST).
//   V24-partial — empty REDDIT_USER_AGENT → 422 'reddit_not_configured'.
//                  Covered explicitly in tests/integration/ingest.test.ts
//                  (the default test-env state); the cap + handlePostSingle
//                  paths in THIS file run with a stubbed UA.
//
// Real Postgres via the integration service container — never mocks the DB.
// fetch is stubbed so /comments/<id>.json deterministically returns the
// canned t3 payload without touching Reddit.
//
// Env-handling: env.REDDIT_USER_AGENT is "" by default in the integration
// test setup (no env wiring). We mutate the env object directly (it's
// `as const` only at the type level — runtime is plain) so credentials.ts
// + http.ts see a configured UA. Each test restores the original empty
// value in afterEach.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sql, and, eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import { env } from "../../src/lib/server/config/env.js";
import { parsePasteAndCreate } from "../../src/lib/server/services/ingest.js";
import { events } from "../../src/lib/server/db/schema/events.js";
import { dataSources } from "../../src/lib/server/db/schema/data-sources.js";
import {
  redditPosts,
  redditUsersCache,
  redditSubredditsCache,
  redditPostSnapshots,
  redditRefreshQueue,
} from "../../src/lib/sources/reddit/server/schema/index.js";
import { user } from "../../src/lib/server/db/schema/auth.js";
import { uuidv7 } from "../../src/lib/server/ids.js";

// A canned /comments/abc.json shape. Reddit returns a two-element array:
// [submissionListing, commentsListing]. handlePostSingle only consumes
// the t3 child at submissionListing.data.children[0].data, so the comments
// listing can be a stub.
const CANNED_POST_ID = "abcdef";
const CANNED_AUTHOR = "operator-handle";
const CANNED_SUBREDDIT = "IndieDev";
// Fixed Unix epoch for deterministic occurredAt assertions. 1746662400 =
// 2025-05-08T00:00:00Z; well within "Active" tier for the snapshot
// classifier but our test focuses on the events row creation, not
// tier classification.
const CANNED_CREATED_UTC = 1746662400;

const CANNED_COMMENTS_RESPONSE = [
  {
    kind: "Listing",
    data: {
      children: [
        {
          kind: "t3",
          data: {
            id: CANNED_POST_ID,
            name: `t3_${CANNED_POST_ID}`,
            subreddit: CANNED_SUBREDDIT,
            subreddit_id: "t5_xxx",
            author: CANNED_AUTHOR,
            author_fullname: "t2_yyy",
            permalink: `/r/${CANNED_SUBREDDIT}/comments/${CANNED_POST_ID}/my-first-paste/`,
            url: `https://www.reddit.com/r/${CANNED_SUBREDDIT}/comments/${CANNED_POST_ID}/my-first-paste/`,
            title: "My first paste",
            selftext: "",
            is_self: true,
            created_utc: CANNED_CREATED_UTC,
            score: 5,
            num_comments: 1,
            upvote_ratio: 0.85,
            total_awards_received: 0,
            gilded: 0,
            link_flair_text: null,
            over_18: false,
            spoiler: false,
            stickied: false,
            locked: false,
            archived: false,
            removed_by_category: null,
            crosspost_parent: null,
          },
        },
      ],
    },
  },
  { kind: "Listing", data: { children: [] } },
];

const VALID_UA = "node:com.neotolis.gpd:0.1.0 (by /u/operator)";

/** Mutate env.REDDIT_USER_AGENT directly. env is `as const` at the type
 *  level only; runtime is plain and credentials.ts re-reads on every
 *  call, so this flip is enough to flip isRedditConfigured() between
 *  tests without re-importing modules. */
function setRedditUa(value: string): void {
  (env as { REDDIT_USER_AGENT: string }).REDDIT_USER_AGENT = value;
}

/** Build a Response object the fetch stub returns. handlePostSingle's
 *  redditFetch wrapper checks `.ok` and parses JSON. A fresh Response
 *  per call is required because the body stream is single-shot
 *  (TypeError: Body has already been read on the second consumer). */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Wrap jsonResponse in a mockImplementation so each fetch call gets a
 *  fresh Response. mockResolvedValue caches the resolved value and
 *  re-yields the SAME instance — the second call sees a consumed body. */
function stubFetchOk(body: unknown): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(body)));
}

// Module-level user ids — afterEach TRUNCATE wipes everything between
// specs, so each beforeEach re-seeds the SAME ids. Stable id values keep
// the failure detail consistent (the random-suffix shape made debugging
// FK-vs-cascade interactions noisier than the test itself).
const USER_ID_A = "reddit-paste-user-A";
const USER_ID_B = "reddit-paste-user-B";

describe("Reddit paste end-to-end (Phase 03.1 plan 09 — V8 + V9 + V12-paste + V24-partial)", () => {
  const originalUa = env.REDDIT_USER_AGENT;

  beforeEach(async () => {
    await db.insert(user).values([
      { id: USER_ID_A, email: `${USER_ID_A}@test.local`, name: USER_ID_A, emailVerified: true },
      { id: USER_ID_B, email: `${USER_ID_B}@test.local`, name: USER_ID_B, emailVerified: true },
    ]);
    setRedditUa(VALID_UA);
  });

  afterEach(() => {
    setRedditUa(originalUa);
    vi.unstubAllGlobals();
  });

  it("V8: paste flow creates event + transitively UPSERTs caches", async () => {
    vi.stubGlobal("fetch", stubFetchOk(CANNED_COMMENTS_RESPONSE));

    const result = await parsePasteAndCreate(
      USER_ID_A,
      null,
      `https://www.reddit.com/r/${CANNED_SUBREDDIT}/comments/${CANNED_POST_ID}/my-first-paste/`,
      "127.0.0.1",
    );
    expect(result.kind).toBe("event_created");

    // events row.
    const eventRows = await db.select().from(events).where(eq(events.id, result.eventId));
    expect(eventRows).toHaveLength(1);
    const evt = eventRows[0]!;
    expect(evt.kind).toBe("reddit_post");
    expect(evt.externalId).toBe(`t3_${CANNED_POST_ID}`);
    expect(evt.title).toBe("My first paste");
    expect(evt.url).toBe(
      `https://www.reddit.com/r/${CANNED_SUBREDDIT}/comments/${CANNED_POST_ID}/my-first-paste/`,
    );
    // occurredAt mirrors created_utc.
    expect(evt.occurredAt.getTime()).toBe(CANNED_CREATED_UTC * 1000);
    // userA has no owned reddit_account → author_is_me=false.
    expect(evt.authorIsMe).toBe(false);
    // metadata carries subreddit + author for downstream feed rendering.
    const meta = evt.metadata as { subreddit?: string; author?: string };
    expect(meta.subreddit).toBe(CANNED_SUBREDDIT);
    expect(meta.author).toBe(CANNED_AUTHOR);

    // reddit_posts UPSERT.
    const posts = await db
      .select()
      .from(redditPosts)
      .where(eq(redditPosts.postId, `t3_${CANNED_POST_ID}`));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.subreddit).toBe(CANNED_SUBREDDIT);
    expect(posts[0]!.author).toBe(CANNED_AUTHOR);

    // reddit_subreddits_cache UPSERT (cold-cache transitive populate).
    const subs = await db
      .select()
      .from(redditSubredditsCache)
      .where(eq(redditSubredditsCache.name, CANNED_SUBREDDIT));
    expect(subs).toHaveLength(1);

    // reddit_users_cache UPSERT (cold-cache transitive populate).
    const users = await db
      .select()
      .from(redditUsersCache)
      .where(eq(redditUsersCache.username, CANNED_AUTHOR));
    expect(users).toHaveLength(1);

    // One reddit_post_snapshots row written for this minute.
    const snaps = await db
      .select()
      .from(redditPostSnapshots)
      .where(eq(redditPostSnapshots.postId, `t3_${CANNED_POST_ID}`));
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.score).toBe(5);
    expect(snaps[0]!.numComments).toBe(1);
  });

  it("V9: author_is_me=true when an owned reddit_account source matches the post's author", async () => {
    // Seed userA with an owned reddit_account source whose metadata.username
    // matches the canned author.
    await db.insert(dataSources).values({
      id: uuidv7(),
      userId: USER_ID_A,
      kind: "reddit_account",
      handleUrl: `https://www.reddit.com/user/${CANNED_AUTHOR}`,
      displayName: CANNED_AUTHOR,
      isOwnedByMe: true,
      autoImport: true,
      metadata: { username: CANNED_AUTHOR },
    });

    vi.stubGlobal("fetch", stubFetchOk(CANNED_COMMENTS_RESPONSE));

    const result = await parsePasteAndCreate(
      USER_ID_A,
      null,
      `https://www.reddit.com/r/${CANNED_SUBREDDIT}/comments/${CANNED_POST_ID}/title/`,
      "127.0.0.1",
    );

    const eventRows = await db.select().from(events).where(eq(events.id, result.eventId));
    expect(eventRows[0]!.authorIsMe).toBe(true);
  });

  it("V9-negative: author_is_me=false when no owned source matches", async () => {
    // Seed userB with an UNRELATED owned source — must not match
    // CANNED_AUTHOR. Also seed an owned source that's been soft-deleted —
    // must not inherit either.
    await db.insert(dataSources).values([
      {
        id: uuidv7(),
        userId: USER_ID_B,
        kind: "reddit_account",
        handleUrl: "https://www.reddit.com/user/someone-else",
        displayName: "someone-else",
        isOwnedByMe: true,
        autoImport: true,
        metadata: { username: "someone-else" },
      },
      {
        id: uuidv7(),
        userId: USER_ID_B,
        kind: "reddit_account",
        handleUrl: `https://www.reddit.com/user/${CANNED_AUTHOR}-old`,
        displayName: `${CANNED_AUTHOR}-old`,
        isOwnedByMe: true,
        autoImport: true,
        metadata: { username: CANNED_AUTHOR },
        deletedAt: new Date(),
      },
    ]);

    vi.stubGlobal("fetch", stubFetchOk(CANNED_COMMENTS_RESPONSE));

    const result = await parsePasteAndCreate(
      USER_ID_B,
      null,
      `https://www.reddit.com/r/${CANNED_SUBREDDIT}/comments/${CANNED_POST_ID}/title/`,
      "127.0.0.1",
    );
    const eventRows = await db.select().from(events).where(eq(events.id, result.eventId));
    expect(eventRows[0]!.authorIsMe).toBe(false);
  });

  it("V9-negative-2: author_is_me=false when matching source is is_owned_by_me=false (blogger track)", async () => {
    // Tracking-someone-else's account (is_owned_by_me=false) must NOT
    // inherit author_is_me. The user is watching a blogger; the blogger's
    // posts are not "me-posted".
    await db.insert(dataSources).values({
      id: uuidv7(),
      userId: USER_ID_A,
      kind: "reddit_account",
      handleUrl: `https://www.reddit.com/user/${CANNED_AUTHOR}`,
      displayName: CANNED_AUTHOR,
      isOwnedByMe: false,
      autoImport: true,
      metadata: { username: CANNED_AUTHOR },
    });

    vi.stubGlobal("fetch", stubFetchOk(CANNED_COMMENTS_RESPONSE));

    const result = await parsePasteAndCreate(
      USER_ID_A,
      null,
      `https://www.reddit.com/r/${CANNED_SUBREDDIT}/comments/${CANNED_POST_ID}/title/`,
      "127.0.0.1",
    );
    const eventRows = await db.select().from(events).where(eq(events.id, result.eventId));
    expect(eventRows[0]!.authorIsMe).toBe(false);
  });

  it("V24-partial: empty REDDIT_USER_AGENT → 422 reddit_not_configured (no row inserted, no HTTP)", async () => {
    setRedditUa("");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      parsePasteAndCreate(
        USER_ID_A,
        null,
        `https://www.reddit.com/r/${CANNED_SUBREDDIT}/comments/${CANNED_POST_ID}/title/`,
        "127.0.0.1",
      ),
    ).rejects.toMatchObject({ status: 422, code: "reddit_not_configured" });

    // No events row, no HTTP call (pre-flight aborts BEFORE the cap check
    // or handlePostSingle).
    const rows = await db.select().from(events).where(eq(events.userId, USER_ID_A));
    expect(rows).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("V12-paste: 25 prior user_post rows within 5min → 26th paste throws 429 reddit_post_quota_exhausted", async () => {
    // Seed 25 user_post rows in reddit_refresh_queue within the last
    // 5 minutes for userA. The cap-counter in checkRedditUserCap reads
    // reddit_refresh_queue WHERE user_id=$user AND queue_name='user_post'
    // AND enqueued_at > NOW() - INTERVAL '5 minutes'.
    const rows = Array.from({ length: 25 }, (_, i) => ({
      queueName: "user_post",
      type: "post_single" as const,
      payload: { post_id: `seed-${i}` },
      userId: USER_ID_A,
      priority: 1,
      status: "done",
    }));
    await db.insert(redditRefreshQueue).values(rows);

    // fetch should NEVER fire — cap check happens BEFORE handlePostSingle.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      parsePasteAndCreate(
        USER_ID_A,
        null,
        `https://www.reddit.com/r/${CANNED_SUBREDDIT}/comments/${CANNED_POST_ID}/title/`,
        "127.0.0.1",
      ),
    ).rejects.toMatchObject({ status: 429, code: "reddit_post_quota_exhausted" });

    // No events row created.
    const eventRows = await db.select().from(events).where(eq(events.userId, USER_ID_A));
    expect(eventRows).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Audit row written by enforceRedditUserCap → writeRedditCapExhaustedAudit.
    const auditRows = await db.execute(sql`
      SELECT action, metadata FROM audit_log
      WHERE user_id = ${USER_ID_A} AND action = 'reddit.cap_exhausted'
    `);
    expect((auditRows as unknown as { rows: Array<unknown> }).rows.length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it("V8: idempotent paste — pasting the same Reddit URL twice yields ONE reddit_posts row + 2 events rows", async () => {
    // events do NOT have a paste-side dedup UNIQUE index any more (the
    // (user_id, kind, external_id) unique constraint was dropped in
    // migration 0013 — see services/events.ts L429 comment). Two pastes
    // produce two distinct events rows, but reddit_posts UPSERTs into
    // the same row by PK (post_id).
    vi.stubGlobal("fetch", stubFetchOk(CANNED_COMMENTS_RESPONSE));

    const url = `https://www.reddit.com/r/${CANNED_SUBREDDIT}/comments/${CANNED_POST_ID}/title/`;
    const r1 = await parsePasteAndCreate(USER_ID_A, null, url, "127.0.0.1");
    const r2 = await parsePasteAndCreate(USER_ID_A, null, url, "127.0.0.1");
    expect(r1.kind).toBe("event_created");
    expect(r2.kind).toBe("event_created");
    expect(r1.eventId).not.toBe(r2.eventId);

    const eventRows = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, USER_ID_A), eq(events.externalId, `t3_${CANNED_POST_ID}`)));
    expect(eventRows).toHaveLength(2);

    const posts = await db
      .select()
      .from(redditPosts)
      .where(eq(redditPosts.postId, `t3_${CANNED_POST_ID}`));
    expect(posts).toHaveLength(1);
  });
});
