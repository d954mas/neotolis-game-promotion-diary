import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/lib/server/http/app.js";
import { seedUserDirectly } from "./helpers.js";
import { uuidv7 } from "../../src/lib/server/ids.js";

describe("Reddit preview-url rate-limit mapping", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
});
