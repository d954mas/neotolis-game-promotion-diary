// Pure-function tests for youtube-quota-tracker.
//
// DB-touching behaviour (incrementUsage UPSERT, getThrottleState, audit
// idempotency) lives in tests/integration/youtube-quota-tracker.test.ts —
// those need a live Postgres. This file covers the pieces that are pure JS:
//   - hashApiKeyId stable sha-8
//   - todayPacific 'YYYY-MM-DD' America/Los_Angeles formatting (DST-aware)
//   - pickKeyForJob round-robin cycling + null on empty SERVICE_YOUTUBE_API_KEYS
//
// vi.resetModules() between cases that mutate SERVICE_YOUTUBE_API_KEYS so
// each test re-parses the env from the latest process.env — same pattern as
// tests/unit/env.test.ts.

import { describe, it, test, expect, vi, afterEach } from "vitest";
import { randomBytes } from "node:crypto";

// Required env values for env.ts schema parse.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.BETTER_AUTH_SECRET ??= "x".repeat(40);
process.env.OAUTH_CLIENT_ID ??= "test";
process.env.OAUTH_CLIENT_SECRET ??= "test";
process.env.APP_KEK_BASE64 ??= randomBytes(32).toString("base64");

async function withYoutubeKeys<T>(
  raw: string | undefined,
  fn: (mod: typeof import("../../src/lib/sources/youtube/server/quota.js")) => Promise<T> | T,
): Promise<T> {
  const saved = process.env.SERVICE_YOUTUBE_API_KEYS;
  if (raw === undefined) {
    delete process.env.SERVICE_YOUTUBE_API_KEYS;
  } else {
    process.env.SERVICE_YOUTUBE_API_KEYS = raw;
  }
  vi.resetModules();
  // env.ts scrubs the KEK on first parse; re-seed before re-import.
  process.env.APP_KEK_BASE64 ??= randomBytes(32).toString("base64");
  try {
    const mod = await import("../../src/lib/sources/youtube/server/quota.js");
    return await fn(mod);
  } finally {
    if (saved === undefined) {
      delete process.env.SERVICE_YOUTUBE_API_KEYS;
    } else {
      process.env.SERVICE_YOUTUBE_API_KEYS = saved;
    }
  }
}

afterEach(() => {
  vi.resetModules();
});

describe("hashApiKeyId — sha-8 stable identifier", () => {
  it("returns 8 hex characters", async () => {
    await withYoutubeKeys("AIza-one", ({ hashApiKeyId }) => {
      const id = hashApiKeyId("AIza-one");
      expect(id).toMatch(/^[0-9a-f]{8}$/);
    });
  });

  it("is deterministic — same input → same output", async () => {
    await withYoutubeKeys("AIza-one", ({ hashApiKeyId }) => {
      expect(hashApiKeyId("AIza-some-key")).toBe(hashApiKeyId("AIza-some-key"));
    });
  });

  it("differs across distinct keys", async () => {
    await withYoutubeKeys("AIza-one", ({ hashApiKeyId }) => {
      expect(hashApiKeyId("AIza-A")).not.toBe(hashApiKeyId("AIza-B"));
    });
  });
});

describe("todayPacific — 'YYYY-MM-DD' in America/Los_Angeles", () => {
  test.each([
    // 2026-05-05 in May — Pacific is UTC-7 (PDT).
    ["2026-05-05T20:00:00Z", "2026-05-05"], // 13:00 PT
    ["2026-05-05T07:00:00Z", "2026-05-05"], // 00:00 PT (start of day)
    ["2026-05-05T06:59:59Z", "2026-05-04"], // 23:59:59 PT previous day
    ["2026-05-06T06:59:59Z", "2026-05-05"], // still 5th in PT
    ["2026-05-06T07:00:00Z", "2026-05-06"], // rolls to 6th in PT
    // 2026-01-15 in January — Pacific is UTC-8 (PST).
    ["2026-01-15T08:00:00Z", "2026-01-15"], // 00:00 PT
    ["2026-01-15T07:59:59Z", "2026-01-14"], // 23:59:59 PT previous day
  ] as const)("%s UTC → %s PT", async (utc, pacific) => {
    await withYoutubeKeys(undefined, ({ todayPacific }) => {
      expect(todayPacific(new Date(utc))).toBe(pacific);
    });
  });

  it("default now=new Date() works (returns current PT calendar day)", async () => {
    await withYoutubeKeys(undefined, ({ todayPacific }) => {
      expect(todayPacific()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});

describe("pickKeyForJob — round-robin", () => {
  it("returns null when SERVICE_YOUTUBE_API_KEYS is empty (smoke + self-host parity)", async () => {
    await withYoutubeKeys("", ({ pickKeyForJob }) => {
      expect(pickKeyForJob()).toBeNull();
    });
  });

  it("returns null when SERVICE_YOUTUBE_API_KEYS env var unset", async () => {
    await withYoutubeKeys(undefined, ({ pickKeyForJob }) => {
      expect(pickKeyForJob()).toBeNull();
    });
  });

  it("cycles through keys in order: A → B → C → A → B (modulo length)", async () => {
    await withYoutubeKeys("keyA,keyB,keyC", ({ pickKeyForJob, hashApiKeyId }) => {
      const expectedIds = ["keyA", "keyB", "keyC"].map(hashApiKeyId);
      const picks = Array.from({ length: 5 }, () => pickKeyForJob());
      const pickedIds = picks.map((p) => p?.apiKeyId);
      expect(pickedIds).toEqual([
        expectedIds[0],
        expectedIds[1],
        expectedIds[2],
        expectedIds[0],
        expectedIds[1],
      ]);
    });
  });

  it("each pick exposes both apiKey and apiKeyId", async () => {
    await withYoutubeKeys("AIza-real-key", ({ pickKeyForJob, hashApiKeyId }) => {
      const picked = pickKeyForJob();
      expect(picked).not.toBeNull();
      expect(picked!.apiKey).toBe("AIza-real-key");
      expect(picked!.apiKeyId).toBe(hashApiKeyId("AIza-real-key"));
    });
  });

  it("single-key list keeps returning that key (modulo 1 == 0)", async () => {
    await withYoutubeKeys("only-key", ({ pickKeyForJob }) => {
      const a = pickKeyForJob();
      const b = pickKeyForJob();
      expect(a?.apiKey).toBe("only-key");
      expect(b?.apiKey).toBe("only-key");
    });
  });
});

describe("threshold constants", () => {
  it("THROTTLE_EIGHTY_THRESHOLD = 8000 (80% of 10 000)", async () => {
    await withYoutubeKeys(undefined, ({ THROTTLE_EIGHTY_THRESHOLD }) => {
      expect(THROTTLE_EIGHTY_THRESHOLD).toBe(8000);
    });
  });

  it("THROTTLE_NINETYFIVE_THRESHOLD = 9500 (95% of 10 000)", async () => {
    await withYoutubeKeys(undefined, ({ THROTTLE_NINETYFIVE_THRESHOLD }) => {
      expect(THROTTLE_NINETYFIVE_THRESHOLD).toBe(9500);
    });
  });
});

describe("resetThrottleState — module-scope reset hook", () => {
  it("resets round-robin idx so post-reset cycles start fresh", async () => {
    await withYoutubeKeys("k1,k2,k3", ({ pickKeyForJob, resetThrottleState, hashApiKeyId }) => {
      pickKeyForJob(); // → k1
      pickKeyForJob(); // → k2 (idx now 2)
      resetThrottleState();
      const after = pickKeyForJob();
      expect(after?.apiKeyId).toBe(hashApiKeyId("k1"));
    });
  });
});
