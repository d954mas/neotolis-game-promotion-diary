// TikTok create-source error paths (flipped live by Plan 10-05).
//
// createSource(tiktok_account) maps a provider AdapterError to a clean AppError
// (4xx/5xx), NOT an opaque 500, and never leaves a phantom source row:
//   - an unresolvable handle (resolveAccount → null) → 422
//     tiktok_handle_unresolvable, NO row written (SOC-01, no credit-then-fail).
//   - each AdapterError category maps to its typed code (rate-limited → 429,
//     operator-issue/permanent → 503, transient → 502).
//   - re-adding the same TikTok account → 422 duplicate_source with the
//     TikTok-specific message.
//   - another tenant's TikTok source → 404 (never 403) on read.
//
// canonicalizeOnCreate resolves the pasted handle → the stable TikTok account_id
// via resolveHandleToAccountId, which issues a provider request that can throw
// AdapterError. The route mapper only understands AppError / NotFoundError, so an
// unmapped AdapterError would surface as a 500. This suite drives the REAL
// createSource against real Postgres with the provider seam mocked to throw each
// AdapterError category (and to resolve successfully for the duplicate /
// cross-tenant cases). The provider seam is faked at the tiktok tree's
// provider/registry getSocialProvider (the configured-provider path), NEVER the
// DB.
//
// Requirements: PLAT-02.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { AppError as AppErrorType } from "../../src/lib/server/services/errors.js";

// A controllable resolveAccount: the test sets the next outcome (an AdapterError
// category, a null resolve, or a successful resolve) before driving createSource.
interface ScriptedResolve {
  next:
    | { throwCategory: string }
    | { result: { accountId: string; displayName: string | null } | null };
}
const resolve: ScriptedResolve = { next: { result: null } };

vi.mock("../../src/lib/sources/tiktok/server/provider/registry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    // Report CONFIGURED so createSource reaches canonicalizeOnCreate (the
    // unconfigured gate that returns kind_not_configured is bypassed here — this
    // suite is the configured-but-upstream-failing / resolving path).
    isTikTokConfigured: () => true,
    getSocialProvider: (platform: string) => {
      if (platform !== "tiktok") return null;
      return {
        name: "scrapecreators",
        async resolveAccount() {
          if ("throwCategory" in resolve.next) {
            const { AdapterError } = await import("../../src/lib/sources/errors.js");
            throw new AdapterError("scripted resolve failure", {
              category: resolve.next.throwCategory as never,
            });
          }
          return resolve.next.result;
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
const { createSource, getSourceById } =
  await import("../../src/lib/server/services/data-sources.js");
const { AppError } = await import("../../src/lib/server/services/errors.js");
const { NotFoundError } = await import("../../src/lib/server/services/errors.js");

const HANDLE_URL = "https://www.tiktok.com/@stoolpresidente";

async function expectCreateThrows(): Promise<AppErrorType> {
  const user = await seedUserDirectly({
    email: `tk-create-err-${Math.random().toString(36).slice(2)}@t.io`,
  });
  try {
    await createSource(user.id, { kind: "tiktok_account", handleUrl: HANDLE_URL }, "127.0.0.1");
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
  resolve.next = { result: null };
});

describe("createSource(tiktok_account) — error paths (Plan 10-05)", () => {
  it("[10-05] an unresolvable handle (resolveAccount → null) → 422 tiktok_handle_unresolvable, no phantom source", async () => {
    resolve.next = { result: null };
    const err = await expectCreateThrows();
    expect(err.code).toBe("tiktok_handle_unresolvable");
    expect(err.status).toBe(422);
  });

  it("[10-05] rate-limited → 429 tiktok_rate_limited (not a 500)", async () => {
    resolve.next = { throwCategory: "rate-limited" };
    const err = await expectCreateThrows();
    expect(err.code).toBe("tiktok_rate_limited");
    expect(err.status).toBe(429);
  });

  it("[10-05] operator-issue → 503 tiktok_provider_unavailable (not a 500)", async () => {
    resolve.next = { throwCategory: "operator-issue" };
    const err = await expectCreateThrows();
    expect(err.code).toBe("tiktok_provider_unavailable");
    expect(err.status).toBe(503);
  });

  it("[10-05] transient → 502 tiktok_unreachable (not a 500)", async () => {
    resolve.next = { throwCategory: "transient" };
    const err = await expectCreateThrows();
    expect(err.code).toBe("tiktok_unreachable");
    expect(err.status).toBe(502);
  });

  it("[10-05] re-adding the same TikTok account returns 422 duplicate_source", async () => {
    resolve.next = { result: { accountId: "6659752019493208069", displayName: "Dave Portnoy" } };
    const user = await seedUserDirectly({
      email: `tk-dup-${Math.random().toString(36).slice(2)}@t.io`,
    });
    // First add resolves + persists (autoImport:false → no backfill enqueue).
    const first = await createSource(
      user.id,
      { kind: "tiktok_account", handleUrl: HANDLE_URL, autoImport: false },
      "127.0.0.1",
    );
    expect(first.kind).toBe("tiktok_account");
    expect(first.channelId).toBe("6659752019493208069");

    // Second add of the same handle → 422 duplicate_source with the
    // TikTok-specific message.
    try {
      await createSource(
        user.id,
        { kind: "tiktok_account", handleUrl: HANDLE_URL, autoImport: false },
        "127.0.0.1",
      );
      throw new Error("expected duplicate_source");
    } catch (e) {
      const err = e as AppErrorType;
      expect(err).toBeInstanceOf(AppError);
      expect(err.code).toBe("duplicate_source");
      expect(err.status).toBe(422);
      expect(err.message).toMatch(/TikTok account/i);
    }
  });

  it("[10-05] another tenant's TikTok source returns 404 (never 403)", async () => {
    resolve.next = { result: { accountId: "6659752019493208069", displayName: "Dave Portnoy" } };
    const owner = await seedUserDirectly({
      email: `tk-owner-${Math.random().toString(36).slice(2)}@t.io`,
    });
    const intruder = await seedUserDirectly({
      email: `tk-intruder-${Math.random().toString(36).slice(2)}@t.io`,
    });
    const source = await createSource(
      owner.id,
      { kind: "tiktok_account", handleUrl: HANDLE_URL, autoImport: false },
      "127.0.0.1",
    );

    // Cross-tenant read → NotFoundError (404), never ForbiddenError (403).
    try {
      await getSourceById(intruder.id, source.id);
      throw new Error("expected cross-tenant access to throw NotFoundError");
    } catch (e) {
      expect(e).toBeInstanceOf(NotFoundError);
      expect((e as { message: string }).message).not.toMatch(/forbidden|permission/i);
    }

    // The owner still reads it fine.
    const own = await getSourceById(owner.id, source.id);
    expect(own.id).toBe(source.id);
  });
});
