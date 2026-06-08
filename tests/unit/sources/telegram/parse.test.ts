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
//   - externalId is the FULL "<channel>/<messageId>" (RESEARCH Q3 — message ids
//     are per-channel sequential, NOT globally unique)

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  normalizeViewCount,
  parseTelegramListing,
  parseTelegramPost,
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

  it("externalId is the FULL '<channel>/<messageId>' (RESEARCH Q3), NOT the bare id", () => {
    expect(listing.posts[0]!.externalId).toBe("durov/503");
    for (const post of listing.posts) {
      expect(post.externalId).toMatch(/^[^/]+\/\d+$/);
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
    expect(listing.posts[0]!.externalId).toBe("durov/510");
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
    const byId = new Map(listing.posts.map((p) => [p.externalId, p.viewCount]));
    expect(byId.get("durov/901")).toBe(227);
    expect(byId.get("durov/902")).toBe(18100);
    expect(byId.get("durov/903")).toBe(1010000);
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
    expect(post!.externalId).toBe("durov/505");
    expect(post!.viewCount).toBe(3710000);
    expect(post!.publishedAt).toBeInstanceOf(Date);
  });

  it("returns null when the page has no message block", () => {
    expect(parseTelegramPost("<html><body>nothing</body></html>")).toBeNull();
  });
});
