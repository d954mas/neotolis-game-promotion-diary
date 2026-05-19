import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/lib/server/http/app.js";
import { seedUserDirectly } from "./helpers.js";
import { uuidv7 } from "../../src/lib/server/ids.js";
import { db } from "../../src/lib/server/db/client.js";
import { adapterRefreshQueue } from "../../src/lib/server/db/schema/index.js";

describe("Reddit preview-url rate-limit mapping", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POST /api/events/preview-url returns Reddit submission time as occurredAt", async () => {
    const app = createApp();
    const user = await seedUserDirectly({
      email: `reddit-preview-ok-${uuidv7()}@test.local`,
    });
    // /api/info.json?id=t3_X Listing shape — single child for the
    // single-id query. Same shape as the batch path (just length=1).
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          kind: "Listing",
          data: {
            children: [
              {
                kind: "t3",
                data: {
                  id: "abc123",
                  name: "t3_abc123",
                  subreddit: "IndieDev",
                  subreddit_id: "t5_IndieDev",
                  author: "maker",
                  author_fullname: "t2_maker",
                  permalink: "/r/IndieDev/comments/abc123/test/",
                  title: "Launch notes",
                  selftext: "",
                  created_utc: 1_781_081_130,
                  score: 42,
                  num_comments: 7,
                  upvote_ratio: 0.91,
                  total_awards_received: 0,
                },
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const res = await app.request("/api/events/preview-url", {
      method: "POST",
      headers: {
        cookie: `neotolis.session_token=${user.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        url: "https://www.reddit.com/r/IndieDev/comments/abc123/test/",
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      kind: "reddit_post",
      externalId: "abc123",
      title: "Launch notes",
      occurredAt: "2026-06-10T08:45:30.000Z",
      thumbnailUrl: null,
    });
  });

  it("POST /api/events/preview-url maps Reddit 429 to reddit_rate_limited", async () => {
    const app = createApp();
    const user = await seedUserDirectly({
      email: `reddit-preview-rate-limited-${uuidv7()}@test.local`,
    });
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

    const res = await app.request("/api/events/preview-url", {
      method: "POST",
      headers: {
        cookie: `neotolis.session_token=${user.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        url: "https://www.reddit.com/r/IndieDev/comments/abc429/test/",
      }),
    });

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toMatchObject({ error: "reddit_rate_limited" });
  });

  it("POST /api/events/preview-url maps Reddit post cap exhaustion to reddit_post_quota_exhausted", async () => {
    const app = createApp();
    const user = await seedUserDirectly({
      email: `reddit-preview-cap-${uuidv7()}@test.local`,
    });
    const now = new Date();
    // Seed up to REDDIT_USER_CAP.postRefreshesPerWindow rows so the next
    // preview call lands ON the cap. Recalibrated v0.1 cap = 30 / 15 min.
    for (let i = 0; i < 30; i++) {
      await db.insert(adapterRefreshQueue).values({
        adapterKind: "reddit_account",
        queueName: "user_post",
        type: "post_single",
        payload: { post_id: `t3_cap${i}`, flow: "paste" },
        userId: user.id,
        priority: 0,
        status: "done",
        enqueuedAt: new Date(now.getTime() - 60_000),
        lastAttemptAt: new Date(now.getTime() - 60_000),
      });
    }
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await app.request("/api/events/preview-url", {
      method: "POST",
      headers: {
        cookie: `neotolis.session_token=${user.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        url: "https://www.reddit.com/r/IndieDev/comments/capped/test/",
      }),
    });

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toMatchObject({ error: "reddit_post_quota_exhausted" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
