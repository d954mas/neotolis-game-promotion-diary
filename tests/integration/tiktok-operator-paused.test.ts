// BUDGET-01 producer wiring (TikTok) — the PollingBadge "Paused · operator budget
// reached" hint, end to end, against real Postgres.
//
// THE PRODUCER: the walker (handleBackfillAccount) flips
// metadata.tiktok.operatorPaused on the per-account channel-state row (the source of
// truth it owns via backfill-state.ts) when a tick is paused because the operator's
// prepaid social budget refused a page reserve (AdapterError operator-issue), and
// CLEARS it on a successful unpaused tick. The read side (tiktokEnrichFeedDtos)
// overlays that flag onto each TikTok event DTO's metadata.operator_paused at load
// time — so the badge lights up.
//
// The ScrapeCreators boundary is faked at the PROVIDER SEAM. The DB is REAL. The
// budget pause is simulated by the faked provider throwing AdapterError
// (operator-issue) — the SAME error http.ts throws on a depleted prepaid balance.
//
// Requirements: PLAT-02.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { ProviderPage } from "../../src/lib/sources/social-provider.js";

interface ScriptedProvider {
  paused: boolean;
  page: ProviderPage | null;
}
const provider: ScriptedProvider = { paused: false, page: null };

function emptyPage(): ProviderPage {
  return { posts: [], nextCursor: null, endOfFeed: true, creditsUsed: 1, owner: null };
}

vi.mock("../../src/lib/sources/tiktok/server/provider/registry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const { AdapterError: AE } = await import("../../src/lib/sources/errors.js");
  return {
    ...actual,
    isTikTokConfigured: () => true,
    getSocialProvider: (platform: string) => {
      if (platform !== "tiktok") return null;
      return {
        name: "scrapecreators",
        async fetchPosts(): Promise<ProviderPage> {
          if (provider.paused) {
            throw new AE("operator budget exhausted (prepaid balance <= 0)", {
              category: "operator-issue",
            });
          }
          return provider.page ?? emptyPage();
        },
        async resolveAccount() {
          return { accountId: "acct-paused-tk", displayName: "Test" };
        },
      };
    },
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { handleBackfillAccount } =
  await import("../../src/lib/sources/tiktok/server/handlers/backfill-account.js");
const { getTikTokBackfillState } =
  await import("../../src/lib/sources/tiktok/server/backfill-state.js");
const { tiktokEnrichFeedDtos } =
  await import("../../src/lib/sources/tiktok/server/feed-enrichment.js");
const { mapEventsToDtos } = await import("../../src/lib/server/dto.js");

const ACCOUNT = "acct-paused-tk";

function post(id: string, daysAgo: number) {
  return {
    id,
    kind: "video" as const,
    publishedAt: new Date(Date.now() - daysAgo * 86_400_000),
    metrics: { views: 1000, likes: 10, comments: 2, shares: 50 },
    caption: `caption ${id}`,
    thumbnailUrl: `https://cdn.tiktokcdn-us.com/${id}.awebp`,
    permalink: `https://www.tiktok.com/@pausedacct/video/${id}`,
  };
}

async function seedSource(): Promise<{ userId: string }> {
  const user = await seedUserDirectly({ email: `paused-tk-${Math.random()}@t.io` });
  await db.insert(dataSources).values({
    userId: user.id,
    kind: "tiktok_account",
    handleUrl: "https://www.tiktok.com/@pausedacct",
    channelId: ACCOUNT,
    isOwnedByMe: true,
    autoImport: true,
    metadata: { handle: "pausedacct", accountId: ACCOUNT },
  });
  return { userId: user.id };
}

/** Run the production read path: project the user's TikTok events to DTOs (metadata
 *  comes verbatim from the events row) and run the adapter's enrichFeedDtos overlay.
 *  Returns the operator_paused flag the PollingBadge consumes for the first event. */
async function readOperatorPausedFlag(userId: string): Promise<boolean> {
  const rows = await db.select().from(events).where(eq(events.userId, userId));
  const dtos = await mapEventsToDtos(userId, rows);
  await tiktokEnrichFeedDtos(userId, dtos);
  const tkDto = dtos.find((d) => d.kind === "tiktok_post");
  expect(tkDto, "expected at least one tiktok_post event to enrich").toBeTruthy();
  const meta = tkDto!.metadata;
  if (meta === null || typeof meta !== "object") return false;
  return (meta as { operator_paused?: unknown }).operator_paused === true;
}

beforeEach(() => {
  provider.paused = false;
  provider.page = null;
});

describe("BUDGET-01: tiktok operator_paused producer (walker sets/clears, reader overlays)", () => {
  it("[10-04] a budget-paused tick SETS metadata.operator_paused; a restored tick CLEARS it", async () => {
    const { userId } = await seedSource();

    // ── Tick A: a successful walk imports one post + writes its cache row, so the
    //    read side has an event to enrich. Not paused → operator_paused absent.
    provider.paused = false;
    provider.page = {
      posts: [post("tk-p1", 1)],
      nextCursor: null,
      endOfFeed: true,
      creditsUsed: 1,
      owner: null,
    };
    await handleBackfillAccount({
      data: {
        kind: "tiktok_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
    });

    expect((await getTikTokBackfillState(ACCOUNT)).operatorPaused).toBe(false);
    expect(await readOperatorPausedFlag(userId)).toBe(false);

    // ── Tick B: the operator's prepaid budget is exhausted — the provider's reserve
    //    throws AdapterError(operator-issue). The walker catches it, pauses, and
    //    persists operatorPaused=true. The badge must now read operator_paused === true.
    provider.paused = true;
    await handleBackfillAccount({
      data: {
        kind: "tiktok_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "incremental",
      },
    });

    expect((await getTikTokBackfillState(ACCOUNT)).operatorPaused).toBe(true);
    // THE LOAD-BEARING ASSERTION: the exact field PollingBadge consumes is true.
    expect(await readOperatorPausedFlag(userId)).toBe(true);

    // ── Tick C: budget restored. A successful unpaused tick clears the flag so the
    //    badge is NOT sticky.
    provider.paused = false;
    provider.page = emptyPage();
    await handleBackfillAccount({
      data: {
        kind: "tiktok_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "incremental",
      },
    });

    expect((await getTikTokBackfillState(ACCOUNT)).operatorPaused).toBe(false);
    expect(await readOperatorPausedFlag(userId)).toBe(false);
  });
});
