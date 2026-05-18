import { describe, expect, it } from "vitest";
import {
  createAdapterBatchLaneWorker,
  createAdapterLaneWorker,
} from "../../src/lib/server/services/adapter-lane-worker.js";

describe("adapter lane worker policy validation", () => {
  it("accepts weighted slots when fallthrough names each lane once", () => {
    expect(() =>
      createAdapterLaneWorker({
        adapterKind: "youtube_channel",
        slots: ["service", "user", "user"] as const,
        fallthrough: ["user", "service"] as const,
        maxAttempts: 3,
        staleProcessingMs: 60_000,
        staleRecoveryIntervalMs: 60_000,
        dispatch: async () => {},
      }),
    ).not.toThrow();
  });

  it("rejects an empty slot map before the first tick can hit undefined lanes", () => {
    expect(() =>
      createAdapterLaneWorker({
        adapterKind: "youtube_channel",
        slots: [],
        fallthrough: ["user"],
        maxAttempts: 3,
        staleProcessingMs: 60_000,
        staleRecoveryIntervalMs: 60_000,
        dispatch: async () => {},
      }),
    ).toThrow(/slots must contain at least one lane/);
  });

  it("rejects fallthrough lanes that are not declared in slots", () => {
    expect(() =>
      createAdapterLaneWorker({
        adapterKind: "youtube_channel",
        slots: ["user"] as const,
        fallthrough: ["user", "service"] as const,
        maxAttempts: 3,
        staleProcessingMs: 60_000,
        staleRecoveryIntervalMs: 60_000,
        dispatch: async () => {},
      }),
    ).toThrow(/fallthrough lane 'service' is not present in slots/);
  });

  it("requires batch workers to declare their tenant batching strategy", () => {
    expect(() =>
      createAdapterBatchLaneWorker({
        adapterKind: "youtube_channel",
        slots: ["user"] as const,
        fallthrough: ["user"] as const,
        maxAttempts: 3,
        maxBatchSize: 50,
        batchScope: "global",
        staleProcessingMs: 60_000,
        staleRecoveryIntervalMs: 60_000,
        dispatch: async () => {},
      }),
    ).not.toThrow();
  });

  it("accepts per-lane maxBatchSize record — different limits per lane", () => {
    // Reddit shape: post lanes can batch up to 100 via /api/info, but
    // listing lanes (sub_poll / author_poll) MUST stay at 1 because
    // each row needs its own /r/<sub>/new.json HTTP and a single tick
    // only acquires one pacer slot.
    expect(() =>
      createAdapterBatchLaneWorker({
        adapterKind: "reddit_account",
        slots: ["service_post", "user_post", "service_source", "user_source"] as const,
        fallthrough: ["user_post", "user_source", "service_post", "service_source"] as const,
        maxAttempts: 3,
        maxBatchSize: { service_post: 100, user_post: 100 },
        batchScope: "global",
        staleProcessingMs: 60_000,
        staleRecoveryIntervalMs: 60_000,
        dispatch: async () => {},
      }),
    ).not.toThrow();
  });

  it("rejects per-lane maxBatchSize referencing a lane not in slots", () => {
    expect(() =>
      createAdapterBatchLaneWorker({
        adapterKind: "reddit_account",
        slots: ["user_post"] as const,
        fallthrough: ["user_post"] as const,
        maxAttempts: 3,
        maxBatchSize: { service_post: 100 } as Partial<Record<"user_post", number>>,
        batchScope: "global",
        staleProcessingMs: 60_000,
        staleRecoveryIntervalMs: 60_000,
        dispatch: async () => {},
      }),
    ).toThrow(/maxBatchSize record contains lane 'service_post' not present in slots/);
  });
});
