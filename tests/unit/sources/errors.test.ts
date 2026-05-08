import { describe, it, expect } from "vitest";
import { AdapterError, categoryToSnapshotStatus } from "$lib/sources/errors.js";

describe("AdapterError — Phase 03.0.1 D-13 5-category taxonomy", () => {
  it("transient category constructs with default retryAfterMs=null", () => {
    const err = new AdapterError("transient 5xx", { category: "transient" });
    expect(err.category).toBe("transient");
    expect(err.name).toBe("AdapterError");
    expect(err.retryAfterMs).toBeNull();
    expect(err).toBeInstanceOf(Error);
  });

  it("rate-limited category preserves retryAfterMs", () => {
    const err = new AdapterError("429", { category: "rate-limited", retryAfterMs: 30_000 });
    expect(err.retryAfterMs).toBe(30_000);
  });

  it("not-found category preserves Error.cause chain (Node 22)", () => {
    const inner = new Error("video deleted");
    const err = new AdapterError("not found", { category: "not-found", cause: inner });
    expect(err.cause).toBe(inner);
  });

  it("permanent category preserves context map", () => {
    const err = new AdapterError("ToS block", {
      category: "permanent",
      context: { sourceId: "abc", url: "https://example.com" },
    });
    expect(err.context).toEqual({ sourceId: "abc", url: "https://example.com" });
  });

  it("operator-issue category constructs", () => {
    const err = new AdapterError("no keys", { category: "operator-issue" });
    expect(err.category).toBe("operator-issue");
  });

  it("default context is empty object when none provided", () => {
    const err = new AdapterError("msg", { category: "transient" });
    expect(err.context).toEqual({});
  });
});

describe("categoryToSnapshotStatus — D-13 mapping", () => {
  it("transient → auth_error (caller logs + retries)", () => {
    expect(categoryToSnapshotStatus("transient")).toBe("auth_error");
  });
  it("rate-limited → rate_limited", () => {
    expect(categoryToSnapshotStatus("rate-limited")).toBe("rate_limited");
  });
  it("not-found → not_found (mark unavailable; tier → Frozen)", () => {
    expect(categoryToSnapshotStatus("not-found")).toBe("not_found");
  });
  it("permanent → auth_error", () => {
    expect(categoryToSnapshotStatus("permanent")).toBe("auth_error");
  });
  it("operator-issue → auth_error", () => {
    expect(categoryToSnapshotStatus("operator-issue")).toBe("auth_error");
  });
});
