// Channel-state helpers integration test.
//
// Exercises the channel-scoped polling state service. Channels are global
// (not tenant-owned), so this file does not seed users or sources — the
// helpers operate on (kind, channelKey) keys directly. Worker fan-out to
// per-user events is covered separately in the worker tests.

import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import { dataSourceChannelState } from "../../src/lib/server/db/schema/data-source-channel-state.js";
import {
  getChannelState,
  ensureChannelState,
  markChannelLastPolledAt,
  markChannelBackfillFrontier,
  markChannelBackfillComplete,
  setChannelBackfillPageToken,
} from "../../src/lib/server/services/channel-state.js";

const uniqKey = (): string => `UC${Math.random().toString(36).slice(2, 24).padEnd(22, "x")}`;

async function clearChannel(channelKey: string): Promise<void> {
  await db
    .delete(dataSourceChannelState)
    .where(
      and(
        eq(dataSourceChannelState.kind, "youtube_channel"),
        eq(dataSourceChannelState.channelKey, channelKey),
      ),
    );
}

describe("channel-state helpers", () => {
  let channelKey: string;

  beforeEach(async () => {
    channelKey = uniqKey();
    await clearChannel(channelKey);
  });

  it("getChannelState returns undefined when no row exists", async () => {
    const row = await getChannelState("youtube_channel", channelKey);
    expect(row).toBeUndefined();
  });

  it("ensureChannelState creates a row idempotently", async () => {
    await ensureChannelState("youtube_channel", channelKey);
    await ensureChannelState("youtube_channel", channelKey);
    const row = await getChannelState("youtube_channel", channelKey);
    expect(row).toBeDefined();
    expect(row!.kind).toBe("youtube_channel");
    expect(row!.channelKey).toBe(channelKey);
    expect(row!.backfillComplete).toBe(false);
    expect(row!.lastPolledAt).toBeNull();
  });

  it("markChannelLastPolledAt auto-creates and stamps NOW", async () => {
    const before = Date.now();
    await markChannelLastPolledAt("youtube_channel", channelKey);
    const row = await getChannelState("youtube_channel", channelKey);
    expect(row?.lastPolledAt).not.toBeNull();
    expect(row!.lastPolledAt!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("markChannelBackfillFrontier moves frontier deeper but never rolls back", async () => {
    const t1 = new Date("2024-01-01T00:00:00Z");
    const t2 = new Date("2023-01-01T00:00:00Z"); // deeper
    const t3 = new Date("2025-01-01T00:00:00Z"); // newer (would roll back)

    await markChannelBackfillFrontier("youtube_channel", channelKey, t1);
    let row = await getChannelState("youtube_channel", channelKey);
    expect(row!.backfillOldestAt!.getTime()).toBe(t1.getTime());

    await markChannelBackfillFrontier("youtube_channel", channelKey, t2);
    row = await getChannelState("youtube_channel", channelKey);
    expect(row!.backfillOldestAt!.getTime()).toBe(t2.getTime());

    // Race-safety: t3 is newer than current t2, must NOT update.
    await markChannelBackfillFrontier("youtube_channel", channelKey, t3);
    row = await getChannelState("youtube_channel", channelKey);
    expect(row!.backfillOldestAt!.getTime()).toBe(t2.getTime());
  });

  it("markChannelBackfillComplete sets the flag", async () => {
    // The companion reset helper was removed. The "trust-but-verify"
    // toggle was redundant once the three-branch since-derivation
    // landed; only the set-true direction is
    // exercised here now. Widening a user's backfill_target_since lands
    // in the `deep` branch lazily on the next refresh-content click —
    // no in-band flag flip required.
    await markChannelBackfillComplete("youtube_channel", channelKey);
    const row = await getChannelState("youtube_channel", channelKey);
    expect(row!.backfillComplete).toBe(true);
  });

  it("setChannelBackfillPageToken stores and clears the cursor", async () => {
    await setChannelBackfillPageToken("youtube_channel", channelKey, "TOKEN_A");
    let row = await getChannelState("youtube_channel", channelKey);
    expect((row!.metadata as { lastBackfillPageToken?: string }).lastBackfillPageToken).toBe(
      "TOKEN_A",
    );

    await setChannelBackfillPageToken("youtube_channel", channelKey, "TOKEN_B");
    row = await getChannelState("youtube_channel", channelKey);
    expect((row!.metadata as { lastBackfillPageToken?: string }).lastBackfillPageToken).toBe(
      "TOKEN_B",
    );

    await setChannelBackfillPageToken("youtube_channel", channelKey, null);
    row = await getChannelState("youtube_channel", channelKey);
    expect(
      (row!.metadata as { lastBackfillPageToken?: string }).lastBackfillPageToken,
    ).toBeUndefined();
  });

  it("kind discriminator — distinct channelKeys produce separate state rows", async () => {
    // No reddit_account adapter yet, but the table key supports both kinds.
    // Use the existing youtube_channel kind and synthesize a different
    // channelKey to verify PK discrimination. The earlier shape of this
    // test asserted that the two lastPolledAt timestamps differed, which
    // was flaky: on a fast CI runner both calls land in the same
    // millisecond (now() resolution) and the rows are correctly stored
    // but the timestamp check fails. The honest assertion for "separate
    // rows" is that the rows exist with distinct channelKeys, both
    // carry a stamped lastPolledAt, and they don't reference each
    // other.
    const k1 = uniqKey();
    const k2 = uniqKey();
    await markChannelLastPolledAt("youtube_channel", k1);
    await markChannelLastPolledAt("youtube_channel", k2);
    const r1 = await getChannelState("youtube_channel", k1);
    const r2 = await getChannelState("youtube_channel", k2);
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
    expect(r1!.channelKey).toBe(k1);
    expect(r2!.channelKey).toBe(k2);
    expect(r1!.channelKey).not.toBe(r2!.channelKey);
    expect(r1!.lastPolledAt).not.toBeNull();
    expect(r2!.lastPolledAt).not.toBeNull();
    await clearChannel(k1);
    await clearChannel(k2);
  });
});
