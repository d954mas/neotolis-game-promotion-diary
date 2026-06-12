// /sources/new + createSource backfill-window wiring.
//
// The BackfillPicker submits a `backfill_window` field alongside the
// existing /api/sources POST body. createSource accepts the optional
// `backfillWindow` param and, for kind=youtube_channel + autoImport=true
// sources, writes a YOUTUBE_CHANNEL_CONTEXT_BACKFILL intent to the
// transactional outbox. The forwarder later calls pg-boss; this test
// asserts the atomic DB contract instead of mocking the queue client.

import { describe, it, expect } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import { createSource } from "../../src/lib/server/services/data-sources.js";
import { db } from "../../src/lib/server/db/client.js";
import { dataSources } from "../../src/lib/server/db/schema/data-sources.js";
import { outbox } from "../../src/lib/server/db/schema/outbox.js";
import { seedUserDirectly } from "./helpers.js";

async function loadChannelContextBackfillRows(sourceId: string) {
  return db
    .select()
    .from(outbox)
    .where(
      and(
        eq(outbox.queue, "youtube.channel_context_backfill"),
        sql`${outbox.payload}->>'sourceId' = ${sourceId}`,
      ),
    );
}

describe("createSource backfillWindow -> YOUTUBE_CHANNEL_CONTEXT_BACKFILL", () => {
  it("kind=youtube_channel + autoImport=true + backfillWindow='90d' -> writes outbox job carrying the window", async () => {
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

    const rows = await loadChannelContextBackfillRows(src.id);
    expect(rows).toHaveLength(1);
    const job = rows[0]!;
    expect(job.payload).toMatchObject({
      sourceId: src.id,
      userId: u.id,
      handleUrl: "https://www.youtube.com/@p12bf90",
      backfillWindow: "90d",
    });
    expect(job.options.singletonKey).toBe(`source-${src.id}`);
  });

  it("kind=youtube_channel + autoImport=true + no backfillWindow -> outbox job defaults to '30d'", async () => {
    const u = await seedUserDirectly({ email: "p12-bf-default@test.local" });
    const src = await createSource(
      u.id,
      {
        kind: "youtube_channel",
        handleUrl: "https://www.youtube.com/@p12bfdef",
        autoImport: true,
      },
      "127.0.0.1",
    );

    const rows = await loadChannelContextBackfillRows(src.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ backfillWindow: "30d" });
  });

  it("kind=youtube_channel + autoImport=false -> ZERO backfill outbox rows (auto-import OFF gates the trigger)", async () => {
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
    const rows = await loadChannelContextBackfillRows(src.id);
    expect(rows).toHaveLength(0);

    const sourceRows = await db.select().from(dataSources).where(eq(dataSources.id, src.id));
    expect(sourceRows).toHaveLength(1);
  });

  it("non-functional kinds reject before the enqueue path runs (kind_not_yet_functional)", async () => {
    const u = await seedUserDirectly({ email: "p12-bf-nonyt@test.local" });
    // discord_server is the remaining schema-only kind (Phase 11 activated
    // twitter_account, which now degrades to kind_not_configured, not
    // kind_not_yet_functional — see twitter-not-configured.test.ts).
    await expect(
      createSource(
        u.id,
        {
          kind: "discord_server",
          handleUrl: "https://discord.gg/p12",
          autoImport: true,
          backfillWindow: "everything",
        },
        "127.0.0.1",
      ),
    ).rejects.toMatchObject({ code: "kind_not_yet_functional" });
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
    const body = (await res.json()) as { id: string };

    const rows = await loadChannelContextBackfillRows(body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ backfillWindow: "7d" });
  });
});
