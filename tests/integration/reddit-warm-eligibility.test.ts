// Reddit warm auto-refresh — eligibility predicate (clone of twitter-warm-eligibility.test.ts).
//
// selectWarmRedditPostIds is the cost-bounded selection: event-attached reddit posts that
// are YOUNG (< REDDIT_WARM_WINDOW_DAYS, default 2) AND STALE (last_polled_at older than
// REDDIT_WARM_STALENESS_HOURS, default 26), minus terminal/failing posts, minus
// deletion-detected posts (Variant A), and — the Reddit delta — capped to the N newest
// eligible posts PER SUBREDDIT so a firehose subreddit can't fan its off-walk posts into
// an unbounded warm batch and dominate the shared prepaid budget.
//
// Real Postgres via ./helpers.js. Requirements: REDDIT_WARM_* envelope + the per-subreddit cap.
import { describe, it, expect } from "vitest";
import { seedUserDirectly } from "./helpers.js";

const { db } = await import("../../src/lib/server/db/client.js");
const { redditPosts } = await import("../../src/lib/server/db/schema/index.js");
const { createEvent } = await import("../../src/lib/server/services/events-mutation.js");
const { selectWarmRedditPostIds } =
  await import("../../src/lib/sources/reddit/server/warm-eligibility.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);
const HOUR = 3_600_000;

interface SeedOpts {
  subreddit: string;
  publishedAgoHours: number;
  lastPolledAgoHours: number | null;
  deletionDetected?: boolean;
  attachEvent?: boolean;
}

async function seedCandidate(userId: string, opts: SeedOpts): Promise<string> {
  const shortId = `warm_${uniq()}`;
  const postId = `t3_${shortId}`;
  const now = Date.now();
  await db.insert(redditPosts).values({
    postId,
    subredditSlug: opts.subreddit,
    author: "someposter",
    authorFullname: "t2_someposter",
    title: "warm",
    caption: "warm body",
    permalink: `/r/${opts.subreddit}/comments/${shortId}/warm/`,
    publishedAt: new Date(now - opts.publishedAgoHours * HOUR),
    lastPolledAt:
      opts.lastPolledAgoHours === null ? null : new Date(now - opts.lastPolledAgoHours * HOUR),
    lastPollStatus: "ok",
    deletionDetectedAt: opts.deletionDetected === true ? new Date() : null,
  });
  if (opts.attachEvent !== false) {
    await createEvent(
      userId,
      {
        kind: "reddit_post",
        title: "warm",
        externalId: postId,
        occurredAt: new Date().toISOString(),
        gameIds: [],
      },
      "127.0.0.1",
    );
  }
  return postId;
}

describe("selectWarmRedditPostIds predicate", () => {
  it("[12-05] selects a young + stale event-attached reddit post", async () => {
    const u = await seedUserDirectly({ email: `warm-rdt-inc-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, {
      subreddit: `s_${uniq()}`,
      publishedAgoHours: 12,
      lastPolledAgoHours: 30,
    });
    const warm = await selectWarmRedditPostIds(new Date());
    expect(warm).toContain(id);
  });

  it("[12-05] excludes a deletion-detected post (Variant A — stop burning credit on a removed post)", async () => {
    const u = await seedUserDirectly({ email: `warm-rdt-del-${uniq()}@t.io` });
    const id = await seedCandidate(u.id, {
      subreddit: `s_${uniq()}`,
      publishedAgoHours: 12,
      lastPolledAgoHours: 30,
      deletionDetected: true,
    });
    const warm = await selectWarmRedditPostIds(new Date());
    expect(warm).not.toContain(id);
  });

  it("[12-05] per-subreddit cap: keeps only the 5 NEWEST warm-eligible posts per subreddit; other subreddits unaffected", async () => {
    const u = await seedUserDirectly({ email: `warm-rdt-cap-${uniq()}@t.io` });
    const firehose = `firehose_${uniq()}`;
    // 7 young + stale posts in ONE subreddit, published 1..7h ago (i=0 newest).
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      ids.push(
        await seedCandidate(u.id, {
          subreddit: firehose,
          publishedAgoHours: i + 1,
          lastPolledAgoHours: 30,
        }),
      );
    }
    // A post in a DIFFERENT (quiet) subreddit — independently eligible, not squeezed out.
    const other = await seedCandidate(u.id, {
      subreddit: `quiet_${uniq()}`,
      publishedAgoHours: 6,
      lastPolledAgoHours: 30,
    });

    const warm = await selectWarmRedditPostIds(new Date());
    const keptFromFirehose = ids.filter((id) => warm.includes(id));
    expect(keptFromFirehose, "firehose subreddit capped to 5 newest").toHaveLength(5);
    expect(warm, "newest firehose post kept").toContain(ids[0]);
    expect(warm, "6th-newest firehose post dropped").not.toContain(ids[5]);
    expect(warm, "7th-newest firehose post dropped").not.toContain(ids[6]);
    expect(warm, "a different subreddit's post is unaffected by the per-subject cap").toContain(other);
  });
});
