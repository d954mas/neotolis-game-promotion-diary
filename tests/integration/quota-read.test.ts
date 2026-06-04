import { describe, it, expect } from "vitest";
import { loadUserQuota } from "../../src/lib/server/services/quota-read.js";
import { quotaPct, quotaZone } from "../../src/lib/quota-zone.js";
import { writeAudit } from "../../src/lib/server/audit.js";
import { seedUserDirectly } from "./helpers.js";

// D-03 parity proof: loadUserQuota is the ONE per-user quota read both
// /sources and /audit consume. This suite asserts (a) it returns the
// documented { quotaPlatforms, redditQuota } shape, (b) it is userId-scoped
// (user B's usage never bleeds into user A's read), and (c) a YouTube
// platform at 80/100 lands in the warning zone via the SAME quota-zone
// helpers the banner renders with.

// loadQuotaPlatforms sums audit_log rows where action is one of the capped
// verbs, metadata.flow is in the capped set, and metadata.platform matches
// the adapter kind. The YouTube adapter declares userQuotaCap.requestsPerDay
// = 100, so 80 requests_used today = 80% = warning.
async function seedYoutubeUsageToday(
  userId: string,
  requestsUsed: number,
  eventsInserted: number,
): Promise<void> {
  await writeAudit({
    userId,
    action: "source.refresh_content_requested",
    ipAddress: "127.0.0.1",
    userAgent: "vitest",
    metadata: {
      flow: "incremental",
      platform: "youtube_channel",
      requests_used: requestsUsed,
      events_inserted: eventsInserted,
    },
  });
}

describe("loadUserQuota — shared per-user quota read (D-03)", () => {
  it("returns the documented { quotaPlatforms, redditQuota } shape", async () => {
    const user = await seedUserDirectly({ email: "quota-shape@test.local" });

    const result = await loadUserQuota(user.id);

    expect(result).toHaveProperty("quotaPlatforms");
    expect(result).toHaveProperty("redditQuota");
    expect(Array.isArray(result.quotaPlatforms)).toBe(true);
    // Every registered adapter contributes a platform row, so a YouTube
    // entry is always present.
    const youtube = result.quotaPlatforms.find((p) => p.kind === "youtube_channel");
    expect(youtube).toBeDefined();
    expect(youtube!.cap.requestsPerDay).toBe(100);
    expect(youtube!.today).toEqual({ requests: 0, events: 0 });
    // redditQuota is always discriminable.
    expect(typeof result.redditQuota.isOperatorConfigured).toBe("boolean");
  });

  it("is userId-scoped — user B's usage is absent from user A's read", async () => {
    const userA = await seedUserDirectly({ email: "quota-tenant-a@test.local" });
    const userB = await seedUserDirectly({ email: "quota-tenant-b@test.local" });

    await seedYoutubeUsageToday(userA.id, 30, 12);
    await seedYoutubeUsageToday(userB.id, 75, 40);

    const aResult = await loadUserQuota(userA.id);
    const bResult = await loadUserQuota(userB.id);

    const aYoutube = aResult.quotaPlatforms.find((p) => p.kind === "youtube_channel")!;
    const bYoutube = bResult.quotaPlatforms.find((p) => p.kind === "youtube_channel")!;

    // A sees only A's usage; B's 75/40 never bleeds in.
    expect(aYoutube.today).toEqual({ requests: 30, events: 12 });
    expect(bYoutube.today).toEqual({ requests: 75, events: 40 });
  });

  it("a YouTube platform at 80/100 usage resolves to the warning zone (D-05 parity)", async () => {
    const user = await seedUserDirectly({ email: "quota-warning@test.local" });
    await seedYoutubeUsageToday(user.id, 80, 0);

    const result = await loadUserQuota(user.id);
    const youtube = result.quotaPlatforms.find((p) => p.kind === "youtube_channel")!;

    // Run the SAME helpers the banner renders with — no drift.
    const pct = quotaPct(youtube.today.requests, youtube.cap.requestsPerDay!);
    expect(pct).toBe(80);
    expect(quotaZone(pct)).toBe("warning");
  });
});
