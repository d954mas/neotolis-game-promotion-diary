// Telegram live paste-preview — synchronous single-post fetch for Add Event
// (Phase-9 gap C1: pasting a t.me post URL used to dead-end with
// kind_not_yet_functional / 422).
//
// Pasting a t.me/<channel>/<id> link in the Add Event flow now RECOGNIZES the
// kind + URL AND auto-fills title (post first line) + thumbnail + occurredAt via
// a synchronous ?embed=1 t.me fetch, mirroring the Reddit + Instagram pattern:
//   - enrichFromUrl(telegram_post) dispatches to
//     telegramAdapter.fetchEventPreviewMetadata, which issues ONE ?embed=1 GET
//     (FREE — no credit, no cap; the structural contrast with IG/Reddit), then
//     UPSERTs the telegram_posts cache + a snapshot so the saved event renders
//     views immediately in /feed.
//   - #1: the externalId is the rename-proof "<channelKey>/<messageId>" the
//     preview decodes from the post's data-view and OVERRIDES via
//     EventPreviewMetadata.externalId (mirrors IG's media-id override). The
//     URL-parsed "<slug>/<messageId>" is NEVER stored. On save, createEvent's
//     resolveCachedExternalId recovers the same channelKey id from the cache
//     (telegram_post is EXCLUDED from the slug-deriving parseAnyUrl path).
//   - A failed preview (parse-null deleted post, rate-limited / network error,
//     or an undecodable channelKey) degrades to recognition-only with
//     externalId=null (NEVER a slug id) so the user can still save a bare manual
//     event — NEVER a 422 dead-end (the IG #69 rule).
//
// Integration test — real Postgres via tests/setup.ts; ONLY the upstream t.me
// fetch (the http layer's fetchTelegramPost) is mocked. NEVER the DB, NEVER the
// parser, NEVER writeTelegramSnapshot — the real parser + real snapshot writer
// run against real Postgres so the cache/snapshot rows are genuine.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/telegram");
const SINGLE_POST_EMBED = readFileSync(join(FIXTURE_DIR, "single-post-embed.html"), "utf8");

// A controllable single-post fetcher: the test pushes the next HTML response (or
// a throw) before driving enrichFromUrl. `calls` records (channel, messageId) so
// the wiring (URL-derived split) is assertable. The DEFAULT pacer is asserted
// indirectly: the sync path passes "acquire" (the worker-only "already-acquired"
// would dead-letter), so the mock just records the channel/messageId it received.
interface ScriptedFetch {
  next: string | (() => never);
  calls: Array<{ channel: string; messageId: string }>;
}
const tg: ScriptedFetch = { next: SINGLE_POST_EMBED, calls: [] };

vi.mock("../../src/lib/sources/telegram/server/http.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    async fetchTelegramPost(channel: string, messageId: string): Promise<string> {
      tg.calls.push({ channel, messageId });
      if (typeof tg.next === "function") {
        tg.next();
        throw new Error("tg.next() was expected to throw");
      }
      return tg.next;
    },
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { telegramPosts, telegramPostSnapshots } =
  await import("../../src/lib/server/db/schema/index.js");
const { enrichFromUrl, createEvent } =
  await import("../../src/lib/server/services/events-mutation.js");
const { mapEventsToDtos } = await import("../../src/lib/server/dto.js");
const { telegramEnrichFeedDtos } =
  await import("../../src/lib/sources/telegram/server/feed-enrichment.js");
const { AdapterError } = await import("../../src/lib/sources/errors.js");

interface TelegramEnrichment {
  stats: { viewCount: number | null; polledAt: Date } | null;
  thumbnailUrl: string | null;
  mediaKind: string | null;
}

// The byte-exact single-post-embed fixture parses to data-view c = -1006503122,
// messageId 505, 3.71M views (asserted in tests/unit/sources/telegram/parse.test.ts).
// The paste URL is the human/slug form t.me/durov/505; the STORED post id (#1) is
// the channelKey-based "-1006503122/505". The two diverge — that divergence is
// the whole point of #1.
const FIXTURE_CHANNEL = "durov";
const FIXTURE_MESSAGE_ID = "505";
const FIXTURE_CHANNEL_KEY = "-1006503122";
// The URL the user pastes (slug form) vs the STORED canonical key (channelKey form).
const FIXTURE_SLUG_PATH = `${FIXTURE_CHANNEL}/${FIXTURE_MESSAGE_ID}`;
const FIXTURE_POST_ID = `${FIXTURE_CHANNEL_KEY}/${FIXTURE_MESSAGE_ID}`;
const FIXTURE_URL = `https://t.me/${FIXTURE_SLUG_PATH}`;

beforeEach(() => {
  tg.next = SINGLE_POST_EMBED;
  tg.calls = [];
});

describe("telegram live paste-preview (single-post ?embed=1 fetch — Phase-9 C1)", () => {
  it("no longer dead-ends with kind_not_yet_functional — a pasted t.me post URL enriches", async () => {
    const user = await seedUserDirectly({
      email: `tg-preview-ok-${Math.random().toString(36).slice(2)}@t.io`,
    });

    const result = await enrichFromUrl(user.id, FIXTURE_URL, "127.0.0.1");

    expect(result.kind).toBe("telegram_post");
    // #1 — externalId is the channelKey-based key the preview OVERRODE from the
    // post's data-view ("-1006503122/505"), NOT the URL slug id ("durov/505").
    expect(result.externalId).toBe(FIXTURE_POST_ID);
    expect(result.externalId).not.toBe(FIXTURE_SLUG_PATH);
    // Title = the post's first text line (non-empty; the Add Event form requires
    // one). The fixture is a real durov post, so the title is its first line.
    expect(result.title.length).toBeGreaterThan(0);
    expect(result.occurredAt).toBeInstanceOf(Date);
    // authorName/url = the channel handle (no per-post author on a TG channel).
    expect(result.authorName).toBe(FIXTURE_CHANNEL);
    expect(result.authorUrl).toBe(`https://t.me/${FIXTURE_CHANNEL}`);
    expect(result.canonicalUrl).toBe(FIXTURE_URL);

    // The upstream fetch ran once with the URL-derived channel/messageId.
    expect(tg.calls).toHaveLength(1);
    expect(tg.calls[0]).toEqual({ channel: FIXTURE_CHANNEL, messageId: FIXTURE_MESSAGE_ID });
  });

  it("UPSERTs the telegram_posts cache row + a snapshot so the saved event renders views", async () => {
    const user = await seedUserDirectly({
      email: `tg-preview-cache-${Math.random().toString(36).slice(2)}@t.io`,
    });

    await enrichFromUrl(user.id, FIXTURE_URL, "127.0.0.1");

    const [cached] = await db
      .select()
      .from(telegramPosts)
      .where(eq(telegramPosts.postId, FIXTURE_POST_ID));
    expect(cached).toBeDefined();
    expect(cached!.externalUrl).toBe(FIXTURE_URL);
    expect(cached!.lastPollStatus).toBe("ok");

    const snaps = await db
      .select()
      .from(telegramPostSnapshots)
      .where(eq(telegramPostSnapshots.postId, FIXTURE_POST_ID));
    expect(snaps).toHaveLength(1);
    // The fixture parses to 3.71M views (parse.test.ts oracle).
    expect(snaps[0]!.viewCount).toBe(3710000);
  });

  it("end-to-end: a pasted TG post saves with the channelKey-based id (resolved from cache) so feed-enrichment matches (thumbnail + views)", async () => {
    const user = await seedUserDirectly({
      email: `tg-e2e-${Math.random().toString(36).slice(2)}@t.io`,
    });

    // 1. Preview (the "Fetch" button) → enriched fields the form pre-fills. The
    //    preview OVERRODE externalId to the channelKey-based key (#1).
    const enriched = await enrichFromUrl(user.id, FIXTURE_URL, "127.0.0.1");
    expect(enriched.externalId).toBe(FIXTURE_POST_ID);

    // 2. Save the event WITHOUT passing an explicit externalId — telegram_post is
    //    EXCLUDED from the slug-deriving parseAnyUrl path (#1), so createEvent's
    //    resolveCachedExternalId recovers the SAME channelKey-based id from the
    //    telegram_posts cache the preview just UPSERTed (keyed by external_url),
    //    NOT the renameable slug id.
    const created = await createEvent(
      user.id,
      {
        kind: "telegram_post",
        title: enriched.title || "manual TG post",
        occurredAt: enriched.occurredAt ?? new Date(),
        url: enriched.canonicalUrl,
      },
      "127.0.0.1",
    );

    expect(created.externalId).toBe(FIXTURE_POST_ID);
    const [cached] = await db
      .select()
      .from(telegramPosts)
      .where(eq(telegramPosts.postId, FIXTURE_POST_ID));
    expect(cached).toBeDefined();
    expect(created.externalId).toBe(cached!.postId);

    // 3. Run the read path the /feed loader uses. With the wrong id it would find
    //    no matching telegram_posts row → no views. With the URL-derived
    //    composite it enriches fully.
    const dtos = await mapEventsToDtos(user.id, [created]);
    await telegramEnrichFeedDtos(user.id, dtos);

    const decorated = dtos[0] as (typeof dtos)[0] & { telegramEnrichment?: TelegramEnrichment };
    expect(decorated.telegramEnrichment).toBeDefined();
    expect(decorated.telegramEnrichment!.stats).not.toBeNull();
    expect(decorated.telegramEnrichment!.stats!.viewCount).toBe(3710000);
  });

  it("slug reuse: 2 telegram_posts share one external_url → resolveCachedExternalId does NOT cross-resolve (live channelKey wins)", async () => {
    const { telegramAdapter } = await import("../../src/lib/sources/telegram/server/index.js");

    // Pre-seed a COLLIDING cache row: a DIFFERENT channel (channelKey -100999999)
    // that previously held the @durov slug at message 505, plus the REAL durov
    // post the fixture resolves to (-1006503122/505). Both carry the SAME
    // external_url (t.me/durov/505) because messageIds are per-channel sequential
    // (not globally unique) and a freed @slug can be reassigned — the exact
    // P1-edge. We make the WRONG row the most-recently-updated so a recency
    // (ORDER BY updated_at) guess would bind it; the harden must NOT.
    const externalUrl = FIXTURE_URL; // https://t.me/durov/505
    const WRONG_POST_ID = "-100999999/505";
    await db
      .insert(telegramPosts)
      .values({ postId: WRONG_POST_ID, channelKey: "-100999999", externalUrl })
      .onConflictDoNothing();
    await db
      .insert(telegramPosts)
      .values({ postId: FIXTURE_POST_ID, channelKey: FIXTURE_CHANNEL_KEY, externalUrl })
      .onConflictDoNothing();
    // Make the WRONG row the freshest write (the recency trap).
    await db
      .update(telegramPosts)
      .set({ updatedAt: new Date(Date.now() + 60_000) })
      .where(eq(telegramPosts.postId, WRONG_POST_ID));

    // The live ?embed=1 page is the durov fixture → channelKey -1006503122. The
    // collision triggers a live disambiguation fetch; the data-view channelKey is
    // the authoritative answer, NOT the recency-freshest cached row.
    tg.next = SINGLE_POST_EMBED;
    const resolved = await telegramAdapter.resolveCachedExternalId!(FIXTURE_URL);

    expect(resolved).toBe(FIXTURE_POST_ID);
    expect(resolved).not.toBe(WRONG_POST_ID);
    // The disambiguation hit the live page exactly once (the collision-only path).
    expect(tg.calls).toHaveLength(1);
    expect(tg.calls[0]).toEqual({ channel: FIXTURE_CHANNEL, messageId: FIXTURE_MESSAGE_ID });
  });

  it("single cached row (no collision): resolveCachedExternalId returns it WITHOUT a live fetch", async () => {
    const { telegramAdapter } = await import("../../src/lib/sources/telegram/server/index.js");

    // Exactly ONE cache row for the external_url — the hot post-preview save path.
    // The harden must short-circuit to that row with ZERO added t.me fetch.
    await db
      .insert(telegramPosts)
      .values({
        postId: FIXTURE_POST_ID,
        channelKey: FIXTURE_CHANNEL_KEY,
        externalUrl: FIXTURE_URL,
      })
      .onConflictDoNothing();

    const resolved = await telegramAdapter.resolveCachedExternalId!(FIXTURE_URL);

    expect(resolved).toBe(FIXTURE_POST_ID);
    // No live fetch on the unambiguous single-row path (cost-preservation).
    expect(tg.calls).toHaveLength(0);
  });

  it("a deleted/private/nonexistent post (null parse) degrades gracefully (no 422 dead-end)", async () => {
    const user = await seedUserDirectly({
      email: `tg-preview-gone-${Math.random().toString(36).slice(2)}@t.io`,
    });
    // t.me serves HTTP 200 with NO message block for a deleted/private/missing
    // post → the real parser returns null → the preview degrades.
    tg.next = "<html><body>nothing here</body></html>";

    const result = await enrichFromUrl(user.id, FIXTURE_URL, "127.0.0.1");

    // Recognition-only shape (#1 / IG #69 rule): kind + canonical URL, but
    // externalId is NULL — NOT the slug id. A deleted post has no data-view to
    // decode a channelKey from, so there is no canonical key; storing the slug id
    // would re-key on a rename and orphan the card. null = an honest stats-less
    // card; re-paste once the post resolves a channelKey.
    expect(result.kind).toBe("telegram_post");
    expect(result.externalId).toBeNull();
    expect(result.title).toBe("");
    expect(result.thumbnailUrl).toBeNull();
    expect(result.canonicalUrl).toBe(FIXTURE_URL);

    // A null parse wrote NO telegram_posts row at all (we had no channelKey to key
    // a not_found marker on — the embed page carried no post block), and no
    // snapshot row.
    const cached = await db
      .select()
      .from(telegramPosts)
      .where(eq(telegramPosts.postId, FIXTURE_POST_ID));
    expect(cached).toHaveLength(0);
    const snaps = await db
      .select()
      .from(telegramPostSnapshots)
      .where(eq(telegramPostSnapshots.postId, FIXTURE_POST_ID));
    expect(snaps).toHaveLength(0);
  });

  it("an unreachable post (pacer-denied / network error) degrades gracefully (no 422 dead-end)", async () => {
    const user = await seedUserDirectly({
      email: `tg-preview-unreach-${Math.random().toString(36).slice(2)}@t.io`,
    });
    tg.next = () => {
      throw new AdapterError("Telegram fetch network error", { category: "transient" });
    };

    const result = await enrichFromUrl(user.id, FIXTURE_URL, "127.0.0.1");

    // Soft-degrade — manual entry preserved, NEVER a 422. externalId is null
    // (#1 / IG #69 rule): no channelKey could be resolved (the fetch threw before
    // any parse), so we store no slug id.
    expect(result.kind).toBe("telegram_post");
    expect(result.externalId).toBeNull();
    expect(result.title).toBe("");
    expect(result.canonicalUrl).toBe(FIXTURE_URL);
    // No cache row landed (the fetch threw before any write).
    const cached = await db
      .select()
      .from(telegramPosts)
      .where(eq(telegramPosts.postId, FIXTURE_POST_ID));
    expect(cached).toHaveLength(0);
  });

  it("an UNEXPECTED adapter throw (raw Error = programmer bug) re-throws instead of hiding", async () => {
    const user = await seedUserDirectly({
      email: `tg-preview-bug-${Math.random().toString(36).slice(2)}@t.io`,
    });
    // A raw Error is NOT in the graceful-degrade contract — it must surface
    // (→ 500 + escaped-error log), mirroring the IG/Reddit branches. We spy on
    // the adapter method so a raw throw escapes the adapter's own AdapterError
    // mapping and reaches enrichFromUrl's re-throw guard.
    const { telegramAdapter } = await import("../../src/lib/sources/telegram/server/index.js");
    const spy = vi
      .spyOn(telegramAdapter, "fetchEventPreviewMetadata")
      .mockRejectedValueOnce(new TypeError("cannot read properties of undefined"));

    try {
      await expect(enrichFromUrl(user.id, FIXTURE_URL, "127.0.0.1")).rejects.toThrow(
        "cannot read properties of undefined",
      );
    } finally {
      spy.mockRestore();
    }
  });
});
