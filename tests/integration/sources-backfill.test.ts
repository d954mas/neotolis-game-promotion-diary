// Phase 03.0 Plan 12 — /sources/new + createSource backfill-window wiring.
//
// The BackfillPicker (Plan 12 Task 2) submits a `backfill_window` field
// alongside the existing /api/sources POST body. createSource (services/
// data-sources.ts) accepts the new optional `backfillWindow` param and,
// for kind=youtube_channel + autoImport=true sources, enqueues a
// YOUTUBE_CHANNEL_CONTEXT_BACKFILL job carrying the window. Plan 09's
// handler (worker/handlers/youtube-channel-context-backfill.ts) reads the
// job.data.backfillWindow field — the contract is already in place.
//
// We mock pg-boss the same way tests/integration/ingest.test.ts does
// (vi.mock("queue-client") with sentJobs accumulator). The mock is hoisted
// by vitest, which is why the static import of createSource below works.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

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

import { createSource } from "../../src/lib/server/services/data-sources.js";
import { db } from "../../src/lib/server/db/client.js";
import { dataSources } from "../../src/lib/server/db/schema/data-sources.js";
import { seedUserDirectly } from "./helpers.js";

describe("Plan 03.0-12 — createSource backfillWindow → YOUTUBE_CHANNEL_CONTEXT_BACKFILL", () => {
  beforeEach(() => {
    sentJobs.length = 0;
  });

  it("kind=youtube_channel + autoImport=true + backfillWindow='90d' → enqueues backfill job carrying the window", async () => {
    const u = await seedUserDirectly({ email: "p12-bf-90d@test.local" });
    const src = await createSource(
      u.id,
      {
        kind: "youtube_channel",
        handleUrl: "https://www.youtube.com/@p12bf90",
        autoImport: true,
        backfillWindow: "90d",
      },
      "127.0.0.1",
    );

    expect(src.kind).toBe("youtube_channel");
    expect(src.autoImport).toBe(true);

    const enqueues = sentJobs.filter(
      (j) => j.queue === "youtube.channel_context_backfill",
    );
    expect(enqueues).toHaveLength(1);
    const job = enqueues[0]!;
    expect(job.data).toMatchObject({
      sourceId: src.id,
      userId: u.id,
      handleUrl: "https://www.youtube.com/@p12bf90",
      backfillWindow: "90d",
    });
    // singletonKey scopes the dedup window to this source row.
    expect((job.options as { singletonKey?: string }).singletonKey).toBe(
      `source-${src.id}`,
    );
  });

  it("kind=youtube_channel + autoImport=true + no backfillWindow → defaults to '30d'", async () => {
    const u = await seedUserDirectly({ email: "p12-bf-default@test.local" });
    await createSource(
      u.id,
      {
        kind: "youtube_channel",
        handleUrl: "https://www.youtube.com/@p12bfdef",
        autoImport: true,
      },
      "127.0.0.1",
    );

    const enqueues = sentJobs.filter(
      (j) => j.queue === "youtube.channel_context_backfill",
    );
    expect(enqueues).toHaveLength(1);
    expect(enqueues[0]!.data).toMatchObject({ backfillWindow: "30d" });
  });

  it("kind=youtube_channel + autoImport=false → ZERO backfill enqueues (auto-import OFF gates the trigger)", async () => {
    const u = await seedUserDirectly({ email: "p12-bf-noauto@test.local" });
    const src = await createSource(
      u.id,
      {
        kind: "youtube_channel",
        handleUrl: "https://www.youtube.com/@p12noauto",
        autoImport: false,
        backfillWindow: "everything",
      },
      "127.0.0.1",
    );

    expect(src.autoImport).toBe(false);
    const enqueues = sentJobs.filter(
      (j) => j.queue === "youtube.channel_context_backfill",
    );
    expect(enqueues).toHaveLength(0);

    // Source row still created — the BackfillPicker is a UX nicety, not
    // a precondition for source creation.
    const rows = await db
      .select()
      .from(dataSources)
      .where(eq(dataSources.id, src.id));
    expect(rows).toHaveLength(1);
  });

  it("non-YouTube kinds reject before the enqueue path runs (kind_not_yet_functional)", async () => {
    const u = await seedUserDirectly({ email: "p12-bf-nonyt@test.local" });
    await expect(
      createSource(
        u.id,
        {
          kind: "reddit_account",
          handleUrl: "https://reddit.com/user/p12",
          autoImport: true,
          backfillWindow: "everything",
        },
        "127.0.0.1",
      ),
    ).rejects.toMatchObject({ code: "kind_not_yet_functional" });

    expect(sentJobs).toHaveLength(0);
  });

  it("HTTP boundary: POST /api/sources accepts backfill_window in JSON body and returns 201", async () => {
    const { createApp } = await import("../../src/lib/server/http/app.js");
    const app = createApp();
    const u = await seedUserDirectly({ email: "p12-bf-http@test.local" });
    const res = await app.request("/api/sources", {
      method: "POST",
      headers: {
        cookie: `neotolis.session_token=${u.signedSessionCookieValue}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "youtube_channel",
        handleUrl: "https://www.youtube.com/@p12http",
        autoImport: true,
        backfillWindow: "7d",
      }),
    });
    expect(res.status).toBe(201);

    const enqueues = sentJobs.filter(
      (j) => j.queue === "youtube.channel_context_backfill",
    );
    expect(enqueues).toHaveLength(1);
    expect(enqueues[0]!.data).toMatchObject({ backfillWindow: "7d" });
  });
});
