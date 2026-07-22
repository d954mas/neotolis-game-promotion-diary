import { describe, it, expect, vi, afterEach } from "vitest";
import { randomBytes } from "node:crypto";

// env.ts zod schema tests.
//
// Pattern (matches tests/unit/proxy-trust.test.ts): seed required env BEFORE
// dynamic import; vi.resetModules() between cases so each test sees a fresh
// parse of process.env.

// Mock dotenv (scoped to this file) so env.ts's loadDotenv() calls become
// no-ops. Without this, vi.resetModules() invalidates dotenv's module
// cache, the next env.ts import re-loads .env from disk, and any test
// that `delete process.env.FOO` to assert the empty/default branch will
// see FOO repopulated from the developer's local .env. CI has no .env
// so this only manifests locally — but the assertions matter equally
// in both environments, so we cut the disk read out of the test path.
//
// vitest hoists `vi.mock` to the top of the file at compile time and
// scopes it per-test-file, so this does NOT leak into other test files
// in the same worker.
vi.mock("dotenv", () => ({
  config: () => ({ parsed: {} }),
}));

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

describe("env additions — Reddit gating (D-08 kill-switch)", () => {
  it("REDDIT_IMPORT_ENABLED defaults to 'false' (the default-OFF kill-switch)", async () => {
    await withEnv({ REDDIT_IMPORT_ENABLED: undefined }, (env) => {
      expect(env.REDDIT_IMPORT_ENABLED).toBe("false");
    });
  });

  it("REDDIT_IMPORT_ENABLED accepts the explicit opt-in 'true'", async () => {
    await withEnv({ REDDIT_IMPORT_ENABLED: "true" }, (env) => {
      expect(env.REDDIT_IMPORT_ENABLED).toBe("true");
    });
  });

  it("REDDIT_IMPORT_ENABLED is a STRICT enum — a non-'true'/'false' value is rejected (no coerce-boolean trap)", async () => {
    // z.coerce.boolean("false") === true would silently AUTO-ENABLE Reddit; the strict
    // z.enum(["true","false"]) rejects anything else at parse time instead.
    await expect(withEnv({ REDDIT_IMPORT_ENABLED: "1" }, () => {})).rejects.toThrow();
  });

  it("REDDIT_PROVIDER defaults to '' (unset ⇒ isRedditConfigured false)", async () => {
    await withEnv({ REDDIT_PROVIDER: undefined }, (env) => {
      expect(env.REDDIT_PROVIDER).toBe("");
    });
  });

  it("REDDIT_PROVIDER accepts 'scrapecreators' and rejects an unknown provider", async () => {
    await withEnv({ REDDIT_PROVIDER: "scrapecreators" }, (env) => {
      expect(env.REDDIT_PROVIDER).toBe("scrapecreators");
    });
    await expect(withEnv({ REDDIT_PROVIDER: "apify" }, () => {})).rejects.toThrow();
  });
});
