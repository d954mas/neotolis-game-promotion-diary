// createSource(instagram_account) maps a provider AdapterError to a clean
// AppError (4xx/5xx), NOT an opaque 500.
//
// canonicalizeOnCreate resolves the pasted handle → the stable IG account_id via
// resolveHandleToAccountId, which issues a provider request that can throw
// AdapterError on 401/402/429/5xx (bad key, rate-limit, upstream outage). The
// route mapper (_shared.ts mapErr) only understands AppError / NotFoundError, so
// an unmapped AdapterError would surface as { error: "internal_server_error" }
// 500. This suite drives the REAL createSource against real Postgres with the
// provider seam mocked to throw each AdapterError category and asserts a typed
// AppError comes out (and no phantom source row is written).
//
// The provider seam is faked at provider/registry's getSocialProvider (the
// configured-provider path), NEVER the DB.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { AppError as AppErrorType } from "../../src/lib/server/services/errors.js";

// A controllable resolveAccount: the test sets the next AdapterError category (or
// a successful resolve) before driving createSource.
interface ScriptedResolve {
  next: { throwCategory: string } | { accountId: string; displayName: string | null };
}
const resolve: ScriptedResolve = { next: { throwCategory: "operator-issue" } };

vi.mock("../../src/lib/sources/instagram/server/provider/registry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    // Report CONFIGURED so createSource reaches canonicalizeOnCreate (the
    // unconfigured gate that returns kind_not_configured is bypassed here — F3
    // is specifically the configured-but-upstream-failing path).
    isInstagramConfigured: () => true,
    getSocialProvider: (platform: string) => {
      if (platform !== "instagram") return null;
      return {
        name: "scrapecreators",
        async resolveAccount() {
          if ("throwCategory" in resolve.next) {
            const { AdapterError } = await import("../../src/lib/sources/errors.js");
            throw new AdapterError("scripted resolve failure", {
              category: resolve.next.throwCategory as never,
            });
          }
          return resolve.next;
        },
        async fetchPosts() {
          return { posts: [], nextCursor: null, endOfFeed: true, creditsUsed: 1 };
        },
        async fetchPostByUrl() {
          return null;
        },
      };
    },
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { createSource } = await import("../../src/lib/server/services/data-sources.js");
const { AppError } = await import("../../src/lib/server/services/errors.js");

const HANDLE_URL = "https://www.instagram.com/natgeo/";

async function expectCreateThrows(): Promise<AppErrorType> {
  const user = await seedUserDirectly({
    email: `ig-create-err-${Math.random().toString(36).slice(2)}@t.io`,
  });
  try {
    await createSource(user.id, { kind: "instagram_account", handleUrl: HANDLE_URL }, "127.0.0.1");
    throw new Error("expected createSource to throw");
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    const err = e as AppErrorType;
    // The cardinal assertion: NOT an internal_server_error / 500.
    expect(err.code).not.toBe("internal_server_error");
    expect(err.status).not.toBe(500);
    // No phantom source row.
    const rows = await db.select().from(dataSources).where(eq(dataSources.userId, user.id));
    expect(rows).toHaveLength(0);
    return err;
  }
}

beforeEach(() => {
  resolve.next = { throwCategory: "operator-issue" };
});

describe("createSource(instagram_account) — AdapterError → AppError mapping (F3)", () => {
  it("operator-issue → 503 instagram_provider_unavailable (not a 500)", async () => {
    resolve.next = { throwCategory: "operator-issue" };
    const err = await expectCreateThrows();
    expect(err.code).toBe("instagram_provider_unavailable");
    expect(err.status).toBe(503);
  });

  it("rate-limited → 429 instagram_rate_limited (not a 500)", async () => {
    resolve.next = { throwCategory: "rate-limited" };
    const err = await expectCreateThrows();
    expect(err.code).toBe("instagram_rate_limited");
    expect(err.status).toBe(429);
  });

  it("transient → 502 instagram_unreachable (not a 500)", async () => {
    resolve.next = { throwCategory: "transient" };
    const err = await expectCreateThrows();
    expect(err.code).toBe("instagram_unreachable");
    expect(err.status).toBe(502);
  });

  it("permanent → 503 instagram_provider_unavailable (not a 500)", async () => {
    resolve.next = { throwCategory: "permanent" };
    const err = await expectCreateThrows();
    expect(err.code).toBe("instagram_provider_unavailable");
    expect(err.status).toBe(503);
  });

  it("not-found → 422 instagram_handle_unresolvable (the existing null-resolve path, no regression)", async () => {
    resolve.next = { throwCategory: "not-found" };
    const err = await expectCreateThrows();
    expect(err.code).toBe("instagram_handle_unresolvable");
    expect(err.status).toBe(422);
  });
});
