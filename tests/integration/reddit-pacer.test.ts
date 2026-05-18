import { describe, it, expect, beforeEach } from "vitest";

const {
  acquireRedditPacerSlot,
  recordRedditAdapterPause,
  __resetRedditPacerForTest,
  REDDIT_ADAPTER_PAUSE_BACKOFF_MS,
} = await import("../../src/lib/sources/reddit/server/pacer.js");

describe("reddit pacer adapter pause", () => {
  beforeEach(async () => {
    await __resetRedditPacerForTest();
  });

  it("records a 10 minute first pause and blocks new Reddit HTTP slots", async () => {
    const pause = await recordRedditAdapterPause("http_429", 0);

    expect(pause.pauseLevel).toBe(0);
    expect(pause.waitMs).toBe(REDDIT_ADAPTER_PAUSE_BACKOFF_MS[0]);

    const slot = await acquireRedditPacerSlot();
    expect(slot.acquired).toBe(false);
    expect(slot.paused).toBe(true);
    expect(slot.pauseReason).toBe("http_429");
    expect(slot.waitMs).toBeGreaterThan(9 * 60_000);
  });

  it("escalates repeated upstream degradation to the next pause window", async () => {
    await recordRedditAdapterPause("http_403", 0);
    const second = await recordRedditAdapterPause("http_403", 0);

    expect(second.pauseLevel).toBe(1);
    expect(second.waitMs).toBe(REDDIT_ADAPTER_PAUSE_BACKOFF_MS[1]);
  });

  it("honors a longer upstream Retry-After than the local pause floor", async () => {
    const upstreamRetryAfterMs = 90 * 60_000;
    const pause = await recordRedditAdapterPause("http_429", upstreamRetryAfterMs);

    expect(pause.pauseLevel).toBe(0);
    expect(pause.waitMs).toBe(upstreamRetryAfterMs);
  });
});
