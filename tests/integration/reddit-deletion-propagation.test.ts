// Reddit deletion propagation (D-06 Variant A — Phase 12, Plan 12-05). Real Postgres;
// the provider fetch is mocked. Proves BOTH halves of the GDPR control:
//   1. DETECT (Variant A): a tracked post absent from a COMPLETED walk (within the
//      walked window) gets deletion_detected_at; a post that REAPPEARS in a later walk
//      gets it CLEARED (self-correcting, so a transient walk gap never purges); a post
//      OLDER than the walked window is NOT marked.
//   2. PURGE: the daily zero-HTTP cron NULLs author/author_fullname after the 48h grace
//      and writes the reddit.deletion_propagated audit IN-TX via writeAuditTx (the
//      tx-aware audit.ts API, NOT the db-bound writeAudit — pool-deadlock); within-grace
//      is not purged; already-purged is idempotent (no re-audit); the title/body diary
//      context survives.
//
// Requirements: PLAT-04 / T-12-05-I / T-12-05-Tx.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { RedditFeedPage } from "../../src/lib/sources/reddit/server/normalize.js";

const provider = { pages: [] as RedditFeedPage[] };
function emptyPage(): RedditFeedPage {
  return {
    posts: [],
    nextCursor: null,
    endOfFeed: true,
    creditsUsed: 1,
    owner: null,
    droppedCount: 0,
  };
}

vi.mock("../../src/lib/sources/reddit/server/provider/registry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isRedditConfigured: () => true,
    getSocialProvider: (platform: string) =>
      platform === "reddit" ? ({ name: "scrapecreators-reddit" } as never) : null,
  };
});
vi.mock(
  "../../src/lib/sources/reddit/server/provider/scrapecreators-reddit.js",
  async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
      ...actual,
      fetchRedditFeedPage: async (): Promise<RedditFeedPage> =>
        provider.pages.shift() ?? emptyPage(),
    };
  },
);

const { db } = await import("../../src/lib/server/db/client.js");
const { env } = await import("../../src/lib/server/config/env.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { user } = await import("../../src/lib/server/db/schema/auth.js");
const { auditLog } = await import("../../src/lib/server/db/schema/audit-log.js");
const { redditPosts } = await import("../../src/lib/server/db/schema/index.js");
const { normalizeRedditFeed } = await import("../../src/lib/sources/reddit/server/normalize.js");
const { handleBackfillAccount } =
  await import("../../src/lib/sources/reddit/server/handlers/backfill-account.js");
const { handleDeletionPropagationCron } =
  await import("../../src/lib/sources/reddit/server/handlers/deletion-propagation-cron.js");
const { resetSocialDailyCap } = await import("../../src/lib/sources/reddit/server/quota.js");
const { writeRedditBackfillState } =
  await import("../../src/lib/sources/reddit/server/backfill-state.js");

const DAY = 86_400_000;
const uniq = (): string => Math.random().toString(36).slice(2, 8);

function makePost(shortId: string, daysAgo: number, author: string, subreddit: string) {
  return {
    name: `t3_${shortId}`,
    id: shortId,
    author,
    author_fullname: `t2_${author}`,
    subreddit,
    title: `Devlog ${shortId}`,
    selftext: "the body excerpt",
    score: 5,
    num_comments: 2,
    created_utc: Math.floor((Date.now() - daysAgo * DAY) / 1000),
    permalink: `/r/${subreddit}/comments/${shortId}/devlog/`,
  };
}
function walkPage(posts: unknown[]): RedditFeedPage {
  return normalizeRedditFeed({ success: true, posts, after: null });
}

async function seedAccountSource(handle: string): Promise<void> {
  const u = await seedUserDirectly({ email: `rdt-del-${uniq()}@t.io` });
  await db.insert(dataSources).values({
    userId: u.id,
    kind: "reddit_account",
    handleUrl: `https://www.reddit.com/user/${handle}`,
    channelId: handle,
    isOwnedByMe: true,
    autoImport: true,
    metadata: { handle },
  });
}

async function seedTrackedPost(shortId: string, daysAgo: number, author: string): Promise<void> {
  await db.insert(redditPosts).values({
    postId: `t3_${shortId}`,
    subredditSlug: "gamedev",
    author,
    authorFullname: `t2_${author}`,
    title: `Devlog ${shortId}`,
    caption: "the body excerpt",
    publishedAt: new Date(Date.now() - daysAgo * DAY),
    lastPolledAt: new Date(Date.now() - daysAgo * DAY),
    lastPollStatus: "ok",
  });
}

async function readPost(shortId: string) {
  const [row] = await db
    .select()
    .from(redditPosts)
    .where(eq(redditPosts.postId, `t3_${shortId}`))
    .limit(1);
  return row;
}

beforeEach(() => {
  provider.pages = [];
});

describe("reddit deletion propagation (D-06 Variant A — Phase 12)", () => {
  it("[12-05] disappearance-from-walk flags a WITHIN-WINDOW post; an OLDER-than-window post is NOT flagged", async () => {
    const handle = `del_${uniq()}`;
    const A = `a${uniq()}`,
      B = `b${uniq()}`,
      C = `c${uniq()}`,
      D = `d${uniq()}`;
    await seedAccountSource(handle);
    // Tracked: A@3d, B@2d, C@1d (all within the window), D@30d (older than the window).
    await seedTrackedPost(A, 3, handle);
    await seedTrackedPost(B, 2, handle);
    await seedTrackedPost(C, 1, handle);
    await seedTrackedPost(D, 30, handle);

    // The current feed returns C + A (B disappeared). oldestSeen = A@3d → walked window
    // = [3d ago, now]. B@2d is inside it + absent → flagged. D@30d is older → not a candidate.
    provider.pages = [
      walkPage([makePost(C, 1, handle, "gamedev"), makePost(A, 3, handle, "gamedev")]),
    ];

    await handleBackfillAccount({
      data: {
        kind: "reddit_account",
        channelKey: handle,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "auto_passive",
      },
    });

    expect(
      (await readPost(B))!.deletionDetectedAt,
      "B disappeared within window → flagged",
    ).not.toBeNull();
    expect(
      (await readPost(D))!.deletionDetectedAt,
      "D older than walked window → NOT flagged",
    ).toBeNull();
    expect((await readPost(A))!.deletionDetectedAt, "A alive → not flagged").toBeNull();
    expect((await readPost(C))!.deletionDetectedAt, "C alive → not flagged").toBeNull();
  });

  it("[12-05] a post that REAPPEARS in a later walk has deletion_detected_at CLEARED (before the grace)", async () => {
    const handle = `del_${uniq()}`;
    const A = `a${uniq()}`,
      B = `b${uniq()}`;
    await seedAccountSource(handle);
    await seedTrackedPost(A, 3, handle);
    await seedTrackedPost(B, 2, handle);

    // Walk 1: B absent → flagged.
    provider.pages = [walkPage([makePost(A, 3, handle, "gamedev")])];
    await handleBackfillAccount({
      data: {
        kind: "reddit_account",
        channelKey: handle,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "auto_passive",
      },
    });
    expect((await readPost(B))!.deletionDetectedAt).not.toBeNull();

    // Walk 2: B reappears (alive) → writeSnapshot clears the flag.
    provider.pages = [
      walkPage([makePost(A, 3, handle, "gamedev"), makePost(B, 2, handle, "gamedev")]),
    ];
    await handleBackfillAccount({
      data: {
        kind: "reddit_account",
        channelKey: handle,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "auto_passive",
      },
    });
    expect((await readPost(B))!.deletionDetectedAt, "reappeared post is un-flagged").toBeNull();
  });

  it("[12-05] mixed-case author: disappearance detection matches case-insensitively (LOWER(author)=channelKey)", async () => {
    // Reddit stores the author verbatim (case-preserving), but channelKey is lowercased.
    // Regression guard: without LOWER() the reconcile matches ZERO rows for any username
    // with an uppercase letter (e.g. "GallowBoob") → deletion detection silently dead.
    const Author = `Gallow${uniq()}`; // has uppercase — the failing case
    const channelKey = Author.toLowerCase();
    const A = `a${uniq()}`,
      B = `b${uniq()}`;
    await seedAccountSource(channelKey);
    await seedTrackedPost(A, 3, Author); // stored verbatim, mixed case
    await seedTrackedPost(B, 2, Author);

    // Feed returns only A (B disappeared); the returned post carries the mixed-case author.
    provider.pages = [walkPage([makePost(A, 3, Author, "gamedev")])];
    await handleBackfillAccount({
      data: {
        kind: "reddit_account",
        channelKey,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "auto_passive",
      },
    });

    expect(
      (await readPost(B))!.deletionDetectedAt,
      "mixed-case author B flagged via LOWER match",
    ).not.toBeNull();
    expect((await readPost(A))!.deletionDetectedAt, "A alive → not flagged").toBeNull();
  });

  it("[12-05] a RESUMED deep tick does NOT reconcile — earlier-tick ALIVE posts are not false-purged", async () => {
    // Regression guard for the resumed/multi-tick false-purge: a deep tick that resumes
    // from a persisted cursor walks only OLDER pages this invocation; its seenIds miss the
    // newer alive posts an earlier tick collected. Reconciling [oldestSeen, now] would
    // false-mark them deleted → 48h later their author gets GDPR-purged. startedFromTop
    // guards against it: a pass that did not start at the top must not reconcile.
    const handle = `del_${uniq()}`;
    const A = `a${uniq()}`,
      Bp = `b${uniq()}`,
      C = `c${uniq()}`;
    await seedAccountSource(handle);
    // "Tick 1" already collected the two newest posts (alive) + persisted a resume cursor.
    await seedTrackedPost(A, 1, handle);
    await seedTrackedPost(Bp, 2, handle);
    await writeRedditBackfillState("reddit_account", handle, {
      cursor: "resume-cursor-c1",
      complete: false,
      collected: 2,
      operatorPaused: false,
      deepTargetIso: null,
      emptyPasses: 0,
      notFoundPasses: 0,
    });

    // Tick 2 resumes deep + returns only an OLDER page (C@10d), reaching end-of-feed.
    provider.pages = [walkPage([makePost(C, 10, handle, "gamedev")])];
    await handleBackfillAccount({
      data: {
        kind: "reddit_account",
        channelKey: handle,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "auto_passive",
        forceDeep: true,
      },
    });

    expect((await readPost(A))!.deletionDetectedAt, "tick-1 alive A not false-purged").toBeNull();
    expect((await readPost(Bp))!.deletionDetectedAt, "tick-1 alive B not false-purged").toBeNull();
    expect((await readPost(C))!.deletionDetectedAt, "C alive → not flagged").toBeNull();
  });

  it("[review-P2] the purge leaves NO author-derivable residue: permalink, u_<name> slug, event url + event metadata are all scrubbed", async () => {
    // The pre-fix purge nulled only author/author_fullname/deletion_detected_by, so for a
    // PROFILE post the username stayed in plain sight in four derived places. The policy is
    // "anonymize every author-derivable field, keep the diary content" — assert it end to
    // end, including that the rewritten link still parses as a reddit_post URL (otherwise
    // validateEventInput would 422 every later PATCH of that event).
    const { redditParsePostUrl } = await import("../../src/lib/sources/reddit/server/url.js");
    const u = await seedUserDirectly({ email: `rdt-scrub-${uniq()}@t.io` });
    const author = `Scrub${uniq()}`;
    const profileId = `pr${uniq()}`;
    const communityId = `cm${uniq()}`;
    const profileUrl = `https://www.reddit.com/user/${author}/comments/${profileId}/my_devlog/`;
    const communityUrl = `https://www.reddit.com/r/gamedev/comments/${communityId}/my_devlog/`;

    await db.insert(redditPosts).values([
      {
        postId: `t3_${profileId}`,
        // A profile post lives in the pseudo-subreddit u_<name> — the slug IS the username.
        subredditSlug: `u_${author.toLowerCase()}`,
        permalink: profileUrl,
        author,
        authorFullname: `t2_${author}`,
        title: "Profile devlog",
        caption: "the body excerpt",
        publishedAt: new Date(Date.now() - 5 * DAY),
        lastPollStatus: "ok",
        deletionDetectedAt: new Date(Date.now() - 49 * 3_600_000),
        deletionDetectedBy: `reddit_account:${author.toLowerCase()}`,
      },
      {
        postId: `t3_${communityId}`,
        subredditSlug: "gamedev",
        permalink: communityUrl,
        author,
        authorFullname: `t2_${author}`,
        title: "Community devlog",
        publishedAt: new Date(Date.now() - 5 * DAY),
        lastPollStatus: "ok",
        deletionDetectedAt: new Date(Date.now() - 49 * 3_600_000),
        deletionDetectedBy: `reddit_subreddit:gamedev`,
      },
    ]);
    const [profileEvent] = await db
      .insert(events)
      .values({
        userId: u.id,
        kind: "reddit_post",
        occurredAt: new Date(Date.now() - 5 * DAY),
        title: "Profile devlog",
        url: profileUrl,
        externalId: `t3_${profileId}`,
        metadata: { subreddit: `u_${author.toLowerCase()}` },
      })
      .returning({ id: events.id });
    const [communityEvent] = await db
      .insert(events)
      .values({
        userId: u.id,
        kind: "reddit_post",
        occurredAt: new Date(Date.now() - 5 * DAY),
        title: "Community devlog",
        url: communityUrl,
        externalId: `t3_${communityId}`,
        metadata: { subreddit: "gamedev" },
      })
      .returning({ id: events.id });

    const res = await handleDeletionPropagationCron();
    expect(res.purged).toBeGreaterThanOrEqual(2);

    const profilePost = await readPost(profileId);
    expect(profilePost!.author).toBeNull();
    expect(profilePost!.authorFullname).toBeNull();
    expect(profilePost!.deletionDetectedBy).toBeNull();
    expect(profilePost!.permalink, "the /user/<name>/ segment is gone").toBe(
      `https://www.reddit.com/comments/${profileId}`,
    );
    expect(profilePost!.subredditSlug, "the u_<name> pseudo-slug is gone").toBeNull();
    expect(profilePost!.title, "diary content survives").toBe("Profile devlog");
    expect(profilePost!.caption).toBe("the body excerpt");

    const [scrubbedEvent] = await db
      .select({ url: events.url, metadata: events.metadata, title: events.title })
      .from(events)
      .where(eq(events.id, profileEvent!.id));
    expect(scrubbedEvent!.url).toBe(`https://www.reddit.com/comments/${profileId}`);
    expect((scrubbedEvent!.metadata as { subreddit?: unknown }).subreddit).toBeNull();
    expect(scrubbedEvent!.title, "the user's own diary title is untouched").toBe("Profile devlog");
    expect(
      redditParsePostUrl(scrubbedEvent!.url!),
      "the anonymized url still parses as a reddit_post (PATCH stays possible)",
    ).not.toBeNull();

    // Nothing in a COMMUNITY post's url/slug identifies the author, so those stay as-is.
    const communityPost = await readPost(communityId);
    expect(communityPost!.author, "author still nulled").toBeNull();
    expect(communityPost!.permalink, "an /r/ permalink carries no author → untouched").toBe(
      communityUrl,
    );
    expect(communityPost!.subredditSlug).toBe("gamedev");
    const [keptEvent] = await db
      .select({ url: events.url, metadata: events.metadata })
      .from(events)
      .where(eq(events.id, communityEvent!.id));
    expect(keptEvent!.url).toBe(communityUrl);
    expect((keptEvent!.metadata as { subreddit?: unknown }).subreddit).toBe("gamedev");

    // Idempotent: a second tick finds no residue left to scrub.
    expect((await handleDeletionPropagationCron()).purged).toBe(0);

    // Belt: the username appears NOWHERE in the purged post's row or its event.
    const residue = JSON.stringify([profilePost, scrubbedEvent]).toLowerCase();
    expect(residue).not.toContain(author.toLowerCase());
  });

  it("[12-05] the purge cron NULLs author/author_fullname after 48h + writes the in-tx audit; title/body survive; within-grace + idempotent", async () => {
    const operatorEmail = `rdt-op-${uniq()}@test.local`;
    const operatorId = `usr-${uniq()}`;
    await db.insert(user).values({
      id: operatorId,
      name: "rdt-op",
      email: operatorEmail,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const savedAllowlist = env.ADMIN_EMAIL_ALLOWLIST;
    (env as { ADMIN_EMAIL_ALLOWLIST: Set<string> }).ADMIN_EMAIL_ALLOWLIST = new Set([
      operatorEmail.toLowerCase(),
    ]);
    await resetSocialDailyCap(); // clear the cached operator id so the seeded operator resolves

    try {
      const handle = `del_${uniq()}`;
      const past = `p${uniq()}`,
        grace = `g${uniq()}`,
        bare = `f${uniq()}`;
      // `past` detected >48h ago (eligible); `grace` detected 1h ago (within grace);
      // `bare` past-grace with author ALREADY null but author_fullname still set
      // (review fix: the purge guard must cover every identity column independently).
      await seedTrackedPost(past, 5, handle);
      await seedTrackedPost(grace, 5, handle);
      await seedTrackedPost(bare, 5, handle);
      await db
        .update(redditPosts)
        .set({
          deletionDetectedAt: new Date(Date.now() - 49 * 3_600_000),
          // The account-walk subject key IS the author's username — the purge must
          // erase it too (review fix), not just author/author_fullname.
          deletionDetectedBy: `reddit_account:${handle}`,
        })
        .where(eq(redditPosts.postId, `t3_${past}`));
      await db
        .update(redditPosts)
        .set({ deletionDetectedAt: new Date(Date.now() - 3_600_000) })
        .where(eq(redditPosts.postId, `t3_${grace}`));
      await db
        .update(redditPosts)
        .set({
          deletionDetectedAt: new Date(Date.now() - 49 * 3_600_000),
          author: null,
        })
        .where(eq(redditPosts.postId, `t3_${bare}`));

      const res = await handleDeletionPropagationCron();
      expect(res.purged).toBeGreaterThanOrEqual(2);

      const purged = await readPost(past);
      expect(purged!.author, "past-grace author nulled").toBeNull();
      expect(purged!.authorFullname, "past-grace author_fullname nulled").toBeNull();
      expect(purged!.deletionDetectedBy, "subject key (username) nulled").toBeNull();
      expect(purged!.title, "diary title survives the purge").toBe(`Devlog ${past}`);
      expect(purged!.caption, "diary body survives the purge").toBe("the body excerpt");

      const fullnameOnly = await readPost(bare);
      expect(
        fullnameOnly!.authorFullname,
        "author_fullname purged even when author was already null",
      ).toBeNull();

      const within = await readPost(grace);
      expect(within!.author, "within-grace post NOT purged").not.toBeNull();

      // The audit row was written IN-TX under the operator's user_id.
      const auditRows = await db
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.userId, operatorId), eq(auditLog.action, "reddit.deletion_propagated")),
        );
      expect(auditRows.length, "one in-tx deletion_propagated audit").toBeGreaterThanOrEqual(1);

      // Idempotent re-run: the already-purged row is not re-processed → no NEW audit.
      const before = auditRows.length;
      const rerun = await handleDeletionPropagationCron();
      expect(rerun.purged).toBe(0);
      const auditAfter = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(auditLog)
        .where(
          and(eq(auditLog.userId, operatorId), eq(auditLog.action, "reddit.deletion_propagated")),
        );
      expect(Number(auditAfter[0]!.n)).toBe(before);
    } finally {
      (env as { ADMIN_EMAIL_ALLOWLIST: Set<string> }).ADMIN_EMAIL_ALLOWLIST = savedAllowlist;
      await resetSocialDailyCap();
    }
  });
  // ORPHAN GC (review): a reddit_subreddit walk caches THIRD PARTIES' usernames + their
  // stable t2_ ids. The purge above only ever fires on deletion_detected_at, and that
  // flag is only ever set by a WALK of that subject — so once the source is gone, no
  // walk runs, nothing is flagged, and those identities freeze in the table forever with
  // no mechanism that can remove them.
  describe("orphan author GC", () => {
    it("anonymizes a stale post nobody references any more", async () => {
      const shortId = `orph${uniq()}`;
      await seedTrackedPost(shortId, 400, `Stranger${uniq()}`);
      // Older than the retention window and untouched by any walk since.
      await db
        .update(redditPosts)
        .set({ updatedAt: new Date(Date.now() - 200 * DAY) })
        .where(eq(redditPosts.postId, `t3_${shortId}`));

      await handleDeletionPropagationCron();

      const row = await readPost(shortId);
      expect(row!.author, "an orphaned third-party username must not be kept forever").toBeNull();
      expect(row!.authorFullname, "the stable t2_ id goes with it").toBeNull();
      expect(row!.title, "content is anonymized, not deleted").toBe(`Devlog ${shortId}`);
    });

    it("keeps the author while a diary event still references the post", async () => {
      const u = await seedUserDirectly({ email: `rdt-gc-ev-${uniq()}@t.io` });
      const shortId = `keep${uniq()}`;
      const author = `Stranger${uniq()}`;
      await seedTrackedPost(shortId, 400, author);
      await db
        .update(redditPosts)
        .set({ updatedAt: new Date(Date.now() - 200 * DAY) })
        .where(eq(redditPosts.postId, `t3_${shortId}`));
      await db.insert(events).values({
        userId: u.id,
        kind: "reddit_post",
        occurredAt: new Date(Date.now() - 400 * DAY),
        title: "still in my diary",
        externalId: `t3_${shortId}`,
      });

      await handleDeletionPropagationCron();

      expect((await readPost(shortId))!.author, "a referenced post keeps its author").toBe(author);
    });

    it("keeps the author while a LIVE source still covers the subject", async () => {
      const shortId = `live${uniq()}`;
      const author = `Owner${uniq()}`;
      await seedAccountSource(author.toLowerCase());
      await seedTrackedPost(shortId, 400, author);
      await db
        .update(redditPosts)
        .set({ updatedAt: new Date(Date.now() - 200 * DAY) })
        .where(eq(redditPosts.postId, `t3_${shortId}`));

      await handleDeletionPropagationCron();

      expect(
        (await readPost(shortId))!.author,
        "a subject someone still tracks is not an orphan",
      ).toBe(author);
    });

    it("keeps a RECENTLY walked post even with no event and no source", async () => {
      const shortId = `fresh${uniq()}`;
      const author = `Stranger${uniq()}`;
      await seedTrackedPost(shortId, 400, author);
      // updated_at is "now" from the insert — a live walk touched it.

      await handleDeletionPropagationCron();

      expect((await readPost(shortId))!.author, "the retention window must be respected").toBe(
        author,
      );
    });
  });
});
