// BUDGET-01 producer wiring — the PollingBadge "Paused · operator budget
// reached" hint, end to end, against real Postgres.
//
// THE CONSUMER CONTRACT (src/lib/components/PollingBadge.svelte): the badge
// reads `event.metadata.operator_paused === true`, where `event.metadata` is
// the events-row jsonb column projected verbatim by toEventDto. There is NO
// stored events-row write of operator_paused — it would denormalize a
// per-account budget state onto every event row (AGENTS.md no-denorm P0).
//
// THE PRODUCER (this test proves it): the walker (handleBackfillAccount) flips
// `metadata.instagram.operatorPaused` on the per-account channel-state row
// (the source of truth it already owns via backfill-state.ts) when a tick is
// paused because the operator's prepaid social budget refused a page reserve
// (AdapterError operator-issue), and CLEARS it on a successful unpaused tick.
// The read side (instagramEnrichFeedDtos) overlays that flag onto each IG
// event DTO's metadata.operator_paused at load time — exactly the way
// fetchPollStateMap overlays publishedAt/lastPolledAt. So the badge lights up.
//
// The ScrapeCreators boundary is faked at the PROVIDER SEAM (vi.mock of
// provider/registry's getSocialProvider). The DB is REAL. The budget pause is
// simulated by the faked provider throwing AdapterError(operator-issue) — the
// SAME error http.ts throws on a depleted prepaid balance (a null permit). We
// never mock the budget engine or the DB.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { ProviderPage } from "../../src/lib/sources/social-provider.js";

// Scripted provider with a budget-pause switch. When `paused` is true,
// fetchPosts throws AdapterError(operator-issue) — the depleted-prepaid-balance
// null-permit shape http.ts produces. Otherwise it shifts the next scripted
// page off the per-feed queue.
interface ScriptedProvider {
  paused: boolean;
  pages: { posts: ProviderPage[]; reels: ProviderPage[] };
}

const provider: ScriptedProvider = { paused: false, pages: { posts: [], reels: [] } };

function emptyPage(): ProviderPage {
  return { posts: [], nextCursor: null, endOfFeed: true, creditsUsed: 1 };
}

vi.mock("../../src/lib/sources/instagram/server/provider/registry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const { AdapterError: AE } = await import("../../src/lib/sources/errors.js");
  return {
    ...actual,
    isInstagramConfigured: () => true,
    getSocialProvider: (platform: string) => {
      if (platform !== "instagram") return null;
      return {
        name: "scrapecreators",
        async fetchPosts(
          _platform: string,
          _handle: string,
          _cursor: string | null,
          opts: { kindFilter?: "posts" | "reels" },
        ): Promise<ProviderPage> {
          if (provider.paused) {
            // The depleted-prepaid-balance null permit: the reserve inside the
            // HTTP seam refuses the page before the request. http.ts surfaces
            // exactly this category (BUDGET-02 / Plan 05).
            throw new AE("operator budget exhausted (prepaid balance <= 0)", {
              category: "operator-issue",
            });
          }
          const feed = opts.kindFilter ?? "posts";
          const next = provider.pages[feed].shift();
          return next ?? emptyPage();
        },
        async resolveAccount() {
          return { accountId: "acct-test", displayName: "Test" };
        },
      };
    },
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { handleBackfillAccount } = await import(
  "../../src/lib/sources/instagram/server/handlers/backfill-account.js"
);
const { getInstagramBackfillState } = await import(
  "../../src/lib/sources/instagram/server/backfill-state.js"
);
const { instagramEnrichFeedDtos } = await import(
  "../../src/lib/sources/instagram/server/feed-enrichment.js"
);
const { mapEventsToDtos } = await import("../../src/lib/server/dto.js");

const ACCOUNT = "acct-paused";

function post(id: string, daysAgo: number) {
  return {
    id,
    kind: "image" as const,
    publishedAt: new Date(Date.now() - daysAgo * 86_400_000),
    metrics: { views: null, likes: 10, comments: 2, shares: null },
    caption: `caption ${id}`,
    thumbnailUrl: `https://cdn/${id}.jpg`,
    permalink: `https://www.instagram.com/p/${id}/`,
  };
}

async function seedSource(): Promise<{ userId: string; sourceId: string }> {
  const user = await seedUserDirectly({
    email: `paused-${Math.random().toString(36).slice(2)}@t.io`,
  });
  const [row] = await db
    .insert(dataSources)
    .values({
      userId: user.id,
      kind: "instagram_account",
      handleUrl: "https://www.instagram.com/pausedacct/",
      channelId: ACCOUNT,
      isOwnedByMe: true,
      autoImport: true,
      metadata: { handle: "pausedacct", accountId: ACCOUNT },
    })
    .returning({ id: dataSources.id });
  return { userId: user.id, sourceId: row!.id };
}

/** Run the production read path: project the user's IG events to DTOs (metadata
 *  comes verbatim from the events row, exactly as /feed does) and run the
 *  adapter's enrichFeedDtos overlay. Returns the operator_paused flag the
 *  PollingBadge consumes for the first IG event. */
async function readOperatorPausedFlag(userId: string): Promise<boolean> {
  const rows = await db.select().from(events).where(eq(events.userId, userId));
  const dtos = await mapEventsToDtos(userId, rows);
  await instagramEnrichFeedDtos(userId, dtos);
  const igDto = dtos.find((d) => d.kind === "instagram_post");
  expect(igDto, "expected at least one instagram_post event to enrich").toBeTruthy();
  const meta = igDto!.metadata;
  if (meta === null || typeof meta !== "object") return false;
  return (meta as { operator_paused?: unknown }).operator_paused === true;
}

beforeEach(() => {
  provider.paused = false;
  provider.pages = { posts: [], reels: [] };
});

describe("BUDGET-01: operator_paused producer (walker sets/clears, reader overlays)", () => {
  it("a budget-paused tick SETS metadata.operator_paused on the consumer's event; a restored tick CLEARS it", async () => {
    const { userId } = await seedSource();

    // ── Tick A: a successful walk imports one post + writes its cache row, so
    //    the read side has an event to enrich. Not paused → operator_paused
    //    absent (false).
    provider.paused = false;
    provider.pages.posts = [
      { posts: [post("ig-p1", 1)], nextCursor: null, endOfFeed: true, creditsUsed: 1 },
    ];
    provider.pages.reels = [emptyPage()];
    await handleBackfillAccount({
      data: {
        kind: "instagram_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
    });

    expect((await getInstagramBackfillState(ACCOUNT)).operatorPaused).toBe(false);
    expect(await readOperatorPausedFlag(userId)).toBe(false);

    // ── Tick B: the operator's prepaid budget is exhausted — the provider's
    //    reserve throws AdapterError(operator-issue) on the first feed. The
    //    walker catches it, pauses, and persists operatorPaused=true. The badge
    //    must now read operator_paused === true.
    provider.paused = true;
    await handleBackfillAccount({
      data: {
        kind: "instagram_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "incremental",
      },
    });

    expect((await getInstagramBackfillState(ACCOUNT)).operatorPaused).toBe(true);
    // THE LOAD-BEARING ASSERTION: the exact field PollingBadge consumes is true.
    expect(await readOperatorPausedFlag(userId)).toBe(true);

    // ── Tick C: budget restored (operator topped up the balance). A successful
    //    unpaused tick clears the flag so the badge is NOT sticky.
    provider.paused = false;
    provider.pages.posts = [emptyPage()];
    provider.pages.reels = [emptyPage()];
    await handleBackfillAccount({
      data: {
        kind: "instagram_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "incremental",
      },
    });

    expect((await getInstagramBackfillState(ACCOUNT)).operatorPaused).toBe(false);
    // THE LOAD-BEARING ASSERTION (the other half): the field flips back to false.
    expect(await readOperatorPausedFlag(userId)).toBe(false);
  });
});
