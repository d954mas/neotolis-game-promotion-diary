// Reddit cron WIRING coverage (Phase 12 review P1). The cron HANDLERS are tested in
// isolation (reddit-poll-cron / reddit-deletion-propagation), but the boot-time wiring
// that actually REGISTERS them — redditAdapter.scheduleCronTicks + registerQueues —
// had ZERO coverage after the old free-.json smoke assertion ("4 reddit.cron.*
// schedules") was razed. A refactor that drops scheduleCronTicks from worker init, or
// fat-fingers a queue key, would ship green while in prod the GDPR deletion-propagation
// purge NEVER fires (flagged authors' PII never nulled after the 48h grace) and
// auto-import silently never runs. This is the vacuous-pass guard for that wiring.
//
// Pure wiring assertion: a recording MinimalBoss captures the schedule()/createQueue()/
// work() calls; no DB, no HTTP.
import { describe, it, expect } from "vitest";
import { redditAdapter } from "../../src/lib/sources/reddit/server/index.js";
import { QUEUES } from "../../src/lib/server/queues.js";
import type { MinimalBoss } from "../../src/lib/sources/adapter.js";

interface Scheduled {
  queue: string;
  cron: string;
  payload?: object;
  options?: { tz?: string; key?: string };
}

function recordingBoss(rec: {
  scheduled: Scheduled[];
  created: string[];
  worked: string[];
}): MinimalBoss {
  return {
    async schedule(
      name: string,
      cron: string,
      payload?: object,
      options?: { tz?: string; key?: string },
    ) {
      rec.scheduled.push({ queue: name, cron, payload, options });
      return undefined;
    },
    async createQueue(name: string) {
      rec.created.push(name);
      return undefined;
    },
    async work(name: string) {
      rec.worked.push(name);
      return undefined;
    },
    async send() {
      return "job-id";
    },
  } as unknown as MinimalBoss;
}

describe("reddit cron wiring", () => {
  it("scheduleCronTicks registers the GDPR deletion-propagation purge + poll/quota crons", async () => {
    const rec = { scheduled: [] as Scheduled[], created: [] as string[], worked: [] as string[] };
    await redditAdapter.scheduleCronTicks(recordingBoss(rec));

    const byQueue = (q: string): Scheduled[] => rec.scheduled.filter((s) => s.queue === q);

    // ★ The legally load-bearing GDPR author-purge cron MUST be scheduled daily 05:00 UTC.
    const purge = byQueue(QUEUES.REDDIT_DELETION_PROPAGATION);
    expect(purge).toHaveLength(1);
    expect(purge[0]!.cron).toBe("0 5 * * *");

    // The poll tiers collapse into one queue via distinct keys. NO warm tier: the
    // per-post warm catch was disabled (no ScrapeCreators lookup-by-id — a warm
    // attempt burned a credit on a page-1 miss); scheduling it again would resurrect
    // that spend, so this assertion is load-bearing.
    const poll = byQueue(QUEUES.REDDIT_POLL_CRON);
    const tiers = poll.map((p) => (p.payload as { tier?: string }).tier).sort();
    expect(tiers).toEqual(["active", "cold"]);

    // Daily per-user cap reset (never the shared prepaid balance).
    expect(byQueue(QUEUES.REDDIT_QUOTA_RESET)).toHaveLength(1);
  });

  it("registerQueues creates a queue AND a worker for the deletion-propagation purge", async () => {
    const rec = { scheduled: [] as Scheduled[], created: [] as string[], worked: [] as string[] };
    await redditAdapter.registerQueues(recordingBoss(rec));

    // Without both, scheduled purge jobs land in a queue no worker drains → PII never purged.
    expect(rec.created).toContain(QUEUES.REDDIT_DELETION_PROPAGATION);
    expect(rec.worked).toContain(QUEUES.REDDIT_DELETION_PROPAGATION);
    // The two walkers + poll cron must also have workers, or auto-import silently dies.
    expect(rec.worked).toContain(QUEUES.REDDIT_BACKFILL_ACCOUNT);
    expect(rec.worked).toContain(QUEUES.REDDIT_BACKFILL_SUBREDDIT);
    expect(rec.worked).toContain(QUEUES.REDDIT_POLL_CRON);
  });
});
