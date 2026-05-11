// Phase 03.0.3 P1 — refresh-content quota-burn invariants (issue #29).
//
// 3 behavioural tests verbatim from CONTEXT D-C1:
//   (a) repeated click within 5min on a steady-state channel costs ≤1 page
//       (not N/50 pages) — branch="exhausted".
//   (b) backdated upload (publishedAt < newestKnown but > prior session) is
//       collected on the next click — branch="incremental".
//   (c) widening backfillTargetSince (30d → epoch) triggers deep walk on
//       next refresh-content click — branch="deep" (no eager reset; D-#29-6).
//
// Live bodies land in Task 5 of plan 03.0.3-01. Wave 0 scaffold: 3 it.skip
// placeholders verbatim with the test names from issue #29 / D-C1.

import { describe, it, vi } from "vitest";

const sentJobs: Array<{
  queue: string;
  data: Record<string, unknown>;
  options: Record<string, unknown>;
}> = [];

vi.mock("../../src/lib/server/queue-client.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getBoss: async () => ({
      send: async (
        queue: string,
        data: Record<string, unknown>,
        options: Record<string, unknown>,
      ) => {
        sentJobs.push({ queue, data, options });
        return "mock-job-id";
      },
    }),
  };
});

describe("refresh-content quota burn — Phase 03.0.3 P1 (issue #29)", () => {
  it.skip(
    "(a) repeated click within 5min on a steady-state channel costs ≤1 page (not N/50 pages)",
    () => {
      // Live body lands in Task 5 — exercises branch="exhausted".
    },
  );

  it.skip(
    "(b) backdated upload (publishedAt < newestKnown but > prior session) is collected on the next click",
    () => {
      // Live body lands in Task 5 — exercises branch="incremental".
    },
  );

  it.skip(
    "(c) widening backfillTargetSince (30d → epoch) triggers deep walk on next refresh-content click",
    () => {
      // Live body lands in Task 5 — exercises branch="deep" and D-#29-6
      // (no eager state reset on PATCH).
    },
  );
});
