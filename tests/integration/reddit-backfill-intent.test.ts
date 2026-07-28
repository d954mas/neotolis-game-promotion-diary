// Reddit backfillSource intent semantics (review-P1 fix).
//
// The refresh-content route threads the source's OWN backfillTargetSince into
// adapterSource.metadata; backfillSource must honor it as the walk's depth bound and
// pick the flow the walk-core branch decision needs:
//   - depthBoundIso = metadata.backfillTargetSince (NOT the epoch sentinel — an epoch
//     bound on a never-walked channel deep-walks the whole archive and pays for pages
//     the fan-out then discards at the per-subscriber target filter);
//   - flow = "initial" when the pull is effectively the source's first walk request —
//     the channel was never polled (autoImport=false skipped onSourceCreated), or the
//     channel is backfill-complete but this source wants strictly deeper than the
//     walked frontier (walk-core re-opens a complete channel's deep branch ONLY for
//     `initial`, so an `incremental` label silently drops the history request);
//   - flow = "incremental" for a routine pull on a walked channel;
//   - flow = "auto_passive" for a cron-origin pull.
//
// Asserted at the durable seam: backfillSource commits ONE outbox row via
// enqueueViaOutbox — read its payload back. Real Postgres via ./helpers.js.
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import { db } from "../../src/lib/server/db/client.js";
import { outbox } from "../../src/lib/server/db/schema/outbox.js";
import { dataSources } from "../../src/lib/server/db/schema/data-sources.js";
import { redditAdapter } from "../../src/lib/sources/reddit/server/index.js";
import {
  markChannelLastPolledAt,
  markChannelBackfillFrontier,
  markChannelBackfillComplete,
} from "../../src/lib/server/services/channel-state.js";
import { writeRedditBackfillState } from "../../src/lib/sources/reddit/server/backfill-state.js";

const uniq = (): string => Math.random().toString(36).slice(2, 8);
const DAY = 86_400_000;

interface WalkPayload {
  kind: string;
  channelKey: string;
  triggerUserId?: string;
  depthBoundIso: string;
  flow: string;
}

async function seedSource(
  handle: string,
): Promise<{ userId: string; source: { id: string; userId: string } }> {
  const u = await seedUserDirectly({ email: `rdt-intent-${uniq()}@t.io` });
  const [source] = await db
    .insert(dataSources)
    .values({
      userId: u.id,
      kind: "reddit_account",
      handleUrl: `https://www.reddit.com/user/${handle}`,
      channelId: handle,
      autoImport: false,
      metadata: { handle },
    })
    .returning({ id: dataSources.id, userId: dataSources.userId });
  return { userId: u.id, source: source! };
}

async function pull(
  source: { id: string; userId: string },
  handle: string,
  targetSince: Date | null,
  origin: "user" | "cron" = "user",
): Promise<WalkPayload> {
  const { jobId } = await redditAdapter.backfillSource(
    {
      id: source.id,
      userId: source.userId,
      metadata: {
        handle,
        channelId: handle,
        backfillTargetSince: targetSince?.toISOString(),
      },
    },
    { userId: source.userId, origin },
  );
  expect(jobId).not.toBeNull();
  const [row] = await db
    .select({ payload: outbox.payload })
    .from(outbox)
    .where(eq(outbox.id, jobId!));
  return row!.payload as unknown as WalkPayload;
}

describe("reddit backfillSource intent semantics (review-P1)", () => {
  it("a NEVER-WALKED channel's first manual pull is flow=initial bounded by the source's backfillTargetSince", async () => {
    const handle = `intent_${uniq()}`;
    const { source } = await seedSource(handle);
    const target = new Date(Date.now() - 30 * DAY);

    const payload = await pull(source, handle, target);

    expect(payload.kind).toBe("reddit_account");
    expect(payload.channelKey).toBe(handle);
    expect(payload.triggerUserId).toBe(source.userId);
    expect(payload.depthBoundIso, "the requested window, never the epoch sentinel").toBe(
      target.toISOString(),
    );
    expect(payload.flow, "first walk request carries initial semantics").toBe("initial");
  });

  it("a routine pull on a WALKED (incomplete) channel stays flow=incremental with the source's bound", async () => {
    const handle = `intent_${uniq()}`;
    const { source } = await seedSource(handle);
    const target = new Date(Date.now() - 30 * DAY);
    await markChannelLastPolledAt("reddit_account", handle);

    const payload = await pull(source, handle, target);

    expect(payload.flow).toBe("incremental");
    expect(payload.depthBoundIso).toBe(target.toISOString());
  });

  it("a subscriber wanting DEEPER than a COMPLETE channel's frontier gets flow=initial (walk-core re-opens only for initial)", async () => {
    const handle = `intent_${uniq()}`;
    const { source } = await seedSource(handle);
    await markChannelLastPolledAt("reddit_account", handle);
    await markChannelBackfillFrontier("reddit_account", handle, new Date(Date.now() - 60 * DAY));
    await markChannelBackfillComplete("reddit_account", handle);

    // Deeper than the 60d frontier → initial; shallower → routine incremental.
    const deeper = await pull(source, handle, new Date(Date.now() - 365 * DAY));
    expect(deeper.flow, "deeper-than-frontier on a complete channel re-opens").toBe("initial");

    const shallower = await pull(source, handle, new Date(Date.now() - 30 * DAY));
    expect(shallower.flow, "already-covered window stays the cheap sweep").toBe("incremental");
  });

  it("a target an already-COMPLETED deep pass walked FOR is settled — routine pulls stay incremental", async () => {
    // The frontier can be permanently shallower than the target (feed bottom above it,
    // or the maxPosts cap): `target < frontier` alone would relabel EVERY routine pull
    // as `initial` and re-pay a deep re-walk that imports nothing, forever. The
    // servedDeepTargetIso memory settles the already-served target; only a strictly
    // deeper NEW target earns one more `initial`.
    const handle = `intent_${uniq()}`;
    const { source } = await seedSource(handle);
    const served = new Date(Date.now() - 30 * DAY);
    await markChannelLastPolledAt("reddit_account", handle);
    // Feed bottom at 12d — the 30d target was walked FOR but never reached.
    await markChannelBackfillFrontier("reddit_account", handle, new Date(Date.now() - 12 * DAY));
    await markChannelBackfillComplete("reddit_account", handle);
    await writeRedditBackfillState("reddit_account", handle, {
      cursor: null,
      complete: true,
      collected: 3,
      operatorPaused: false,
      deepTargetIso: null,
      emptyPasses: 0,
      notFoundPasses: 0,
      servedDeepTargetIso: served.toISOString(),
    });

    const same = await pull(source, handle, served);
    expect(same.flow, "the served target never relabels as initial again").toBe("incremental");

    const deeper = await pull(source, handle, new Date(Date.now() - 365 * DAY));
    expect(deeper.flow, "a strictly deeper NEW target still earns one initial").toBe("initial");
  });

  it("a cron-origin pull stays flow=auto_passive with no trigger user", async () => {
    const handle = `intent_${uniq()}`;
    const { source } = await seedSource(handle);
    await markChannelLastPolledAt("reddit_account", handle);

    const payload = await pull(source, handle, new Date(Date.now() - 30 * DAY), "cron");

    expect(payload.flow).toBe("auto_passive");
    expect(payload.triggerUserId).toBeUndefined();
  });

  it("a source with NO backfillTargetSince falls back to the epoch bound", async () => {
    const handle = `intent_${uniq()}`;
    const { source } = await seedSource(handle);
    await markChannelLastPolledAt("reddit_account", handle);

    const payload = await pull(source, handle, null);

    expect(payload.depthBoundIso).toBe("1970-01-01T00:00:00Z");
    expect(payload.flow).toBe("incremental");
  });
});
