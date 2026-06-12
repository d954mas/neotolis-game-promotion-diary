// Twitter/X not-configured graceful degrade (SOC-05) — with TWITTER_PROVIDER
// empty (env.ts default ""), the operator has NOT wired a provider. The feature
// must degrade gracefully — boot succeeds, the add-source Twitter chip is
// disabled (the adapter's observability surface reports isOperatorConfigured=false
// AND buildKindMatrix marks the twitter entry disabled "not-configured"),
// createSource(twitter_account) returns a clean 422 `kind_not_configured` (NOT a
// 500, NOT the schema-only `kind_not_yet_functional`), and no scraper credit is
// spent (the create gate rejects BEFORE any provider request). getSocialProvider
// ("twitter") returns null. No code path branches on APP_MODE: SaaS == self-host,
// both read the same env. Integration test — real Postgres via ./helpers.js.
//
// Flipped live by Plan 11-04 (the Wave-0 scaffold's it.skip placeholders).
//
// Requirements: SOC-05 / success-criterion #4 / PLAT-03.

import { describe, it, expect } from "vitest";
import { createSource } from "../../src/lib/server/services/data-sources.js";
import { AppError } from "../../src/lib/server/services/errors.js";
import { isTwitterConfigured } from "../../src/lib/sources/twitter/server/provider/registry.js";
import { getSocialProvider } from "../../src/lib/sources/social-provider-registry.js";
import { getAdapter } from "../../src/lib/sources/registry.js";
import { buildKindMatrix } from "../../src/lib/sources/kind-matrix.js";
import { db } from "../../src/lib/server/db/client.js";
import { dataSources } from "../../src/lib/server/db/schema/data-sources.js";
import { eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";

describe("twitter not-configured graceful degrade (SOC-05)", () => {
  it("sanity: the test process boots with the provider unconfigured (env default)", () => {
    // The whole file rests on this precondition. If a future env change wires a
    // default provider in the test process, this assertion fails loudly rather
    // than letting the not-configured assertions below pass vacuously.
    expect(isTwitterConfigured()).toBe(false);
  });

  it("[11-04] getSocialProvider('twitter') returns null when TWITTER_PROVIDER is unset", () => {
    // The neutral cross-platform switch returns null for an unconfigured provider,
    // so the walker/handlers degrade to no-op and the lane worker's isEnabled gates
    // OFF — no enqueued row ever runs, no orphan pending state.
    expect(getSocialProvider("twitter")).toBeNull();
  });

  it("[11-04] with TWITTER_PROVIDER empty, the Twitter kind matrix entry is disabled not-configured", () => {
    // buildKindMatrix derives each entry's disabled state from FUNCTIONAL_KINDS +
    // the adapter's isOperatorConfigured. twitter_account is functional but its
    // provider env is empty → disabled with reason "not-configured" (NOT
    // "not-built", which is for the still-schema-only Discord kind).
    const matrix = buildKindMatrix();
    const twitter = matrix.find((e) => e.value === "twitter_account");
    expect(twitter, "the matrix must carry a twitter_account entry").toBeDefined();
    expect(twitter!.disabled).toBe(true);
    expect(twitter!.disabledReason).toBe("not-configured");
    expect(twitter!.statusKey).toBe("source_kind_status_twitter_account");

    // The adapter's observability surface is the underlying signal the matrix
    // reads (the same probe the /sources loader ships to the client).
    const adapter = getAdapter("twitter_account");
    expect(adapter.observability.auth.isOperatorConfigured).toBe(false);
    expect(adapter.observability.auth.kind).toBe("scrape");
  });

  it("[11-04] createSource(twitter_account) degrades to 422 kind_not_configured — never a 500 — and persists no row (no credit spent)", async () => {
    const userA = await seedUserDirectly({ email: "tw-notcfg-create@test.local" });
    try {
      await createSource(
        userA.id,
        { kind: "twitter_account", handleUrl: "https://x.com/ConcernedApe" },
        "127.0.0.1",
      );
      throw new Error("expected createSource to throw kind_not_configured");
    } catch (e) {
      const err = e as AppError;
      // 422 kind_not_configured, the SOC-05 signal — NOT a 500, NOT
      // kind_not_yet_functional (the schema-only gate). The gate fires BEFORE
      // canonicalizeOnCreate (the only path that would issue a provider request),
      // so no twitterapi.io credit is spent on an unconfigured add.
      expect(err.code).toBe("kind_not_configured");
      expect(err.status).toBe(422);
      expect(err.code).not.toBe("kind_not_yet_functional");
      // Cross-cutting literal-string ban: no tenant 4xx body may carry these.
      expect(err.message).not.toMatch(/forbidden|permission/i);
    }
    // No phantom half-write — validate-before-INSERT discipline holds.
    const rows = await db.select().from(dataSources).where(eq(dataSources.userId, userA.id));
    expect(rows).toHaveLength(0);
  });

  it("[11-04] boot succeeds with TWITTER_PROVIDER unset (self-host parity) — the registry resolves the adapter", () => {
    // No SaaS-only leak: an operator who never sets TWITTER_PROVIDER still boots
    // cleanly; the adapter is registered (so the kind-matrix + feed dispatch
    // resolve) and simply reports not-configured. getAdapter must NOT throw.
    expect(() => getAdapter("twitter_account")).not.toThrow();
  });
});
