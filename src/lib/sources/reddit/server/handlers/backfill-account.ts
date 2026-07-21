// reddit.backfill.account queue handler — the AUTHOR-search resumable walker (D-02,
// the high-risk (A) completeness behavior). Thin wrapper over the shared walk core
// bound to mode="author" — the ScrapeCreators `/v1/reddit/search?query=author:<u>`
// path the 12-SPIKE proved returns a COMPLETE, chronological, cursored single-author
// feed. Reconciliation subject = reddit_posts.author.

import { QUEUES } from "$lib/server/queues.js";
import { runRedditWalk, type RedditWalkJob } from "./walk-core.js";

export async function handleBackfillAccount(job: RedditWalkJob): Promise<void> {
  await runRedditWalk(job, {
    kind: "reddit_account",
    mode: "author",
    queue: QUEUES.REDDIT_BACKFILL_ACCOUNT,
  });
}
