import { describe, it, expect, test } from "vitest";
import { detectFutureKind } from "$lib/sources/future-kinds.js";

describe("detectFutureKind — Phase 03.0.1 RESEARCH.md SOTA divergence #3 (Reddit deferral preservation)", () => {
  it("reddit.com → 'reddit_post'", () => {
    expect(detectFutureKind("https://reddit.com/r/IndieDev/comments/x/y")).toBe("reddit_post");
  });
  it("www.reddit.com → 'reddit_post'", () => {
    expect(detectFutureKind("https://www.reddit.com/r/IndieDev/foo")).toBe("reddit_post");
  });
  it("old.reddit.com → 'reddit_post'", () => {
    expect(detectFutureKind("https://old.reddit.com/r/IndieDev/foo")).toBe("reddit_post");
  });
  it("redd.it → 'reddit_post'", () => {
    expect(detectFutureKind("https://redd.it/abc123")).toBe("reddit_post");
  });
  it("twitter.com → null (twitter not on the future-kinds map; out of 03.0.1 scope)", () => {
    expect(detectFutureKind("https://twitter.com/x/status/123")).toBeNull();
  });
  it("example.com → null", () => {
    expect(detectFutureKind("https://example.com/foo")).toBeNull();
  });
  it("malformed URL → null (no throw)", () => {
    expect(detectFutureKind("not a url")).toBeNull();
  });
});

describe("parseAnyUrl — D-15 first-match-wins (Wave 0 scaffold; Plan 06 flips live)", () => {
  test.todo("youtube.com URL → first registered adapter (youtube) returns ParsedUrl — flips live in Plan 06");
  test.todo("twitter.com URL → no adapter matches → kind: 'unsupported' — flips live in Plan 06");
  test.todo("reddit.com URL → no adapter matches → kind: 'unsupported' (services/ingest.ts then maps to reddit_pending_phase3 via detectFutureKind) — flips live in Plan 06");
  test.todo("malformed input → kind: 'unsupported' — flips live in Plan 06");
  test.todo("registration order = priority: youtube before reddit means youtube wins on ambiguous host — flips live in Plan 06 (with Reddit adapter unavailable today this is hypothetical)");
});
