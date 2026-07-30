// Reddit quota banner data (review P2).
//
// The banner summed the two INDEPENDENT per-kind buckets (reddit_account +
// reddit_subreddit) and showed the sum twice as if they were different action
// categories: 30 account + 30 subreddit rendered as 60/50 in BOTH rows. Enforcement is
// per-kind (getUserQuotaUsedToday / enforceAdapterUserQuota key on the SOURCE KIND — the
// two are separate keyspaces), so the banner now surfaces two independent per-kind rows.
// This proves loadRedditQuota returns each kind's OWN usage, never the sum.

import { describe, it, expect } from "vitest";

process.env.REDDIT_IMPORT_ENABLED = "true";
process.env.REDDIT_PROVIDER = "scrapecreators";
process.env.SCRAPECREATORS_API_KEY = "test-key";

const { loadRedditQuota } = await import("../../src/lib/server/services/quota-read.js");
const { writeAuditStrict } = await import("../../src/lib/server/audit.js");
const { env } = await import("../../src/lib/server/config/env.js");
const { seedUserDirectly } = await import("./helpers.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

async function seedUsage(userId: string, kind: string, requests: number): Promise<void> {
  await writeAuditStrict({
    userId,
    action: "source.refresh_content_requested",
    ipAddress: "0.0.0.0",
    metadata: {
      kind,
      platform: kind,
      flow: "incremental",
      requests_used: requests,
      events_inserted: 0,
    },
  });
}

describe("reddit quota banner data (review P2)", () => {
  it("surfaces two INDEPENDENT per-kind rows — never the summed 60/50", async () => {
    const user = await seedUserDirectly({ email: `rdt-quota-${uniq()}@t.io` });
    await seedUsage(user.id, "reddit_account", 30);
    await seedUsage(user.id, "reddit_subreddit", 30);

    const view = await loadRedditQuota(user.id);
    expect(view.isOperatorConfigured).toBe(true);
    if (!view.isOperatorConfigured) throw new Error("unreachable");

    // Each kind reports its OWN usage against its OWN cap — 30/50 and 30/50…
    expect(view.accountRequests.used).toBe(30);
    expect(view.subredditRequests.used).toBe(30);
    expect(view.accountRequests.cap).toBe(env.LIMIT_SOCIAL_REQUESTS_PER_DAY);
    expect(view.subredditRequests.cap).toBe(env.LIMIT_SOCIAL_REQUESTS_PER_DAY);
    // …NOT the summed 60 the pre-fix banner double-showed in both rows.
    expect(view.accountRequests.used).not.toBe(60);
    expect(view.subredditRequests.used).not.toBe(60);
  });
});
