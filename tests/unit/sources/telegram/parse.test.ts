// Telegram t.me/s HTML parser — unit tests (Phase 9 Plan 02, TDD).
//
// The parser (src/lib/sources/telegram/server/parse.ts) is the one genuinely
// novel, brittle piece of the Telegram adapter, so it earns dedicated
// fixture-backed TDD. Every assertion below reads a BYTE-EXACT captured
// t.me/s fixture from tests/fixtures/telegram/ (Plan 01) — zero network at
// test time. The fixtures are the oracle: live durov listing, a ?before paging
// page, a single-post ?embed=1, an absence-of-markers not-found page, plus
// three synthesized-from-real-blocks edge fixtures (views-mixed, no-views,
// album).
//
// Invariants under test:
//   - normalizeViewCount: plain / K / M / missing / garbage
//   - album = exactly ONE post with mediaKind='album' (D-01)
//   - not_found is CONTENT-based (HTTP-200-safe), by absence of tgme_* markers
//   - ?before cursor extraction; null = end-of-history
//   - externalId is the STABLE "<channelKey>/<messageId>" (#1 — channelKey is the
//     rename-proof numeric channel id decoded from data-view, NOT the renameable
//     @username slug; the durov fixture's data-view c = -1006503122). A block
//     whose data-view can't be decoded → externalId null (no slug fallback).
//   - slug carries the renameable @username separately (NEVER the key).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  normalizeViewCount,
  parseTelegramListing,
  parseTelegramPost,
  parseTelegramChannelHeader,
} from "$lib/sources/telegram/server/parse.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/telegram");
const fixture = (name: string): string => readFileSync(join(FIXTURE_DIR, name), "utf8");

describe("normalizeViewCount", () => {
  it("plain integer passes through", () => {
    expect(normalizeViewCount("227")).toBe(227);
    expect(normalizeViewCount("118")).toBe(118);
  });

  it("K suffix multiplies by 1_000", () => {
    expect(normalizeViewCount("12.3K")).toBe(12300);
    expect(normalizeViewCount("18.1K")).toBe(18100);
    expect(normalizeViewCount("27K")).toBe(27000);
  });

  it("M suffix multiplies by 1_000_000", () => {
    expect(normalizeViewCount("1.2M")).toBe(1200000);
    expect(normalizeViewCount("14M")).toBe(14000000);
    expect(normalizeViewCount("1.01M")).toBe(1010000);
  });

  it("empty / garbage → null", () => {
    expect(normalizeViewCount("")).toBeNull();
    expect(normalizeViewCount("garbage")).toBeNull();
    expect(normalizeViewCount("12K3")).toBeNull();
  });
});

describe("parseTelegramListing — healthy listing", () => {
  const listing = parseTelegramListing(fixture("listing-healthy.html"));

  it("status='ok' with a non-null channel title", () => {
    expect(listing.status).toBe("ok");
    expect(listing.channelTitle).toBe("Pavel Durov");
  });

  it("yields one post per [data-post] block", () => {
    expect(listing.posts.length).toBe(19);
  });

  it("externalId is the channelKey-based '<channelKey>/<messageId>' (#1), NOT the slug-based id", () => {
    // The durov fixture's data-view c = -1006503122; messageId 503 → the stable
    // key is "-1006503122/503", NOT "durov/503" (the renameable slug).
    expect(listing.posts[0]!.externalId).toBe("-1006503122/503");
    for (const post of listing.posts) {
      expect(post.externalId).toMatch(/^-1006503122\/\d+$/);
    }
  });

  it("slug carries the renameable @username separately (durov), never as the key", () => {
    expect(listing.posts[0]!.slug).toBe("durov");
    expect(listing.posts[0]!.messageId).toBe("503");
    for (const post of listing.posts) {
      expect(post.slug).toBe("durov");
    }
  });

  it("a block whose data-view can't be decoded → externalId null (NO slug fallback, #1 / IG #69 rule)", () => {
    // Strip every data-view attr so no channelKey decodes. The block still parses
    // (it has views/text/media), but externalId is null — we NEVER fall back to a
    // slug-based "durov/503" id (the rename bug this change eliminates).
    const stripped = fixture("listing-healthy.html").replace(/data-view="[^"]*"/g, 'data-view=""');
    const noKey = parseTelegramListing(stripped);
    expect(noKey.posts.length).toBeGreaterThan(0);
    for (const post of noKey.posts) {
      expect(post.externalId).toBeNull();
      expect(post.channelKey).toBeNull();
      // The slug is still parsed (for the URL / title), just never the key.
      expect(post.slug).toBe("durov");
    }
  });

  it("parses publishedAt as a Date from the <time datetime>", () => {
    expect(listing.posts[0]!.publishedAt).toBeInstanceOf(Date);
    expect(Number.isNaN(listing.posts[0]!.publishedAt!.getTime())).toBe(false);
  });

  it("at least one post carries a positive integer viewCount", () => {
    const positive = listing.posts.filter(
      (p) => typeof p.viewCount === "number" && Number.isInteger(p.viewCount) && p.viewCount > 0,
    );
    expect(positive.length).toBeGreaterThan(0);
  });

  it("extracts the ?before cursor (data-before) — non-null when more history exists", () => {
    expect(listing.nextBeforeCursor).toBe("503");
  });

  it("extracts a photo thumbnail URL from the background-image style", () => {
    const withThumb = listing.posts.find((p) => p.thumbnailUrl !== null);
    expect(withThumb).toBeDefined();
    expect(withThumb!.thumbnailUrl).toMatch(/^https?:\/\//);
  });

  it("decodes the per-post channelKey from the data-view base64 payload (`c`)", () => {
    // Every block's data-view base64 decodes to {"c":-1006503122,...}; `c` is the
    // intrinsic numeric channel id (negative on this real durov fixture), stored
    // as a STRING to match telegram_posts.channel_key. It is identical across all
    // blocks of one listing (same channel).
    expect(listing.posts[0]!.channelKey).toBe("-1006503122");
    for (const post of listing.posts) {
      expect(post.channelKey).toBe("-1006503122");
    }
  });
});

describe("parseTelegramListing — rename-dedup (#1: the WHOLE point)", () => {
  it("the SAME post under a renamed @username maps to the SAME channelKey-based externalId (no duplicate)", () => {
    // Simulate a channel rename: the SAME physical post (same data-view, same
    // messageId) served under two different data-post slugs ("oldname" then
    // "newname"). With a slug-based key these would be TWO different ids
    // (oldname/503 vs newname/503) → duplicate events + split metric history. With
    // the channelKey-based key (#1) both decode to the SAME "-1006503122/503".
    const healthy = fixture("listing-healthy.html");
    const underOld = parseTelegramListing(
      healthy.replace(/data-post="durov\//g, 'data-post="oldname/'),
    );
    const underNew = parseTelegramListing(
      healthy.replace(/data-post="durov\//g, 'data-post="newname/'),
    );

    const oldFirst = underOld.posts[0]!;
    const newFirst = underNew.posts[0]!;

    // The slug differs (the rename)…
    expect(oldFirst.slug).toBe("oldname");
    expect(newFirst.slug).toBe("newname");
    // …but the stable channelKey-based externalId is IDENTICAL → no duplicate.
    expect(oldFirst.externalId).toBe("-1006503122/503");
    expect(newFirst.externalId).toBe("-1006503122/503");
    expect(oldFirst.externalId).toBe(newFirst.externalId);
  });
});

describe("parseTelegramListing — album (D-01: one post, not N)", () => {
  const listing = parseTelegramListing(fixture("album-post.html"));

  it("a grouped-media album parses as exactly ONE post", () => {
    expect(listing.posts.length).toBe(1);
    expect(listing.posts.filter((p) => p.mediaKind === "album").length).toBe(1);
  });

  it("that single album post carries ONE viewCount and mediaKind='album'", () => {
    expect(listing.posts[0]!.mediaKind).toBe("album");
    expect(listing.posts[0]!.viewCount).toBe(2640000);
    // channelKey-based id (#1): data-view c = -1006503122, messageId 510.
    expect(listing.posts[0]!.externalId).toBe("-1006503122/510");
    expect(listing.posts[0]!.slug).toBe("durov");
  });
});

describe("parseTelegramListing — nonexistent channel (content-based not_found)", () => {
  // The fixture is HTTP-200 (Telegram never 404s a missing channel) but has
  // ZERO tgme_* widget markers — the only valid not_found signal.
  const listing = parseTelegramListing(fixture("channel-not-found.html"));

  it("status='not_found' by ABSENCE of markers, not HTTP status", () => {
    expect(listing.status).toBe("not_found");
  });

  it("no posts, no title, no cursor", () => {
    expect(listing.posts.length).toBe(0);
    expect(listing.channelTitle).toBeNull();
    expect(listing.nextBeforeCursor).toBeNull();
  });
});

describe("parseTelegramListing — view-format normalization across blocks", () => {
  const listing = parseTelegramListing(fixture("views-mixed.html"));

  it("plain / K / M view formats all normalize to the right ints", () => {
    // channelKey-based ids (#1): data-view c = -1006503122; messageIds 901/902/903.
    const byId = new Map(listing.posts.map((p) => [p.externalId, p.viewCount]));
    expect(byId.get("-1006503122/901")).toBe(227);
    expect(byId.get("-1006503122/902")).toBe(18100);
    expect(byId.get("-1006503122/903")).toBe(1010000);
  });
});

describe("parseTelegramListing — a views-deleted block", () => {
  const listing = parseTelegramListing(fixture("no-views-post.html"));

  it("viewCount===null (event still appears; excluded from chart downstream)", () => {
    expect(listing.posts.length).toBe(1);
    expect(listing.posts[0]!.viewCount).toBeNull();
  });
});

describe("parseTelegramListing — ?before paging page", () => {
  const listing = parseTelegramListing(fixture("listing-before-page.html"));

  it("extracts the next cursor from the more-wrap data-before attr", () => {
    expect(listing.nextBeforeCursor).toBe("481");
  });
});

describe("parseTelegramListing — end-of-history", () => {
  it("a page with zero blocks and no more-wrap → nextBeforeCursor===null", () => {
    // Synthetic: a real block but the more-wrap anchor removed. Strip every
    // js-messages_more anchor from the healthy fixture to simulate exhaustion.
    const html = fixture("listing-healthy.html").replace(/<a[^>]*js-messages_more[^>]*>/g, "<a>");
    const listing = parseTelegramListing(html);
    expect(listing.nextBeforeCursor).toBeNull();
  });
});

describe("parseTelegramPost — single-post ?embed=1 page (Pitfall 2: embed carries views)", () => {
  it("returns a single post with a non-null viewCount", () => {
    const post = parseTelegramPost(fixture("single-post-embed.html"));
    expect(post).not.toBeNull();
    // channelKey-based id (#1): the ?embed=1 block's data-view c = -1006503122,
    // messageId 505 → "-1006503122/505" (NOT "durov/505").
    expect(post!.externalId).toBe("-1006503122/505");
    expect(post!.slug).toBe("durov");
    expect(post!.messageId).toBe("505");
    expect(post!.viewCount).toBe(3710000);
    expect(post!.publishedAt).toBeInstanceOf(Date);
  });

  it("the embed block with an undecodable data-view → externalId null (no slug fallback)", () => {
    const stripped = fixture("single-post-embed.html").replace(
      /data-view="[^"]*"/g,
      'data-view=""',
    );
    const post = parseTelegramPost(stripped);
    expect(post).not.toBeNull();
    expect(post!.externalId).toBeNull();
    expect(post!.channelKey).toBeNull();
    expect(post!.slug).toBe("durov"); // slug still parsed, never the key
  });

  it("returns null when the page has no message block", () => {
    expect(parseTelegramPost("<html><body>nothing</body></html>")).toBeNull();
  });

  it("decodes channelKey from the embed page's data-view (the embed has no header)", () => {
    // The ?embed=1 page carries no channel header, but the single post block
    // still carries the data-view → channelKey is decoded for the warm lane.
    const post = parseTelegramPost(fixture("single-post-embed.html"));
    expect(post!.channelKey).toBe("-1006503122");
  });

  it("embed path carries NO reactions (the ?embed=1 page omits the reactions block)", () => {
    const post = parseTelegramPost(fixture("single-post-embed.html"));
    // The embed widget does not render .tgme_widget_message_reactions →
    // reactionsTotal null, reactionsTop empty (E1).
    expect(post!.reactionsTotal).toBeNull();
    expect(post!.reactionsTop).toEqual([]);
  });
});

describe("parseTelegramListing — reactions (E1, LISTING-only second metric)", () => {
  const listing = parseTelegramListing(fixture("album-post.html"));
  const post = listing.posts[0]!;

  it("reactionsTotal sums every reaction count across all three kinds (K/M-normalized)", () => {
    // album-post block carries 5 reactions:
    //   paid 8.19K=8190, custom 29.8K=29800, standard 🫡 8.6K=8600,
    //   custom 5.87K=5870, custom 3.41K=3410 → total 55870.
    expect(post.reactionsTotal).toBe(55870);
  });

  it("reactionsTop is desc-sorted and capped at 5", () => {
    expect(post.reactionsTop.map((r) => r.count)).toEqual([29800, 8600, 8190, 5870, 3410]);
    expect(post.reactionsTop.length).toBeLessThanOrEqual(5);
  });

  it("classifies the three reaction kinds: standard carries the unicode emoji, custom/paid carry null emoji", () => {
    const standard = post.reactionsTop.find((r) => r.kind === "standard");
    expect(standard).toBeDefined();
    expect(standard!.emoji).toBe("🫡");
    expect(standard!.count).toBe(8600);

    const paid = post.reactionsTop.find((r) => r.kind === "paid");
    expect(paid).toBeDefined();
    expect(paid!.emoji).toBeNull();
    expect(paid!.count).toBe(8190);

    const custom = post.reactionsTop.find((r) => r.kind === "custom");
    expect(custom).toBeDefined();
    expect(custom!.emoji).toBeNull();
  });

  it("a post with no reactions block → reactionsTotal null, reactionsTop []", () => {
    // Real channels reaction nearly every popular post, so synthesize the
    // no-reactions case the same way the end-of-history test synthesizes
    // exhaustion: strip the .tgme_widget_message_reactions container from a real
    // block. A post with no reactions block → null total, empty top (E1).
    const stripped = fixture("album-post.html").replace(
      /<div class="tgme_widget_message_reactions[\s\S]*?<\/div>/,
      "",
    );
    const noReact = parseTelegramListing(stripped).posts[0]!;
    expect(noReact.reactionsTotal).toBeNull();
    expect(noReact.reactionsTop).toEqual([]);
  });
});

describe("parseTelegramChannelHeader — the channel subject entity (Phase 9)", () => {
  const header = parseTelegramChannelHeader(fixture("listing-healthy.html"));

  it("extracts title / slug / avatar / description from the listing header", () => {
    expect(header.title).toBe("Pavel Durov");
    expect(header.slug).toBe("durov"); // @username with the leading '@' stripped
    expect(header.avatarUrl).toMatch(/^https?:\/\//); // og:image hotlink
    expect(header.description).toBe("Founder of Telegram.");
  });

  it("normalizes the 'N subscribers' counter via the K/M view logic", () => {
    // The fixture header counter reads "11.1M subscribers".
    expect(header.subscriberCount).toBe(11_100_000);
  });

  it("lifts channelKey from a post block's data-view (the header markup has no id)", () => {
    expect(header.channelKey).toBe("-1006503122");
  });

  it("the listing surfaces the same channelHeader inline", () => {
    const listing = parseTelegramListing(fixture("listing-healthy.html"));
    expect(listing.channelHeader).not.toBeNull();
    expect(listing.channelHeader!.title).toBe("Pavel Durov");
    expect(listing.channelHeader!.slug).toBe("durov");
    expect(listing.channelHeader!.channelKey).toBe("-1006503122");
    expect(listing.channelHeader!.subscriberCount).toBe(11_100_000);
  });

  it("a not_found listing carries a null channelHeader", () => {
    const listing = parseTelegramListing(fixture("channel-not-found.html"));
    expect(listing.status).toBe("not_found");
    expect(listing.channelHeader).toBeNull();
  });

  it("missing header markup → graceful all-null fields", () => {
    const empty = parseTelegramChannelHeader("<html><body>no channel markup</body></html>");
    expect(empty.channelKey).toBeNull();
    expect(empty.slug).toBeNull();
    expect(empty.title).toBeNull();
    expect(empty.avatarUrl).toBeNull();
    expect(empty.description).toBeNull();
    expect(empty.subscriberCount).toBeNull();
  });

  it("a header with no subscribers counter → subscriberCount null (graceful)", () => {
    // Strip the counters block; title/slug stay, subscriberCount degrades to null.
    const stripped = fixture("listing-healthy.html").replace(
      /<div class="tgme_channel_info_counters[\s\S]*?<\/div>\s*<\/div>/,
      "",
    );
    const h = parseTelegramChannelHeader(stripped);
    expect(h.title).toBe("Pavel Durov");
    expect(h.subscriberCount).toBeNull();
  });
});
