// Reddit NATIVE-subreddit walker (Phase 12) — the reddit_subreddit kind. Every other
// walk test drives handleBackfillAccount (reddit_account); this file is the only cover
// for handleBackfillSubreddit + the subreddit-specific WalkConfig (mode="subreddit" and
// the reconcile subject = reddit_posts.subreddit_slug, vs LOWER(author) for accounts).
// A bug in the subreddit branch (e.g. the wrong reconcile column) would otherwise ship
// green. Asserted against the committed subreddit fixture + synthetic reconcile posts.
// REAL handleBackfillSubreddit against real Postgres; the provider fetch is mocked.
//
// Requirements: PLAT-04.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import subredditFixture from "../fixtures/reddit/subreddit-page.json";
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
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { auditLog } = await import("../../src/lib/server/db/schema/audit-log.js");
const { redditPosts } = await import("../../src/lib/server/db/schema/index.js");
const { normalizeRedditFeed } = await import("../../src/lib/sources/reddit/server/normalize.js");
const { handleBackfillSubreddit } =
  await import("../../src/lib/sources/reddit/server/handlers/backfill-subreddit.js");
const { getRedditBackfillState } =
  await import("../../src/lib/sources/reddit/server/backfill-state.js");
const { markChannelLastPolledAt } = await import("../../src/lib/server/services/channel-state.js");

const DAY = 86_400_000;
const uniq = (): string => Math.random().toString(36).slice(2, 8);
const FIXTURE_POSTS = (subredditFixture as { posts: unknown[] }).posts;

function makePost(shortId: string, daysAgo: number, subreddit: string) {
  return {
    name: `t3_${shortId}`,
    id: shortId,
    author: `author_${shortId}`,
    author_fullname: `t2_${shortId}`,
    subreddit,
    title: `Devlog ${shortId}`,
    selftext: "body",
    score: 5,
    num_comments: 2,
    created_utc: Math.floor((Date.now() - daysAgo * DAY) / 1000),
    permalink: `/r/${subreddit}/comments/${shortId}/devlog/`,
  };
}
function walkPage(posts: unknown[]): RedditFeedPage {
  return normalizeRedditFeed({ success: true, posts, after: null });
}

async function seedSubredditSource(slug: string, isOwnedByMe = false): Promise<string> {
  const u = await seedUserDirectly({ email: `rdt-sub-${uniq()}@t.io` });
  const [row] = await db
    .insert(dataSources)
    .values({
      userId: u.id,
      kind: "reddit_subreddit",
      handleUrl: `https://www.reddit.com/r/${slug}`,
      channelId: slug,
      isOwnedByMe,
      autoImport: true,
      metadata: { slug },
    })
    .returning({ id: dataSources.id, userId: dataSources.userId });
  return row!.userId;
}

/** Register a reddit_account source the user declares as THEIR OWN identity — the only
 *  place "this Reddit username is mine" is expressed. */
async function seedOwnedAccountSource(userId: string, handle: string): Promise<void> {
  await db.insert(dataSources).values({
    userId,
    kind: "reddit_account",
    handleUrl: `https://www.reddit.com/user/${handle}`,
    channelId: handle,
    isOwnedByMe: true,
    autoImport: false,
    metadata: { handle },
  });
}

async function seedTrackedPost(shortId: string, daysAgo: number, slug: string): Promise<void> {
  await db.insert(redditPosts).values({
    postId: `t3_${shortId}`,
    subredditSlug: slug,
    author: `author_${shortId}`,
    authorFullname: `t2_${shortId}`,
    title: `Devlog ${shortId}`,
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

describe("reddit native-subreddit walker (Phase 12)", () => {
  it("[12-05] a subreddit walk imports ALL fixture posts as events + terminates complete", async () => {
    const slug = "gamedev";
    await seedSubredditSource(slug);
    provider.pages = [walkPage(FIXTURE_POSTS)];

    await handleBackfillSubreddit({
      data: {
        kind: "reddit_subreddit",
        channelKey: slug,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
    });

    const imported = await db.select().from(events).where(eq(events.kind, "reddit_post"));
    const mine = imported.filter((e) => (e.externalId ?? "").startsWith("t3_"));
    expect(mine.length).toBe(FIXTURE_POSTS.length); // all 4 fixture posts

    const st = await getRedditBackfillState("reddit_subreddit", slug);
    expect(st.complete).toBe(true);
  });

  it("[12-05] reconcile keys on subreddit_slug: an absent SAME-subreddit post is flagged; a DIFFERENT-subreddit post is NOT", async () => {
    const slug = `sub_${uniq()}`;
    const other = `oth_${uniq()}`;
    await seedSubredditSource(slug);
    // Present in the walk (slug), so they define the walked window [3d, now].
    const P1 = `p1${uniq()}`,
      P2 = `p2${uniq()}`;
    // Tracked, in-window, ABSENT from the walk: B in the walked slug, D in a DIFFERENT slug.
    const B = `b${uniq()}`,
      D = `d${uniq()}`;
    await seedTrackedPost(P1, 1, slug);
    await seedTrackedPost(P2, 3, slug);
    await seedTrackedPost(B, 2, slug);
    await seedTrackedPost(D, 2, other); // different subreddit — the subject filter must exclude it

    // The walk returns only P1 + P2 (oldestSeen = P2@3d → window [3d, now] covers B@2d + D@2d).
    provider.pages = [walkPage([makePost(P1, 1, slug), makePost(P2, 3, slug)])];

    await handleBackfillSubreddit({
      data: {
        kind: "reddit_subreddit",
        channelKey: slug,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "auto_passive",
      },
    });

    expect(
      (await readPost(B))!.deletionDetectedAt,
      "same-subreddit absent post → flagged",
    ).not.toBeNull();
    expect(
      (await readPost(D))!.deletionDetectedAt,
      "different-subreddit post → NOT flagged (subject filter)",
    ).toBeNull();
    expect((await readPost(P1))!.deletionDetectedAt, "present post → not flagged").toBeNull();
    expect((await readPost(P2))!.deletionDetectedAt, "present post → not flagged").toBeNull();
  });

  it("[review-P2] clear-on-reappear is SUBJECT-SCOPED: a subreddit walk clears its OWN flag but NOT an author walk's (no clobber)", async () => {
    const slug = `sub_${uniq()}`;
    await seedSubredditSource(slug);
    const S = `s${uniq()}`; // flagged by THIS subreddit walk (by = reddit_subreddit:<slug>)
    const A = `a${uniq()}`; // flagged by an AUTHOR walk (by = reddit_account:<username>)
    await seedTrackedPost(S, 1, slug);
    await seedTrackedPost(A, 1, slug); // an author-deleted post still alive in this sub
    const flaggedAt = new Date(Date.now() - 3_600_000);
    // Deletion ownership is stored KIND-QUALIFIED (`${kind}:${channelKey}`) so u/foo and
    // r/foo can't clear each other's GDPR clock — the subreddit walk clears only its own.
    await db
      .update(redditPosts)
      .set({ deletionDetectedAt: flaggedAt, deletionDetectedBy: `reddit_subreddit:${slug}` })
      .where(eq(redditPosts.postId, `t3_${S}`));
    await db
      .update(redditPosts)
      .set({ deletionDetectedAt: flaggedAt, deletionDetectedBy: "reddit_account:someauthor" })
      .where(eq(redditPosts.postId, `t3_${A}`));

    // Both posts re-appear ALIVE in the subreddit walk this tick.
    provider.pages = [walkPage([makePost(S, 1, slug), makePost(A, 1, slug)])];

    await handleBackfillSubreddit({
      data: {
        kind: "reddit_subreddit",
        channelKey: slug,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "auto_passive",
      },
    });

    // THIS subject's own flag is self-corrected on re-sight…
    expect(
      (await readPost(S))!.deletionDetectedAt,
      "own-subject flag cleared on re-sight",
    ).toBeNull();
    // …but the author walk's flag survives — a live sighting in the SUB is not evidence
    // the deleted AUTHOR is back, so the 48h purge clock keeps running (the fix).
    const a = await readPost(A);
    expect(
      a!.deletionDetectedAt,
      "author walk's flag NOT clobbered by the subreddit walk",
    ).not.toBeNull();
    expect(a!.deletionDetectedBy, "author attribution preserved").toBe("reddit_account:someauthor");
  });

  it("[12-05] the subreddit backfill audit tags metadata.platform = reddit_subreddit (QUOTA_PLATFORM)", async () => {
    const slug = `sub_${uniq()}`;
    const userId = await seedSubredditSource(slug);
    provider.pages = [walkPage([makePost(`x${uniq()}`, 1, slug)])];

    await handleBackfillSubreddit({
      data: {
        kind: "reddit_subreddit",
        channelKey: slug,
        triggerUserId: userId,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "incremental",
      },
    });

    const rows = await db.select().from(auditLog).where(eq(auditLog.userId, userId));
    const backfill = rows.find((r) => r.action === "source.refresh_content_requested");
    expect(backfill, "a backfill audit row must exist for the trigger user").toBeDefined();
    expect((backfill!.metadata as { platform?: string }).platform).toBe("reddit_subreddit");
  });

  it("[review-P1] author_is_me is PER-POST: a stranger's post in a subreddit the user 'owns' is NOT mine; the user's own account's post IS", async () => {
    const slug = `sub_${uniq()}`;
    // is_owned_by_me DEFAULTS TO TRUE on data_sources, so this is the shipping default
    // for a community source — pre-fix EVERY imported community post was tagged "mine".
    const userId = await seedSubredditSource(slug, true);
    const mine = `Me${uniq()}`; // mixed case — matching must be case-insensitive
    await seedOwnedAccountSource(userId, mine.toLowerCase());
    const strangerPostId = `st${uniq()}`;
    const minePostId = `mi${uniq()}`;

    provider.pages = [
      walkPage([
        { ...makePost(strangerPostId, 1, slug), author: `stranger_${uniq()}` },
        { ...makePost(minePostId, 2, slug), author: mine },
      ]),
    ];

    await handleBackfillSubreddit({
      data: {
        kind: "reddit_subreddit",
        channelKey: slug,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "auto_passive",
      },
    });

    const [stranger] = await db
      .select({ authorIsMe: events.authorIsMe })
      .from(events)
      .where(eq(events.externalId, `t3_${strangerPostId}`));
    expect(stranger, "the stranger's post was imported").toBeDefined();
    expect(stranger!.authorIsMe, "a stranger's post is NOT mine").toBe(false);

    const [own] = await db
      .select({ authorIsMe: events.authorIsMe })
      .from(events)
      .where(eq(events.externalId, `t3_${minePostId}`));
    expect(own!.authorIsMe, "a post by the user's OWN reddit account IS mine").toBe(true);
  });

  it("[review-P1] with no owned reddit_account, NOTHING in a subreddit is mine", async () => {
    const slug = `sub_${uniq()}`;
    await seedSubredditSource(slug, true);
    const postId = `no${uniq()}`;
    provider.pages = [walkPage([makePost(postId, 1, slug)])];

    await handleBackfillSubreddit({
      data: {
        kind: "reddit_subreddit",
        channelKey: slug,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "auto_passive",
      },
    });

    const [row] = await db
      .select({ authorIsMe: events.authorIsMe })
      .from(events)
      .where(eq(events.externalId, `t3_${postId}`));
    expect(row!.authorIsMe).toBe(false);
  });

  it("[review-P2] a page whose posts omit `subreddit` gets the channelKey fallback in BOTH the cache row and the event metadata", async () => {
    const slug = `sub_${uniq()}`;
    await seedSubredditSource(slug);
    const postId = `fb${uniq()}`;
    // The native subreddit feed may omit the field entirely (it is scoped by
    // construction). Pre-fix the cache got the channelKey fallback but the event's
    // metadata.subreddit stayed null, so the card lost its r/<sub> line for these posts.
    const bare = makePost(postId, 1, slug) as Record<string, unknown>;
    delete bare.subreddit;
    provider.pages = [walkPage([bare])];

    await handleBackfillSubreddit({
      data: {
        kind: "reddit_subreddit",
        channelKey: slug,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "auto_passive",
      },
    });

    expect((await readPost(postId))!.subredditSlug, "cache row keeps the fallback").toBe(slug);
    const [ev] = await db
      .select({ metadata: events.metadata })
      .from(events)
      .where(eq(events.externalId, `t3_${postId}`));
    expect(
      (ev!.metadata as { subreddit?: unknown }).subreddit,
      "event metadata gets the SAME fallback",
    ).toBe(slug);
  });

  it("[review-P1] an AUTHORITATIVE EMPTY feed on an ESTABLISHED source flags the ENTIRE tracked subject set", async () => {
    const slug = `sub_${uniq()}`;
    await seedSubredditSource(slug);
    // Establish the source (previously polled) so a now-empty feed reads as a mass
    // deletion — NOT a brand-new bad handle (which flags needs_reconnect instead).
    await markChannelLastPolledAt("reddit_subreddit", slug);
    const P = `p${uniq()}`;
    await seedTrackedPost(P, 2, slug); // tracked, alive, not yet flagged
    expect((await readPost(P))!.deletionDetectedAt, "precondition: not flagged").toBeNull();

    // The subject now returns ZERO posts (every post deleted). provider.pages empty ⇒ the
    // mock yields emptyPage() — a complete, authoritative empty feed.
    const emptyPass = async () => {
      provider.pages = [];
      await handleBackfillSubreddit({
        data: {
          kind: "reddit_subreddit",
          channelKey: slug,
          depthBoundIso: "1970-01-01T00:00:00Z",
          flow: "auto_passive",
        },
      });
    };

    // ONE empty pass is NOT evidence. An empty feed has non-deletion causes (search-index
    // rebuild, shadowban, temporary suspension), and the flag it would set is terminal by
    // design — deletion_detected_by is nulled at purge, so clearReappearedDeletions can
    // never un-flag it. Corroboration first.
    await emptyPass();
    expect(
      (await readPost(P))!.deletionDetectedAt,
      "a single empty feed must NOT mass-flag the subject's history",
    ).toBeNull();

    // The SECOND consecutive empty pass corroborates it. The windowed reconcile can't fire
    // (no oldestSeen) — the full-subject reconcile must, or a mass deletion would never
    // set the GDPR clock on any row.
    await emptyPass();
    const p = await readPost(P);
    expect(
      p!.deletionDetectedAt,
      "a corroborated empty feed flags the whole tracked subject set",
    ).not.toBeNull();
    expect(p!.deletionDetectedBy).toBe(`reddit_subreddit:${slug}`);
  });

  it("[review-P2] a sighting between two empty passes RESETS the corroboration counter", async () => {
    const slug = `sub_${uniq()}`;
    await seedSubredditSource(slug);
    await markChannelLastPolledAt("reddit_subreddit", slug);
    const P = `p${uniq()}`;
    await seedTrackedPost(P, 2, slug);

    const pass = async (pages: typeof provider.pages) => {
      provider.pages = pages;
      await handleBackfillSubreddit({
        data: {
          kind: "reddit_subreddit",
          channelKey: slug,
          depthBoundIso: "1970-01-01T00:00:00Z",
          flow: "auto_passive",
        },
      });
    };

    // empty → alive → empty must NOT reach the threshold: the counter tracks
    // CONSECUTIVE empties, so a transient outage that recovers cannot accumulate
    // toward an irreversible purge across unrelated days.
    await pass([]);
    await pass([walkPage([makePost(P, 2, slug)])]);
    await pass([]);

    expect(
      (await readPost(P))!.deletionDetectedAt,
      "a live sighting must reset the empty-pass counter",
    ).toBeNull();
  });
});
