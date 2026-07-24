// Reddit HTTP budget-key seam (review P0).
//
// Every Reddit provider request reserves a prepaid credit via reserveSocialCredits,
// keyed by PROVIDER. The shared ScrapeCreators prepaid balance is ONE pool across IG +
// TikTok + Reddit (D-01) — keyed by provider="scrapecreators". Pre-fix the Reddit
// provider passed provider="scrapecreators-reddit", which seeded a SECOND, independent
// prepaid balance row: Reddit spend was invisible to the shared hard ceiling + the
// 80/95 throttle (which the read paths query under "scrapecreators"), so the joint
// ceiling could be bypassed and /admin service-load under-reported.
//
// This suite drives the REAL provider (fetchRedditFeedPage → redditFetch →
// reserveSocialCredits); only the bare HTTP (global fetch inside fetchWithTimeout) is
// stubbed, against a REAL seeded budget ledger. Mocking http.js's fetchWithTimeout
// would NOT work (module-local binding) — stub global fetch, same as the TikTok
// metering suite. Real Postgres via ./helpers.js; the DB is never mocked.

import { afterAll, describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DailyUserRequestAccounting } from "../../src/lib/server/daily-user-quota.js";

// Configure the operator provider BEFORE any import resolves env — isRedditConfigured
// checks REDDIT_IMPORT_ENABLED (the D-08 kill-switch) FIRST, then the shared key.
process.env.REDDIT_IMPORT_ENABLED = "true";
process.env.REDDIT_PROVIDER = "scrapecreators";
process.env.SCRAPECREATORS_API_KEY = "test-key";

interface ScriptedHttp {
  calls: number;
  body: unknown;
}
const http: ScriptedHttp = { calls: 0, body: null };
const realFetch = globalThis.fetch;

vi.stubGlobal("fetch", async (): Promise<Response> => {
  http.calls += 1;
  return new Response(JSON.stringify(http.body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

afterAll(() => {
  vi.stubGlobal("fetch", realFetch);
});

const { db } = await import("../../src/lib/server/db/client.js");
const { socialProviderSpend, socialProviderBalance } =
  await import("../../src/lib/server/db/schema/index.js");
const { fetchRedditFeedPage } =
  await import("../../src/lib/sources/reddit/server/provider/scrapecreators-reddit.js");
const { AdapterError } = await import("../../src/lib/sources/errors.js");
const { resetSocialDailyCap, todayPacific } =
  await import("../../src/lib/sources/reddit/server/quota.js");

// The CANONICAL shared provider key IG + TikTok + Reddit all draw from.
const PROVIDER = "scrapecreators";
// The reddit-private key the pre-fix provider seeded a SECOND balance under — must
// never appear in the ledger after the fix.
const LEAKED_PROVIDER = "scrapecreators-reddit";

async function seedBalance(credits: number): Promise<void> {
  await db
    .insert(socialProviderBalance)
    .values({ provider: PROVIDER, prepaidBalanceCredits: credits })
    .onConflictDoUpdate({
      target: [socialProviderBalance.provider],
      set: { prepaidBalanceCredits: credits },
    });
}

async function balanceFor(provider: string): Promise<number | null> {
  const rows = await db
    .select({ credits: socialProviderBalance.prepaidBalanceCredits })
    .from(socialProviderBalance)
    .where(eq(socialProviderBalance.provider, provider));
  return rows[0]?.credits ?? null;
}

async function poolSpend(pool: "user" | "cron"): Promise<number> {
  const rows = await db
    .select({ used: socialProviderSpend.creditsUsed })
    .from(socialProviderSpend)
    .where(
      and(
        eq(socialProviderSpend.datePacific, todayPacific()),
        eq(socialProviderSpend.platform, "reddit"),
        eq(socialProviderSpend.provider, PROVIDER),
        eq(socialProviderSpend.poolKind, pool),
      ),
    );
  return rows[0]?.used ?? 0;
}

beforeEach(async () => {
  http.calls = 0;
  http.body = { success: true, posts: [], after: null };
  await resetSocialDailyCap();
});

describe("reddit budget key (review P0)", () => {
  it("reserves against the SHARED scrapecreators balance — not a reddit-private key", async () => {
    await seedBalance(1000);

    await fetchRedditFeedPage("author", "somebody", null, { origin: "user" });

    // The bare HTTP fired once (the feed page)…
    expect(http.calls).toBe(1);
    // …and the credit was drawn from the SHARED "scrapecreators" balance…
    expect(await balanceFor(PROVIDER)).toBe(1000 - 1);
    // …counted in the shared reddit user-pool spend counter under "scrapecreators"…
    expect(await poolSpend("user")).toBe(1);
    // …and CRUCIALLY: no second, reddit-private balance row was ever seeded. Its
    // existence would prove Reddit spend bypassing the shared hard ceiling (the bug).
    expect(await balanceFor(LEAKED_PROVIDER)).toBeNull();
  });

  it("reddit spend counts toward the shared hard ceiling (reserve denied at balance 0)", async () => {
    await seedBalance(1); // one credit funds exactly one request

    // First request drains the shared balance to 0.
    await fetchRedditFeedPage("subreddit", "gamedev", null, { origin: "cron" });
    expect(await balanceFor(PROVIDER)).toBe(0);
    expect(http.calls).toBe(1);

    // Second request: reserve-before-HTTP sees the shared balance exhausted → denies
    // the reserve and throws BEFORE issuing the HTTP. If Reddit had its own balance
    // this would have wrongly succeeded (the ceiling bypass the P0 fix closes).
    let thrown: unknown;
    try {
      await fetchRedditFeedPage("subreddit", "gamedev", null, { origin: "cron" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AdapterError);
    expect((thrown as InstanceType<typeof AdapterError>).category).toBe("operator-issue");
    // No HTTP on the denied reserve; the balance stayed exhausted (no negative spend).
    expect(http.calls).toBe(1);
    expect(await balanceFor(PROVIDER)).toBe(0);
  });

  it("[CR-01] an accounting INSERT failure rolls back the reservation and issues no HTTP", async () => {
    await seedBalance(1000);
    const balanceBefore = await balanceFor(PROVIDER);
    const spendBefore = await poolSpend("user");
    const invalidAudit = {
      userId: "accounting-failure-user",
      action: "source.refresh_content_requested",
      ipAddress: "127.0.0.1",
      metadata: {
        platform: "reddit_account",
        // Force the DB audit-flow CHECK to fail after the credit updates. The cast
        // keeps this a runtime rollback test rather than a compile-time fixture test.
        flow: "invalid_flow" as "initial",
        requests_used: 1,
        events_inserted: 0,
      },
    } satisfies DailyUserRequestAccounting["auditEntry"];

    await expect(
      fetchRedditFeedPage("author", "accounting_failure", null, {
        origin: "user",
        userAccounting: {
          auditEntry: invalidAudit,
          requestsPerDay: 50,
        },
      }),
    ).rejects.toThrow();

    expect(http.calls, "HTTP must not start when atomic accounting fails").toBe(0);
    expect(await balanceFor(PROVIDER)).toBe(balanceBefore);
    expect(await poolSpend("user")).toBe(spendBefore);
  });
});
