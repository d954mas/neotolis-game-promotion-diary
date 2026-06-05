// SOC-05 / SOC-03 — graceful "not configured" degrade (flipped live by Plan 08-06).
//
// With INSTAGRAM_PROVIDER unset (env.ts default ""), the operator has NOT wired
// a provider. The feature must degrade gracefully — boot succeeds, the
// add-source IG entry is disabled (the adapter's observability surface reports
// isOperatorConfigured=false), createSource(instagram_account) returns a clean
// 422 `kind_not_configured` (NOT a 500, NOT the schema-only
// `kind_not_yet_functional`), and /admin/quota's instagram block collapses to
// { isConfigured: false }. No code path branches on APP_MODE: SaaS == self-host,
// both read the same env. Integration test — real Postgres via ./helpers.js.
//
// This file is the unconfigured-state contract; the configured-state surfaces
// (create resolves account_id + enqueues backfill, the cap fires 429, the feed
// renders) are proven in instagram-feed-viz.test.ts / social-user-cap.test.ts
// with the provider seam mocked.

import { describe, it, expect } from "vitest";
import { createSource } from "../../src/lib/server/services/data-sources.js";
import { AppError } from "../../src/lib/server/services/errors.js";
import { isInstagramConfigured } from "../../src/lib/sources/instagram/server/provider/registry.js";
import { getInstagramProviderBlock } from "../../src/lib/sources/instagram/server/observability.js";
import { getAdapter } from "../../src/lib/sources/registry.js";
import { db } from "../../src/lib/server/db/client.js";
import { dataSources } from "../../src/lib/server/db/schema/data-sources.js";
import { eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";

describe("instagram not-configured graceful degrade (SOC-05)", () => {
  it("sanity: the test process boots with the provider unconfigured (env default)", () => {
    // The whole file rests on this precondition. If a future env change wires a
    // default provider in the test process, this assertion fails loudly rather
    // than letting the not-configured assertions below pass vacuously.
    expect(isInstagramConfigured()).toBe(false);
  });

  it("the instagram_account adapter reports auth.isOperatorConfigured=false (add-source entry disabled)", () => {
    // The /sources add-source matrix reads the adapter's observability surface to
    // decide whether to render the IG entry enabled or as a disabled chip with an
    // env-var hint (the same signal the Reddit REDDIT_USER_AGENT-empty path uses).
    const adapter = getAdapter("instagram_account");
    expect(adapter.observability.auth.isOperatorConfigured).toBe(false);
    expect(adapter.observability.auth.kind).toBe("scrape");
  });

  it("createSource(instagram_account) degrades to 422 kind_not_configured — never a 500 — and persists no row", async () => {
    const userA = await seedUserDirectly({ email: "ig-notcfg-create@test.local" });
    try {
      await createSource(
        userA.id,
        { kind: "instagram_account", handleUrl: "https://www.instagram.com/natgeo/" },
        "127.0.0.1",
      );
      throw new Error("expected createSource to throw kind_not_configured");
    } catch (e) {
      const err = e as AppError;
      // 422 not_configured, the SOC-05 signal — NOT a 500, NOT
      // kind_not_yet_functional (the schema-only gate).
      expect(err.code).toBe("kind_not_configured");
      expect(err.status).toBe(422);
      expect(err.code).not.toBe("kind_not_yet_functional");
      // Cross-cutting literal-string ban: no body of any tenant 4xx may carry
      // these (this is a config gate, but the ban is global).
      expect(err.message).not.toMatch(/forbidden|permission/i);
    }
    // No phantom half-write — validate-before-INSERT discipline holds.
    const rows = await db.select().from(dataSources).where(eq(dataSources.userId, userA.id));
    expect(rows).toHaveLength(0);
  });

  it("getInstagramProviderBlock() returns isConfigured:false (no throw)", async () => {
    const block = await getInstagramProviderBlock();
    expect(block.isConfigured).toBe(false);
  });

  // The /admin/quota instagram block (loadAdminQuotaPage().instagram) collapsing
  // to { isConfigured: false } is asserted in admin-quota.test.ts (OBS-02 — the
  // loader extension landed alongside the admin block in Task 2).
});
