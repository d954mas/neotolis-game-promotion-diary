// TikTok create-time resolveAccount METERING (Finding 3).
//
// resolveAccount (the create-time handle→account-id resolution, the ONLY caller is
// resolveHandleToAccountId from canonicalizeOnCreate) issues a /v1/tiktok/profile
// request that costs 1 prepaid credit (10-SPIKE). Pre-fix it called tiktokFetch
// WITHOUT an `origin`, so the request bypassed reserveSocialCredits — an unmetered
// paid call that let a flood of add-source attempts drain the shared prepaid balance
// below the budget guardrails. The fix threads origin="user" so the resolve reserves
// like every other paid request.
//
// This suite drives the REAL provider impl (NOT a mocked getSocialProvider) so the
// real tiktokFetch → reserveSocialCredits path runs; only the bare HTTP
// (fetchWithTimeout) is mocked, against a REAL seeded budget ledger. It proves:
//   - a funded create increments the user-pool spend counter by 1 (the resolve is
//     metered), and the source row lands.
//   - an exhausted prepaid balance denies the reserve BEFORE the HTTP (reserve-
//     before-HTTP) → a clean 503, NO source row, and fetchWithTimeout never fired
//     (no credit burned on a request that was refused).
//
// Real Postgres via ./helpers.js. NEVER mocks the DB.

import { afterAll, describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";

// Configure the operator provider BEFORE any import resolves env: isTikTokConfigured
// reads TIKTOK_PROVIDER + SCRAPECREATORS_API_KEY, so getSocialProvider("tiktok")
// returns the REAL scrapeCreatorsTikTokProvider (not null) for this suite.
process.env.TIKTOK_PROVIDER = "scrapecreators";
process.env.SCRAPECREATORS_API_KEY = "test-key";

// Stub the GLOBAL fetch (the actual network call inside http.ts fetchWithTimeout).
// The real tiktokFetch (reserve + status map + OBS) + fetchWithTimeout run around it
// untouched, so the reserve hits the REAL seeded budget ledger — only the wire is
// faked. Mocking the http.js module's fetchWithTimeout would NOT work: tiktokFetch
// calls it via the module-local binding, which a module-namespace mock can't
// intercept.
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
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { socialProviderSpend, socialProviderBalance } =
  await import("../../src/lib/server/db/schema/index.js");
const { createSource } = await import("../../src/lib/server/services/data-sources.js");
const { AppError } = await import("../../src/lib/server/services/errors.js");
const { resetSocialDailyCap, todayPacific } =
  await import("../../src/lib/sources/tiktok/server/quota.js");
const { seedUserDirectly } = await import("./helpers.js");

const PROVIDER = "scrapecreators";
const HANDLE_URL = "https://www.tiktok.com/@stoolpresidente";

// The /v1/tiktok/profile body normalizeProfile expects (user top-level, camelCase).
function profileBody(accountId = "6659752019493208069") {
  return {
    success: true,
    user: {
      id: accountId,
      uniqueId: "stoolpresidente",
      nickname: "Stool Presidente",
      secUid: "MS4wLjABAAAA",
      avatarLarger: "https://cdn.tiktokcdn-us.com/avatar.jpg",
    },
    stats: { followerCount: 1234 },
  };
}

async function seedBalance(credits: number): Promise<void> {
  await db
    .insert(socialProviderBalance)
    .values({ provider: PROVIDER, prepaidBalanceCredits: credits })
    .onConflictDoUpdate({
      target: [socialProviderBalance.provider],
      set: { prepaidBalanceCredits: credits },
    });
}

async function userPoolSpend(platform: string): Promise<number> {
  const rows = await db
    .select({ used: socialProviderSpend.creditsUsed })
    .from(socialProviderSpend)
    .where(
      and(
        eq(socialProviderSpend.datePacific, todayPacific()),
        eq(socialProviderSpend.platform, platform),
        eq(socialProviderSpend.provider, PROVIDER),
        eq(socialProviderSpend.poolKind, "user"),
      ),
    );
  return rows[0]?.used ?? 0;
}

beforeEach(async () => {
  http.calls = 0;
  http.body = profileBody();
  await resetSocialDailyCap();
});

describe("tiktok resolveAccount create-time metering (Finding 3)", () => {
  it("a funded create meters the resolve against the user pool (+1 credit) and lands the source", async () => {
    await seedBalance(1000);
    const user = await seedUserDirectly({
      email: `tk-resolve-fund-${Math.random().toString(36).slice(2)}@t.io`,
    });

    const before = await userPoolSpend("tiktok");

    const source = await createSource(
      user.id,
      { kind: "tiktok_account", handleUrl: HANDLE_URL, autoImport: false },
      "127.0.0.1",
    );

    // The source resolved + landed.
    expect(source.channelId).toBe("6659752019493208069");
    const rows = await db.select().from(dataSources).where(eq(dataSources.userId, user.id));
    expect(rows).toHaveLength(1);

    // The bare HTTP fired exactly once (the profile resolve)…
    expect(http.calls).toBe(1);
    // …and the user-pool spend counter advanced by exactly 1 (the resolve is now
    // metered — pre-fix this stayed 0, the credit leaked outside the ledger).
    const after = await userPoolSpend("tiktok");
    expect(after).toBe(before + 1);

    // The prepaid balance was drawn down by the same 1 credit.
    const [bal] = await db
      .select({ credits: socialProviderBalance.prepaidBalanceCredits })
      .from(socialProviderBalance)
      .where(eq(socialProviderBalance.provider, PROVIDER));
    expect(bal!.credits).toBe(1000 - 1);
  });

  it("an exhausted prepaid balance denies the reserve BEFORE the HTTP → clean 503, no source, no credit burned", async () => {
    await seedBalance(0); // hard ceiling: nothing left to reserve
    const user = await seedUserDirectly({
      email: `tk-resolve-exh-${Math.random().toString(36).slice(2)}@t.io`,
    });

    let thrown: unknown;
    try {
      await createSource(
        user.id,
        { kind: "tiktok_account", handleUrl: HANDLE_URL, autoImport: false },
        "127.0.0.1",
      );
    } catch (e) {
      thrown = e;
    }

    // A clean, mapped AppError (operator-issue → 503), NOT an opaque 500.
    expect(thrown).toBeInstanceOf(AppError);
    const err = thrown as { code: string; status: number };
    expect(err.status).toBe(503);
    expect(err.code).toBe("tiktok_provider_unavailable");

    // No phantom source row (canonicalize threw BEFORE the INSERT).
    const rows = await db.select().from(dataSources).where(eq(dataSources.userId, user.id));
    expect(rows).toHaveLength(0);

    // Reserve-before-HTTP: the denied reserve STOPPED the request — the bare HTTP
    // never fired, so no credit was burned on a refused call.
    expect(http.calls).toBe(0);
    const spent = await userPoolSpend("tiktok");
    expect(spent).toBe(0);
  });
});
