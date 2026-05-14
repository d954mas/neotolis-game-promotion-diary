// Phase 03.1 Plan 08 — V21 feed-reddit-enrichment.
//
// Validates enrichRedditFeedDtos (the per-adapter enrichment hook fired by
// the /feed loader via allAdapters[*].enrichFeedDtos). Real Postgres via
// the integration service container; no mocks.
//
// V21 (per the plan):
//   /feed SSR with reddit_post events → enrichFeedDtos populates
//   dto.redditEnrichment with stats (score/numComments/upvoteRatio), the
//   author chip (metadata.author), the sub chip (metadata.subreddit),
//   and the baseline JOIN (median/p75/sampleSize when sampleSize >= 5).
//
// Four assertions in this file:
//   1. Latest snapshot wins (DISTINCT ON post_id ORDER BY polled_at DESC).
//   2. Baseline JOINed when sample_size >= 5.
//   3. Baseline omitted (null) when sample_size < 5.
//   4. Missing enrichment doesn't crash — non-reddit_post DTOs are
//      untouched (the adapter filters internally to kind='reddit_post').

import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import { enrichRedditFeedDtos } from "../../src/lib/sources/reddit/server/feed-enrichment.js";
import type { EventDto } from "../../src/lib/server/dto.js";

// Decoration shape — feed-enrichment hangs `redditEnrichment` on EventDto
// rows via cast. The test reads via the same cast shape to verify the
// in-place mutation (no schema change to EventDto).
interface RedditEnrichmentReadback {
  redditEnrichment?: {
    stats: {
      score: number;
      numComments: number;
      upvoteRatio: number;
      awardsTotal: number;
    } | null;
    subredditSubscribers: number | null;
    authorKarma: number | null;
    baseline: {
      medianScore24h: number | null;
      p75Score24h: number | null;
      sampleSize: number;
    } | null;
  };
}

// Minimal EventDto-shaped fixture — only the fields enrichRedditFeedDtos
// reads (kind / externalId / metadata) are load-bearing; other fields are
// type-required but unused by the enricher.
function makeFixtureDto(args: {
  externalId: string;
  subreddit?: string;
  author?: string;
}): EventDto {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    gameIds: [],
    sourceId: null,
    kind: "reddit_post",
    authorIsMe: false,
    occurredAt: new Date(),
    title: "test",
    url: null,
    notes: null,
    metadata: {
      subreddit: args.subreddit ?? null,
      author: args.author ?? null,
    },
    externalId: args.externalId,
    publishedAt: null,
    lastPolledAt: null,
    lastPollStatus: null,
  } as unknown as EventDto;
}

describe("feed-reddit-enrichment (V21)", () => {
  const userId = "user-feed-test";

  beforeEach(async () => {
    // afterEach in tests/setup.ts truncates public tables; explicit
    // DELETE here is redundant but self-documents the table set under test.
    await db.execute(sql`DELETE FROM reddit_post_snapshots`);
    await db.execute(sql`DELETE FROM reddit_posts`);
    await db.execute(sql`DELETE FROM reddit_subreddit_baselines`);
    await db.execute(sql`DELETE FROM reddit_subreddits_cache`);
    await db.execute(sql`DELETE FROM reddit_users_cache`);
  });

  it("V21: enrichFeedDtos populates redditEnrichment.stats from latest snapshot", async () => {
    await db.execute(sql`
      INSERT INTO reddit_posts (post_id, subreddit, author, author_fullname, permalink, title, submitted_at)
      VALUES ('t3_feed_a', 'feedtest', 'op', 't2_op', '/r/feedtest/comments/feed_a/test/', 'test post', NOW() - INTERVAL '1 hour')
    `);
    // Two snapshots — older (score=5) and newer (score=12). DISTINCT ON
    // post_id ORDER BY polled_at DESC must pick the newer one.
    await db.execute(sql`
      INSERT INTO reddit_post_snapshots (post_id, polled_at, status, score, num_comments, upvote_ratio, awards_total)
      VALUES
        ('t3_feed_a', NOW() - INTERVAL '30 minutes', 'ok', 5, 1, 0.85, 0),
        ('t3_feed_a', NOW() - INTERVAL '5 minutes', 'ok', 12, 3, 0.91, 0)
    `);

    const dto = makeFixtureDto({
      externalId: "t3_feed_a",
      subreddit: "feedtest",
      author: "op",
    });
    await enrichRedditFeedDtos(userId, [dto]);

    const enriched = dto as EventDto & RedditEnrichmentReadback;
    expect(enriched.redditEnrichment).toBeDefined();
    expect(enriched.redditEnrichment?.stats?.score).toBe(12);
    expect(enriched.redditEnrichment?.stats?.numComments).toBe(3);
    expect(enriched.redditEnrichment?.stats?.upvoteRatio).toBeCloseTo(0.91, 2);
  });

  it("baseline JOINed when sample_size >= 5", async () => {
    await db.execute(sql`
      INSERT INTO reddit_subreddit_baselines (subreddit, window_label, computed_at, sample_size, median_score_24h, p75_score_24h)
      VALUES ('feedtest', '30d', NOW(), 10, 100, 250)
    `);
    await db.execute(sql`
      INSERT INTO reddit_posts (post_id, subreddit, author, author_fullname, permalink, title, submitted_at)
      VALUES ('t3_feed_b', 'feedtest', 'op', 't2_op', '/r/feedtest/comments/feed_b/test/', 'test b', NOW())
    `);
    const dto = makeFixtureDto({ externalId: "t3_feed_b", subreddit: "feedtest" });
    await enrichRedditFeedDtos(userId, [dto]);
    const enriched = dto as EventDto & RedditEnrichmentReadback;
    expect(enriched.redditEnrichment?.baseline).not.toBeNull();
    expect(enriched.redditEnrichment?.baseline?.medianScore24h).toBe(100);
    expect(enriched.redditEnrichment?.baseline?.sampleSize).toBe(10);
  });

  it("baseline omitted (null) when sample_size < 5", async () => {
    await db.execute(sql`
      INSERT INTO reddit_subreddit_baselines (subreddit, window_label, computed_at, sample_size, median_score_24h)
      VALUES ('feedtest', '30d', NOW(), 3, 50)
    `);
    await db.execute(sql`
      INSERT INTO reddit_posts (post_id, subreddit, author, author_fullname, permalink, title, submitted_at)
      VALUES ('t3_feed_c', 'feedtest', 'op', 't2_op', '/r/feedtest/comments/feed_c/test/', 'test c', NOW())
    `);
    const dto = makeFixtureDto({ externalId: "t3_feed_c", subreddit: "feedtest" });
    await enrichRedditFeedDtos(userId, [dto]);
    const enriched = dto as EventDto & RedditEnrichmentReadback;
    // Enrichment property is set, but baseline is null (defensive guard
    // in feed-enrichment.ts: skip baselines with sample_size < 5).
    expect(enriched.redditEnrichment).toBeDefined();
    expect(enriched.redditEnrichment?.baseline).toBeNull();
  });

  it("missing enrichment = no crash; dto unchanged for non-reddit_post kinds", async () => {
    const ytDto = {
      id: "yt-1",
      gameIds: [],
      sourceId: null,
      kind: "youtube_video" as const,
      authorIsMe: false,
      occurredAt: new Date(),
      title: "yt",
      url: null,
      notes: null,
      metadata: {},
      externalId: "abcXYZ12345",
      publishedAt: null,
      lastPolledAt: null,
      lastPollStatus: null,
    } as unknown as EventDto;
    await enrichRedditFeedDtos(userId, [ytDto]);
    // Reddit enricher filters to kind='reddit_post' internally. The
    // youtube_video dto stays untouched — no redditEnrichment property.
    const enriched = ytDto as EventDto & RedditEnrichmentReadback;
    expect(enriched.redditEnrichment).toBeUndefined();
  });
});
