import { describe, it, expect, vi, afterEach } from "vitest";
import { randomBytes } from "node:crypto";

// env.ts zod schema tests.
//
// Pattern (matches tests/unit/proxy-trust.test.ts): seed required env BEFORE
// dynamic import; vi.resetModules() between cases so each test sees a fresh
// parse of process.env.

// Required env values for the schema's required keys (DATABASE_URL, etc.)
// Set via ??= so we don't clobber a CI-provided value.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.BETTER_AUTH_SECRET ??= "x".repeat(40);
process.env.OAUTH_CLIENT_ID ??= "test";
process.env.OAUTH_CLIENT_SECRET ??= "test";
process.env.APP_KEK_BASE64 ??= randomBytes(32).toString("base64");

// Helper: snapshot + restore an env var around a test (env.ts caches on
// import, so we must vi.resetModules() to force re-parse with the new value).
async function withEnv(
  overrides: Record<string, string | undefined>,
  fn: (env: typeof import("../../src/lib/server/config/env.js").env) => void | Promise<void>,
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = overrides[k];
    }
  }
  vi.resetModules();
  // KEK material was scrubbed by a prior import — re-seed before re-parse.
  process.env.APP_KEK_BASE64 ??= randomBytes(32).toString("base64");
  try {
    const { env } = await import("../../src/lib/server/config/env.js");
    await fn(env);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

afterEach(() => {
  vi.resetModules();
});

describe("env additions — operational limits + tag", () => {
  it("SUPPORT_EMAIL accepts empty string (default)", async () => {
    await withEnv({ SUPPORT_EMAIL: undefined }, (env) => {
      expect(env.SUPPORT_EMAIL).toBe("");
    });
  });

  it("LIMIT_GAMES_PER_USER coerces string '50' to number 50", async () => {
    await withEnv({ LIMIT_GAMES_PER_USER: "50" }, (env) => {
      expect(env.LIMIT_GAMES_PER_USER).toBe(50);
      expect(typeof env.LIMIT_GAMES_PER_USER).toBe("number");
    });
  });

  it("LIMIT_SOURCES_PER_USER defaults to 50", async () => {
    await withEnv({ LIMIT_SOURCES_PER_USER: undefined }, (env) => {
      expect(env.LIMIT_SOURCES_PER_USER).toBe(50);
    });
  });

  it("LIMIT_EVENTS_PER_DAY defaults to 500", async () => {
    await withEnv({ LIMIT_EVENTS_PER_DAY: undefined }, (env) => {
      expect(env.LIMIT_EVENTS_PER_DAY).toBe(500);
    });
  });

  it("IMAGE_TAG defaults to 'latest'", async () => {
    await withEnv({ IMAGE_TAG: undefined }, (env) => {
      expect(env.IMAGE_TAG).toBe("latest");
    });
  });

  it("DOMAIN accepts empty string default", async () => {
    await withEnv({ DOMAIN: undefined }, (env) => {
      expect(env.DOMAIN).toBe("");
    });
  });
});

describe("env additions — YouTube + admin allowlist", () => {
  it("SERVICE_YOUTUBE_API_KEYS empty default ⇒ empty array (smoke parity)", async () => {
    await withEnv({ SERVICE_YOUTUBE_API_KEYS: undefined }, (env) => {
      expect(env.SERVICE_YOUTUBE_API_KEYS).toEqual([]);
      expect(Array.isArray(env.SERVICE_YOUTUBE_API_KEYS)).toBe(true);
    });
  });

  it("SERVICE_YOUTUBE_API_KEYS comma-splits, trims, drops empties", async () => {
    await withEnv({ SERVICE_YOUTUBE_API_KEYS: "  AIza-one  , AIza-two,, AIza-three " }, (env) => {
      expect(env.SERVICE_YOUTUBE_API_KEYS).toEqual(["AIza-one", "AIza-two", "AIza-three"]);
    });
  });

  it("ADMIN_EMAIL_ALLOWLIST empty default ⇒ empty Set (self-host parity, /admin returns 404 for all)", async () => {
    await withEnv({ ADMIN_EMAIL_ALLOWLIST: undefined }, (env) => {
      expect(env.ADMIN_EMAIL_ALLOWLIST).toBeInstanceOf(Set);
      expect(env.ADMIN_EMAIL_ALLOWLIST.size).toBe(0);
    });
  });

  it("ADMIN_EMAIL_ALLOWLIST lowercases + trims emails into a Set", async () => {
    await withEnv(
      { ADMIN_EMAIL_ALLOWLIST: " Admin@Neotolis.dev , ops@neotolis.dev , Admin@Neotolis.dev " },
      (env) => {
        expect(env.ADMIN_EMAIL_ALLOWLIST.has("admin@neotolis.dev")).toBe(true);
        expect(env.ADMIN_EMAIL_ALLOWLIST.has("ops@neotolis.dev")).toBe(true);
        // Set dedupes the case-variant duplicate.
        expect(env.ADMIN_EMAIL_ALLOWLIST.size).toBe(2);
      },
    );
  });

  it("YOUTUBE_API_BASE_URL defaults to the official endpoint", async () => {
    await withEnv({ YOUTUBE_API_BASE_URL: undefined }, (env) => {
      expect(env.YOUTUBE_API_BASE_URL).toBe("https://www.googleapis.com/youtube/v3");
    });
  });

  it("YOUTUBE_API_BASE_URL accepts a smoke-mock override URL", async () => {
    await withEnv({ YOUTUBE_API_BASE_URL: "http://localhost:9999/youtube/v3" }, (env) => {
      expect(env.YOUTUBE_API_BASE_URL).toBe("http://localhost:9999/youtube/v3");
    });
  });
});
