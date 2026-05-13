// getUserQuotaLifetime per-platform filter.
//
// Pre-fix the function filtered on `metadata->>'kind'` while writers
// populated the dedicated `metadata->>'platform'` field. An earlier fix
// updated `getUserQuotaUsedToday` to filter on `platform`, but missed the
// parallel `getUserQuotaLifetime` query. Result: lifetime banner showed 0
// even when today's counter was non-zero — same writer rows, two different
// filters.
//
// This suite is a regression guard ensuring both queries agree on the
// filter dimension when seeded with the same audit row shape.

import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import { uuidv7 } from "../../src/lib/server/ids.js";
import {
  getUserQuotaUsedToday,
  getUserQuotaLifetime,
} from "../../src/lib/server/services/quota.js";
import { seedUserDirectly } from "./helpers.js";

const uniq = (): string => Math.random().toString(36).slice(2, 10);

async function seedAuditRow(
  userId: string,
  metadata: Record<string, unknown>,
  action = "source.refresh_content_requested",
): Promise<void> {
  await db.execute(sql`
    INSERT INTO audit_log (id, user_id, action, ip_address, metadata)
    VALUES (${uuidv7()}, ${userId}, ${action}, '127.0.0.1', ${JSON.stringify(metadata)}::jsonb)
  `);
}

describe("getUserQuotaLifetime — per-platform filter (post-review fix)", () => {
  it("counts capped flows scoped by platform — matches getUserQuotaUsedToday filter dimension", async () => {
    const u = await seedUserDirectly({ email: `qlt-platform-${uniq()}@test.local` });

    // Seed two audit rows — one for youtube_channel platform, one for a
    // hypothetical other platform — both with capped flow.
    await seedAuditRow(u.id, {
      flow: "incremental",
      platform: "youtube_channel",
      kind: "youtube_channel",
      requests_used: 5,
      events_inserted: 10,
    });
    await seedAuditRow(u.id, {
      flow: "incremental",
      platform: "reddit_account",
      kind: "reddit_account",
      requests_used: 7,
      events_inserted: 20,
    });

    const ytLifetime = await getUserQuotaLifetime(u.id, "youtube_channel");
    expect(ytLifetime.requests).toBe(5);
    expect(ytLifetime.events).toBe(10);

    const redditLifetime = await getUserQuotaLifetime(u.id, "reddit_account");
    expect(redditLifetime.requests).toBe(7);
    expect(redditLifetime.events).toBe(20);

    // No platform filter → sums across platforms.
    const allLifetime = await getUserQuotaLifetime(u.id);
    expect(allLifetime.requests).toBe(12);
    expect(allLifetime.events).toBe(30);
  });

  it("counts event.poll_refreshed rows where kind=youtube_video but platform=youtube_channel", async () => {
    // Regression guard for the original P1 leak shape — refresh-poll writes
    // `kind: event.kind` ('youtube_video') and `platform: source.kind`
    // ('youtube_channel'). The cap query filters on platform, NOT kind, so
    // these rows must count toward youtube_channel lifetime.
    const u = await seedUserDirectly({ email: `qlt-eventkind-${uniq()}@test.local` });

    await seedAuditRow(
      u.id,
      {
        flow: "stats_refresh",
        platform: "youtube_channel", // source kind
        kind: "youtube_video", // event kind (intentionally different)
        requests_used: 1,
        events_inserted: 0,
      },
      "event.poll_refreshed",
    );

    const ytLifetime = await getUserQuotaLifetime(u.id, "youtube_channel");
    expect(ytLifetime.requests).toBe(1);

    // Today's counter should agree.
    const ytToday = await getUserQuotaUsedToday(u.id, "youtube_channel");
    expect(ytToday.requests).toBe(1);
  });

  it("agrees with getUserQuotaUsedToday on the same row set", async () => {
    // Both functions filter capped flows + platform; lifetime is just
    // unbounded-time. After seeding, today's counter and lifetime should
    // match for the same platform (no cross-day rows seeded).
    const u = await seedUserDirectly({ email: `qlt-agreement-${uniq()}@test.local` });

    for (let i = 0; i < 3; i++) {
      await seedAuditRow(u.id, {
        flow: "incremental",
        platform: "youtube_channel",
        kind: "youtube_channel",
        requests_used: 2,
        events_inserted: 5,
      });
    }

    const today = await getUserQuotaUsedToday(u.id, "youtube_channel");
    const lifetime = await getUserQuotaLifetime(u.id, "youtube_channel");

    expect(today.requests).toBe(6);
    expect(today.events).toBe(15);
    // Lifetime ≥ today; for fresh user with all today's rows, equal.
    expect(lifetime.requests).toBeGreaterThanOrEqual(today.requests);
    expect(lifetime.events).toBeGreaterThanOrEqual(today.events);
  });
});
