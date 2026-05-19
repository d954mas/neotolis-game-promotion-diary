// Pure-function tests for youtube quota helpers.

import { describe, it, test, expect, vi, afterEach } from "vitest";
import { randomBytes } from "node:crypto";

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

describe("hashApiKeyId", () => {
  it("returns 8 hex characters", async () => {
    await withYoutubeKeys("AIza-one", ({ hashApiKeyId }) => {
      expect(hashApiKeyId("AIza-one")).toMatch(/^[0-9a-f]{8}$/);
    });
  });

  it("is deterministic", async () => {
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

describe("todayPacific", () => {
  test.each([
    ["2026-05-05T20:00:00Z", "2026-05-05"],
    ["2026-05-05T07:00:00Z", "2026-05-05"],
    ["2026-05-05T06:59:59Z", "2026-05-04"],
    ["2026-05-06T06:59:59Z", "2026-05-05"],
    ["2026-05-06T07:00:00Z", "2026-05-06"],
    ["2026-01-15T08:00:00Z", "2026-01-15"],
    ["2026-01-15T07:59:59Z", "2026-01-14"],
  ] as const)("%s UTC -> %s PT", async (utc, pacific) => {
    await withYoutubeKeys(undefined, ({ todayPacific }) => {
      expect(todayPacific(new Date(utc))).toBe(pacific);
    });
  });

  it("default now=new Date() works", async () => {
    await withYoutubeKeys(undefined, ({ todayPacific }) => {
      expect(todayPacific()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});

describe("hasYoutubeApiKeys", () => {
  it("returns false when SERVICE_YOUTUBE_API_KEYS is empty", async () => {
    await withYoutubeKeys("", ({ hasYoutubeApiKeys }) => {
      expect(hasYoutubeApiKeys()).toBe(false);
    });
  });

  it("returns false when SERVICE_YOUTUBE_API_KEYS is unset", async () => {
    await withYoutubeKeys(undefined, ({ hasYoutubeApiKeys }) => {
      expect(hasYoutubeApiKeys()).toBe(false);
    });
  });

  it("returns true when at least one key is configured", async () => {
    await withYoutubeKeys("keyA,keyB", ({ hasYoutubeApiKeys }) => {
      expect(hasYoutubeApiKeys()).toBe(true);
    });
  });
});

describe("threshold constants", () => {
  it("THROTTLE_EIGHTY_THRESHOLD = 8000", async () => {
    await withYoutubeKeys(undefined, ({ THROTTLE_EIGHTY_THRESHOLD }) => {
      expect(THROTTLE_EIGHTY_THRESHOLD).toBe(8000);
    });
  });

  it("THROTTLE_NINETYFIVE_THRESHOLD = 9500", async () => {
    await withYoutubeKeys(undefined, ({ THROTTLE_NINETYFIVE_THRESHOLD }) => {
      expect(THROTTLE_NINETYFIVE_THRESHOLD).toBe(9500);
    });
  });
});
