// reddit.backfill.subreddit queue handler — the NATIVE-subreddit resumable walker.
// Thin wrapper over the shared walk core bound to mode="subreddit" — the
// `/v1/reddit/subreddit?subreddit=<slug>&sort=new` path (NO timeframe — 12-SPIKE
// trap). Same walk shape as the author walker; reconciliation subject =
// reddit_posts.subreddit_slug.

import { QUEUES } from "$lib/server/queues.js";
import { runRedditWalk, type RedditWalkJob } from "./walk-core.js";

export async function handleBackfillSubreddit(job: RedditWalkJob): Promise<void> {
  await runRedditWalk(job, {
    kind: "reddit_subreddit",
    mode: "subreddit",
    queue: QUEUES.REDDIT_BACKFILL_SUBREDDIT,
  });
}
