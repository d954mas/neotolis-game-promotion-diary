// Reddit kind/URL mismatch guard (review P1).
//
// The create-time source normalizer resolved metadata from the URL-derived kind but
// never compared it to the REQUESTED kind. A reddit_account request carrying a /r/<sub>
// URL (or vice-versa) persisted metadata.slug on an account-kind row: onSourceCreated
// branches on source.kind → the AUTHOR queue, while backfillSource discriminates on
// metadata.slug → the SUBREDDIT queue, so the initial walk and every later refresh
// dispatched to DIFFERENT queues on inconsistent state. normalizeSourceOnCreate now
// rejects the mismatch with 422 at the earliest boundary (before duplicate/quota
// prechecks). Pure function — no DB, no provider.

import { describe, it, expect } from "vitest";

const { redditAdapter } = await import("../../src/lib/sources/reddit/server/index.js");
const { AppError } = await import("../../src/lib/server/services/errors.js");

async function normalize(kind: string, handleUrl: string) {
  return redditAdapter.normalizeSourceOnCreate!(
    { kind: kind as never, handleUrl },
    { userId: "test-user", ipAddress: "0.0.0.0" },
  );
}

describe("reddit kind/URL mismatch guard (review P1)", () => {
  it("rejects reddit_account + a subreddit URL with 422", async () => {
    let thrown: unknown;
    try {
      await normalize("reddit_account", "https://www.reddit.com/r/gamedev");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AppError);
    const err = thrown as InstanceType<typeof AppError>;
    expect(err.status).toBe(422);
    expect(err.code).toBe("reddit_kind_url_mismatch");
  });

  it("rejects reddit_subreddit + a user URL with 422", async () => {
    let thrown: unknown;
    try {
      await normalize("reddit_subreddit", "https://www.reddit.com/user/d954mas");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as InstanceType<typeof AppError>).code).toBe("reddit_kind_url_mismatch");
  });

  it("accepts a matching account kind + user URL (injects metadata.handle)", async () => {
    const res = await normalize("reddit_account", "https://www.reddit.com/user/d954mas");
    expect(res.metadata).toMatchObject({ handle: "d954mas" });
  });

  it("accepts a matching subreddit kind + /r/ URL (injects metadata.slug)", async () => {
    const res = await normalize("reddit_subreddit", "https://www.reddit.com/r/gamedev");
    expect(res.metadata).toMatchObject({ slug: "gamedev" });
  });
});
