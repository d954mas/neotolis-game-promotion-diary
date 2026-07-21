// Reddit not-configured graceful degrade + platform isolation (Phase 12, success
// criterion #1/#2) — with REDDIT_IMPORT_ENABLED unset (env.ts default "false"), the
// D-08 kill-switch keeps Reddit OFF even though the shared SCRAPECREATORS_API_KEY may
// be set (the key that enables IG/TikTok). The feature must degrade gracefully — boot
// succeeds, both add-source Reddit chips are disabled "not-configured" (the adapter's
// observability reports isOperatorConfigured=false AND buildKindMatrix marks the reddit
// entries disabled not-configured), createSource(reddit_account/reddit_subreddit)
// returns a clean 422 `kind_not_configured` (NOT a 500, NOT `kind_not_yet_functional`),
// and no scraper credit is spent (the gate rejects BEFORE any provider request).
//
// ISOLATION (success criterion #2): Reddit being off must NOT change any other
// platform's configured state — the reddit kill-switch is an INDEPENDENT env read, so
// each other social adapter's isOperatorConfigured reflects ITS OWN env, unaffected by
// REDDIT_IMPORT_ENABLED. This assertion is env-agnostic (green on both CI — where the
// other providers are also unconfigured — and locally, where they may be configured):
// it asserts the reddit-off state does not force the others' matrix entries to reddit's
// state, i.e. each non-reddit entry equals its OWN adapter probe.
//
// Integration test — real Postgres via ./helpers.js.
//
// Requirements: PLAT-04 / success-criterion #1 / #2.

import { describe, it, expect } from "vitest";
import { createSource } from "../../src/lib/server/services/data-sources.js";
import { AppError } from "../../src/lib/server/services/errors.js";
import { isRedditConfigured } from "../../src/lib/sources/reddit/server/provider/registry.js";
import { getSocialProvider } from "../../src/lib/sources/social-provider-registry.js";
import { getAdapter } from "../../src/lib/sources/registry.js";
import { buildKindMatrix } from "../../src/lib/sources/kind-matrix.js";
import { db } from "../../src/lib/server/db/client.js";
import { dataSources } from "../../src/lib/server/db/schema/data-sources.js";
import { eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";

describe("reddit not-configured graceful degrade + isolation (Phase 12 degrade)", () => {
  it("sanity: REDDIT_IMPORT_ENABLED unset ⇒ isRedditConfigured() is false (the D-08 kill-switch precondition)", () => {
    // The whole file rests on this precondition. The kill-switch checks
    // REDDIT_IMPORT_ENABLED FIRST as an independent AND-term, so even with the shared
    // ScrapeCreators key present Reddit stays off unless explicitly enabled.
    expect(isRedditConfigured()).toBe(false);
    // The neutral cross-platform switch returns null for the unconfigured provider →
    // the walker/handlers degrade to no-op; no enqueued row ever runs.
    expect(getSocialProvider("reddit")).toBeNull();
  });

  it("[12-06] with REDDIT_IMPORT_ENABLED unset, the synthetic Reddit chip is disabled not-configured + BOTH reddit adapters report not-configured", () => {
    // The Add-Source UI collapses reddit_account + reddit_subreddit into ONE synthetic
    // "reddit" chip (probeKind reddit_account); buildKindMatrix derives it disabled
    // not-configured from the adapter's isOperatorConfigured.
    const matrix = buildKindMatrix();
    const reddit = matrix.find((e) => e.value === "reddit");
    expect(reddit, "the matrix must carry a reddit chip").toBeDefined();
    expect(reddit!.disabled).toBe(true);
    expect(reddit!.disabledReason).toBe("not-configured");
    expect(reddit!.statusKey).toBe("source_kind_status_reddit_account");

    // The chip probes reddit_account, but BOTH reddit source kinds gate on the same
    // isRedditConfigured() probe — assert each adapter's observability directly.
    for (const kind of ["reddit_account", "reddit_subreddit"] as const) {
      const adapter = getAdapter(kind);
      expect(adapter.observability.auth.isOperatorConfigured).toBe(false);
      expect(adapter.observability.auth.kind).toBe("scrape");
    }
  });

  it("[12-06] createSource(reddit_account) degrades to 422 kind_not_configured — never 500 — and persists no row (no credit spent)", async () => {
    const userA = await seedUserDirectly({ email: "rdt-notcfg-create@test.local" });
    try {
      await createSource(
        userA.id,
        { kind: "reddit_account", handleUrl: "https://www.reddit.com/user/d954mas" },
        "127.0.0.1",
      );
      throw new Error("expected createSource to throw kind_not_configured");
    } catch (e) {
      const err = e as AppError;
      // 422 kind_not_configured — NOT a 500, NOT the schema-only kind_not_yet_functional.
      // The gate fires BEFORE canonicalizeOnCreate (the only provider-request path), so
      // no ScrapeCreators credit is spent on an unconfigured add.
      expect(err.code).toBe("kind_not_configured");
      expect(err.status).toBe(422);
      expect(err.code).not.toBe("kind_not_yet_functional");
      // Cross-cutting literal-string ban: no tenant 4xx body may carry these.
      expect(err.message).not.toMatch(/forbidden|permission/i);
    }
    const rows = await db.select().from(dataSources).where(eq(dataSources.userId, userA.id));
    expect(rows).toHaveLength(0);
  });

  it("[12-06] createSource(reddit_subreddit) degrades to 422 kind_not_configured (the SECONDARY add path)", async () => {
    const userB = await seedUserDirectly({ email: "rdt-notcfg-sub@test.local" });
    try {
      await createSource(
        userB.id,
        { kind: "reddit_subreddit", handleUrl: "https://www.reddit.com/r/gamedev" },
        "127.0.0.1",
      );
      throw new Error("expected createSource to throw kind_not_configured");
    } catch (e) {
      const err = e as AppError;
      expect(err.code).toBe("kind_not_configured");
      expect(err.status).toBe(422);
    }
    const rows = await db.select().from(dataSources).where(eq(dataSources.userId, userB.id));
    expect(rows).toHaveLength(0);
  });

  it("[12-06] ISOLATION: Reddit off does NOT force the other social platforms' state — each non-reddit entry equals its OWN adapter probe (success criterion #2)", () => {
    // Env-agnostic isolation assertion: reddit is off, but the OTHER social kinds'
    // disabled state must reflect THEIR OWN isOperatorConfigured (whatever this env
    // makes it), never reddit's. If reddit's kill-switch leaked into the shared path,
    // an "instagram unaffected"-style assertion would break; instead we assert each
    // entry mirrors its own adapter — true on CI (all unconfigured) AND locally (some
    // configured).
    const matrix = buildKindMatrix();
    for (const kind of ["instagram_account", "tiktok_account", "twitter_account"] as const) {
      const entry = matrix.find((e) => e.value === kind);
      expect(entry, `the matrix must carry a ${kind} entry`).toBeDefined();
      const ownProbe = getAdapter(kind).observability.auth.isOperatorConfigured;
      // The entry is disabled-not-configured IFF its own adapter is unconfigured —
      // reddit's off-ness never changes this.
      if (ownProbe) {
        expect(entry!.disabled, `${kind} configured ⇒ enabled despite reddit off`).toBe(false);
      } else {
        expect(entry!.disabledReason, `${kind} unconfigured ⇒ its OWN reason`).toBe(
          "not-configured",
        );
      }
    }
    // Telegram (free, always-on) is NEVER gated by reddit's env either.
    const telegram = matrix.find((e) => e.value === "telegram_channel");
    expect(telegram!.disabled).toBe(false);
  });

  it("[12-06] boot succeeds with REDDIT_IMPORT_ENABLED unset (self-host parity) — the registry resolves the adapter", () => {
    // No SaaS-only leak: an operator who never opts in still boots cleanly; both reddit
    // kinds resolve an adapter (so the kind-matrix + feed dispatch work) and simply
    // report not-configured. getAdapter must NOT throw.
    expect(() => getAdapter("reddit_account")).not.toThrow();
    expect(() => getAdapter("reddit_subreddit")).not.toThrow();
  });
});
