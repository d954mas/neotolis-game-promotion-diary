// Admin /quota route integration tests.
//
// Covers the full HTTP surface — auth + allowlist composition + 404 / 200
// branches + cross-tenant audit aggregation. Each test re-imports
// `createApp` after mutating ADMIN_EMAIL_ALLOWLIST so the env-time Set is
// re-parsed (mirrors the unit test pattern).
//
// What's exercised here vs the unit test:
//   - Unit (tests/unit/admin-middleware.test.ts) — the middleware in
//     isolation against a synthetic context.
//   - Integration (this file) — the real createApp() with tenantScope +
//     adminAllowlist + adminQuotaRouter wired together against real
//     Postgres + Better Auth sessions. Confirms the order
//     (auth-first → allowlist → route) that the admin-middleware unit test
//     cannot directly observe.

import { describe, it, expect, vi, afterEach } from "vitest";
import { writeAudit } from "../../src/lib/server/audit.js";
import { db } from "../../src/lib/server/db/client.js";
import {
  youtubeServiceQuotaUsage,
  socialProviderSpend,
} from "../../src/lib/server/db/schema/index.js";
import { todayPacific } from "../../src/lib/sources/youtube/server/quota.js";
import { seedUserDirectly } from "./helpers.js";

const uniq = () => Math.random().toString(36).slice(2, 10);

afterEach(() => {
  vi.resetModules();
});

async function withAllowlist<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.ADMIN_EMAIL_ALLOWLIST;
  process.env.ADMIN_EMAIL_ALLOWLIST = value;
  try {
    vi.resetModules();
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.ADMIN_EMAIL_ALLOWLIST;
    else process.env.ADMIN_EMAIL_ALLOWLIST = saved;
    vi.resetModules();
  }
}

/** Run `fn` with the operator's Instagram provider configured AND the email
 *  allowlisted. env.ts re-parses INSTAGRAM_PROVIDER / SCRAPECREATORS_API_KEY at
 *  module load, so the env mutation must precede the vi.resetModules() that
 *  withAllowlist triggers before re-importing createApp. */
async function withInstagramConfigured<T>(adminEmail: string, fn: () => Promise<T>): Promise<T> {
  const savedProvider = process.env.INSTAGRAM_PROVIDER;
  const savedKey = process.env.SCRAPECREATORS_API_KEY;
  process.env.INSTAGRAM_PROVIDER = "scrapecreators";
  process.env.SCRAPECREATORS_API_KEY = "test-key-admin-quota";
  try {
    return await withAllowlist(adminEmail, fn);
  } finally {
    if (savedProvider === undefined) delete process.env.INSTAGRAM_PROVIDER;
    else process.env.INSTAGRAM_PROVIDER = savedProvider;
    if (savedKey === undefined) delete process.env.SCRAPECREATORS_API_KEY;
    else process.env.SCRAPECREATORS_API_KEY = savedKey;
  }
}

describe("admin /quota route", () => {
  it("anonymous → 401 (auth gate fires before allowlist gate)", async () => {
    await withAllowlist("admin@example.com", async () => {
      const { createApp } = await import("../../src/lib/server/http/app.js");
      const app = createApp();
      const res = await app.request("/api/admin/quota");
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    });
  });

  it("empty ADMIN_EMAIL_ALLOWLIST + valid session → 404 (self-host parity)", async () => {
    await withAllowlist("", async () => {
      const { createApp } = await import("../../src/lib/server/http/app.js");
      const app = createApp();
      const u = await seedUserDirectly({ email: `p07-empty-${uniq()}@test.local` });
      const res = await app.request("/api/admin/quota", {
        headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toEqual({ error: "not_found" });
      const bodyStr = JSON.stringify(body);
      expect(bodyStr).not.toMatch(/forbidden|permission/i);
    });
  });

  it("valid session + email NOT in allowlist → 404 (body excludes forbidden/permission)", async () => {
    await withAllowlist("someone-else@example.com", async () => {
      const { createApp } = await import("../../src/lib/server/http/app.js");
      const app = createApp();
      const u = await seedUserDirectly({ email: `p07-other-${uniq()}@test.local` });
      const res = await app.request("/api/admin/quota", {
        headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toEqual({ error: "not_found" });
      const bodyStr = JSON.stringify(body);
      expect(bodyStr).not.toMatch(/forbidden|permission/i);
    });
  });

  it("valid session + email IN allowlist → 200 + {today, keys, audit}", async () => {
    const adminEmail = `p07-admin-${uniq()}@test.local`;
    await withAllowlist(adminEmail, async () => {
      const { createApp } = await import("../../src/lib/server/http/app.js");
      const app = createApp();
      const u = await seedUserDirectly({ email: adminEmail });
      const res = await app.request("/api/admin/quota", {
        headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        today: string;
        keys: unknown[];
        audit: unknown[];
      };
      // today is YYYY-MM-DD in America/Los_Angeles.
      expect(body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Array.isArray(body.keys)).toBe(true);
      expect(Array.isArray(body.audit)).toBe(true);
    });
  });

  it("keys[] reflects today's youtube_service_quota_usage rows with status thresholds", async () => {
    const adminEmail = `p07-keys-${uniq()}@test.local`;
    const today = todayPacific();
    const keyOk = `ok${uniq()}`;
    const keyEighty = `e8${uniq()}`;
    const keyNinetyfive = `n9${uniq()}`;

    // Seed three rows at different threshold bands.
    await db.insert(youtubeServiceQuotaUsage).values([
      { datePacific: today, apiKeyId: keyOk, poolKind: "cron", estimatedUnits: 3000 },
      { datePacific: today, apiKeyId: keyEighty, poolKind: "cron", estimatedUnits: 8500 },
      { datePacific: today, apiKeyId: keyNinetyfive, poolKind: "cron", estimatedUnits: 9700 },
    ]);

    await withAllowlist(adminEmail, async () => {
      const { createApp } = await import("../../src/lib/server/http/app.js");
      const app = createApp();
      const u = await seedUserDirectly({ email: adminEmail });
      const res = await app.request("/api/admin/quota", {
        headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        today: string;
        keys: Array<{
          apiKeyId: string;
          estimatedUnits: number;
          pctOfDaily: number;
          status: "ok" | "80_throttle" | "95_throttle";
        }>;
      };
      expect(body.today).toBe(today);
      const okRow = body.keys.find((k) => k.apiKeyId === keyOk);
      const eRow = body.keys.find((k) => k.apiKeyId === keyEighty);
      const nRow = body.keys.find((k) => k.apiKeyId === keyNinetyfive);
      expect(okRow).toBeDefined();
      expect(okRow!.estimatedUnits).toBe(3000);
      expect(okRow!.pctOfDaily).toBeCloseTo(30.0, 1);
      expect(okRow!.status).toBe("ok");
      expect(eRow).toBeDefined();
      expect(eRow!.estimatedUnits).toBe(8500);
      expect(eRow!.pctOfDaily).toBeCloseTo(85.0, 1);
      expect(eRow!.status).toBe("80_throttle");
      expect(nRow).toBeDefined();
      expect(nRow!.estimatedUnits).toBe(9700);
      expect(nRow!.pctOfDaily).toBeCloseTo(97.0, 1);
      expect(nRow!.status).toBe("95_throttle");
    });
  });

  // OBS-02 — the per-platform/provider Instagram block.
  it("instagram block collapses to { isConfigured: false } when the provider is unconfigured (env default)", async () => {
    // The integration process boots with INSTAGRAM_PROVIDER="" (env.ts default),
    // so the loader surfaces the not-configured collapse, not an empty spend
    // table (mirrors the reddit REDDIT_USER_AGENT-empty block).
    const adminEmail = `p08-ig-notcfg-${uniq()}@test.local`;
    await withAllowlist(adminEmail, async () => {
      const { createApp } = await import("../../src/lib/server/http/app.js");
      const app = createApp();
      const u = await seedUserDirectly({ email: adminEmail });
      const res = await app.request("/api/admin/quota", {
        headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { instagram: { isConfigured: boolean } };
      expect(body.instagram).toEqual({ isConfigured: false });
    });
  });

  it("instagram block surfaces requestsToday + spend/cap + remaining balance when configured (OBS-02)", async () => {
    const adminEmail = `p08-ig-cfg-${uniq()}@test.local`;
    const today = todayPacific();
    // Seed today's social spend (user pool) so creditsUsed/requestsToday > 0.
    // dailyCap defaults to 100 in the test env (tests/setup.ts); prepaid balance
    // defaults high (100000) with no balance row, so remainingBalance == that.
    await db.insert(socialProviderSpend).values({
      datePacific: today,
      platform: "instagram",
      provider: "scrapecreators",
      poolKind: "user",
      creditsUsed: 12,
    });

    await withInstagramConfigured(adminEmail, async () => {
      const { createApp } = await import("../../src/lib/server/http/app.js");
      const app = createApp();
      const u = await seedUserDirectly({ email: adminEmail });
      const res = await app.request("/api/admin/quota", {
        headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        instagram:
          | {
              isConfigured: true;
              requestsToday: number;
              creditsUsed: number;
              dailyCap: number;
              remainingBalance: number;
              prepaidBalance: number;
              throttleState: string;
            }
          | { isConfigured: false };
      };
      expect(body.instagram.isConfigured).toBe(true);
      if (!body.instagram.isConfigured) throw new Error("expected configured block");
      // 1 credit/request (D-18) ⇒ requestsToday == creditsUsed == seeded spend.
      expect(body.instagram.requestsToday).toBe(12);
      expect(body.instagram.creditsUsed).toBe(12);
      expect(body.instagram.dailyCap).toBe(100);
      // remainingBalance is the prepaid funded balance (the D-16 hard ceiling).
      expect(body.instagram.remainingBalance).toBe(100000);
      expect(body.instagram.prepaidBalance).toBe(100000);
      // 12/100 daily-cap usage is below the 80 threshold → 'ok'.
      expect(body.instagram.throttleState).toBe("ok");
    });
  });

  it("instagram block surfaces social.provider_throttled + social.budget_exhausted in the audit tail (OBS-02)", async () => {
    const adminEmail = `p08-ig-aud-${uniq()}@test.local`;
    const userA = await seedUserDirectly({ email: `p08-ig-aud-u-${uniq()}@test.local` });
    // The social budget verbs are system-emitted under the operator's resolved
    // user_id; seed them on a normal user here (the cross-tenant aggregation is
    // the operator pane — allowlist is the gate).
    await writeAudit({
      userId: userA.id,
      action: "social.provider_throttled",
      ipAddress: "127.0.0.1",
      metadata: { marker: "IG-throttle", platform: "instagram", provider: "scrapecreators" },
    });
    await writeAudit({
      userId: userA.id,
      action: "social.budget_exhausted",
      ipAddress: "127.0.0.1",
      metadata: { marker: "IG-exhausted", platform: "instagram", provider: "scrapecreators" },
    });

    await withAllowlist(adminEmail, async () => {
      const { createApp } = await import("../../src/lib/server/http/app.js");
      const app = createApp();
      const admin = await seedUserDirectly({ email: adminEmail });
      const res = await app.request("/api/admin/quota", {
        headers: { cookie: `neotolis.session_token=${admin.signedSessionCookieValue}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        audit: Array<{ action: string; metadata: Record<string, unknown> }>;
      };
      const actions = body.audit.map((a) => a.action);
      expect(actions).toContain("social.provider_throttled");
      expect(actions).toContain("social.budget_exhausted");
      const markers = body.audit.map((a) => a.metadata?.marker).filter(Boolean);
      expect(markers).toContain("IG-throttle");
      expect(markers).toContain("IG-exhausted");
    });
  });

  it("audit[] aggregates SERVICE_LEVEL_AUDIT_ACTIONS across tenants (allowlist is the gate)", async () => {
    const adminEmail = `p07-aud-${uniq()}@test.local`;
    // Seed audit rows across multiple users with the surfaced + non-surfaced
    // action verbs so we can prove (a) cross-tenant aggregation works and
    // (b) the action filter excludes per-tenant verbs.
    const userA = await seedUserDirectly({ email: `p07-aud-A-${uniq()}@test.local` });
    const userB = await seedUserDirectly({ email: `p07-aud-B-${uniq()}@test.local` });
    await writeAudit({
      userId: userA.id,
      action: "purge.completed",
      ipAddress: "127.0.0.1",
      metadata: { marker: "A-purge" },
    });
    await writeAudit({
      userId: userB.id,
      action: "auto_import.deferred",
      ipAddress: "127.0.0.1",
      metadata: { marker: "B-defer" },
    });
    await writeAudit({
      userId: userB.id,
      action: "poll.failed",
      ipAddress: "127.0.0.1",
      metadata: { marker: "B-poll-fail" },
    });
    // Per-tenant verb that MUST NOT appear on the operator dashboard.
    await writeAudit({
      userId: userA.id,
      action: "session.signin",
      ipAddress: "127.0.0.1",
      metadata: { marker: "A-signin-NOT-ON-DASH" },
    });

    await withAllowlist(adminEmail, async () => {
      const { createApp } = await import("../../src/lib/server/http/app.js");
      const app = createApp();
      const admin = await seedUserDirectly({ email: adminEmail });
      const res = await app.request("/api/admin/quota", {
        headers: { cookie: `neotolis.session_token=${admin.signedSessionCookieValue}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        audit: Array<{ action: string; metadata: Record<string, unknown> }>;
      };
      const markers = body.audit.map((a) => a.metadata?.marker).filter(Boolean);
      // Cross-tenant aggregation: A's purge AND B's defer/poll-fail surface.
      expect(markers).toContain("A-purge");
      expect(markers).toContain("B-defer");
      expect(markers).toContain("B-poll-fail");
      // Per-tenant verb is excluded by the SERVICE_LEVEL_AUDIT_ACTIONS filter.
      expect(markers).not.toContain("A-signin-NOT-ON-DASH");
      // Ordered descending by createdAt — the last write should appear before
      // the first within the surfaced set (latest is B-poll-fail).
      const surfacedActions = body.audit
        .filter((a) =>
          ["purge.completed", "auto_import.deferred", "poll.failed"].includes(a.action),
        )
        .map((a) => a.action);
      // The 3 we wrote are in there (insertion order A-purge → B-defer → B-poll-fail
      // → ORDER BY createdAt DESC → B-poll-fail ahead of A-purge).
      const idxPurge = surfacedActions.indexOf("purge.completed");
      const idxPollFail = surfacedActions.indexOf("poll.failed");
      expect(idxPurge).toBeGreaterThanOrEqual(0);
      expect(idxPollFail).toBeGreaterThanOrEqual(0);
      expect(idxPollFail).toBeLessThan(idxPurge);
    });
  });

  it("case-insensitive allowlist match (uppercase env entry, lowercase caller)", async () => {
    const adminEmailLower = `p07-case-${uniq()}@test.local`;
    // Operator types ALL CAPS by accident; reader normalizes at boot.
    await withAllowlist(adminEmailLower.toUpperCase(), async () => {
      const { createApp } = await import("../../src/lib/server/http/app.js");
      const app = createApp();
      const u = await seedUserDirectly({ email: adminEmailLower });
      const res = await app.request("/api/admin/quota", {
        headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
      });
      expect(res.status).toBe(200);
    });
  });
});
