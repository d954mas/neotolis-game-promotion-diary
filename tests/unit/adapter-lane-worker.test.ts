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
});
