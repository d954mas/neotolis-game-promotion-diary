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
//   - The externalId is URL-derivable ("<channel>/<messageId>" = the
//     telegram_posts.post_id key), so it is NOT overridden by the preview (the
//     opposite of IG's non-URL media id). createEvent's parseAnyUrl path derives
//     the same composite on save.
//   - A failed preview (parse-null deleted post, rate-limited / network error)
//     degrades to recognition-only so the user can still save a bare manual event
//     — NEVER a 422 dead-end.
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

// The byte-exact single-post-embed fixture parses to durov/505 with 3.71M views
// (asserted in tests/unit/sources/telegram/parse.test.ts) — so the paste URL
// MUST be t.me/durov/505 for the URL-derived composite to line up with the
// fixture's data-post.
const FIXTURE_CHANNEL = "durov";
const FIXTURE_MESSAGE_ID = "505";
const FIXTURE_POST_ID = `${FIXTURE_CHANNEL}/${FIXTURE_MESSAGE_ID}`;
const FIXTURE_URL = `https://t.me/${FIXTURE_POST_ID}`;

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
    // externalId is the URL-derived "<channel>/<messageId>" composite — the
    // telegram_posts.post_id key (RESEARCH Q3), NOT a partial id.
    expect(result.externalId).toBe(FIXTURE_POST_ID);
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

  it("end-to-end: a pasted TG post saves with the URL-derived id so feed-enrichment matches the cache (thumbnail + views)", async () => {
    const user = await seedUserDirectly({
      email: `tg-e2e-${Math.random().toString(36).slice(2)}@t.io`,
    });

    // 1. Preview (the "Fetch" button) → enriched fields the form pre-fills.
    const enriched = await enrichFromUrl(user.id, FIXTURE_URL, "127.0.0.1");
    expect(enriched.externalId).toBe(FIXTURE_POST_ID);

    // 2. Save the event WITHOUT passing an explicit externalId — exercise the
    //    createEvent parseAnyUrl path (telegram_post must NOT be excluded from
    //    it, so the same composite is derived from the URL on save).
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

  it("a deleted/private/nonexistent post (null parse) degrades gracefully (no 422 dead-end)", async () => {
    const user = await seedUserDirectly({
      email: `tg-preview-gone-${Math.random().toString(36).slice(2)}@t.io`,
    });
    // t.me serves HTTP 200 with NO message block for a deleted/private/missing
    // post → the real parser returns null → the preview degrades.
    tg.next = "<html><body>nothing here</body></html>";

    const result = await enrichFromUrl(user.id, FIXTURE_URL, "127.0.0.1");

    // Recognition-only shape: kind + canonical URL + the URL-derived externalId
    // (the TG composite IS the cache key, so it can still be enriched later by a
    // Refresh / the warm lane — unlike IG's shortcode trap which stores null).
    expect(result.kind).toBe("telegram_post");
    expect(result.externalId).toBe(FIXTURE_POST_ID);
    expect(result.title).toBe("");
    expect(result.thumbnailUrl).toBeNull();
    expect(result.canonicalUrl).toBe(FIXTURE_URL);

    // A not_found snapshot stamped polling state but wrote NO snapshot row (a
    // null view count is a chart GAP, never coerced to 0).
    const [cached] = await db
      .select()
      .from(telegramPosts)
      .where(eq(telegramPosts.postId, FIXTURE_POST_ID));
    expect(cached!.lastPollStatus).toBe("not_found");
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

    // Soft-degrade — manual entry preserved, NEVER a 422.
    expect(result.kind).toBe("telegram_post");
    expect(result.externalId).toBe(FIXTURE_POST_ID);
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
