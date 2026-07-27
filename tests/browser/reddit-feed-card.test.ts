/**
 * Browser test for RedditFeedCard (Phase 12 Plan 06, PLAT-04 surface — D-06).
 *
 * Asserts the load-bearing Reddit-card contracts (an ADAPTIVE self/link/image/gallery
 * card forked from TwitterFeedCard, trimmed to the D-09 likes+comments metric set):
 *   - Metrics-by-presence (D-09): a post renders likes + comments ONLY; NO views chip
 *     and NO shares chip (Reddit exposes neither, 12-SPIKE Q4). A null metric is
 *     omitted (never a 0-or-dash).
 *   - ADAPTIVE layout (D-06), keyed on the post FORM (media_type): an IMAGE / GALLERY
 *     post RESERVES the media slot (shows the cover when present, else the KindIcon
 *     placeholder); a SELF/LINK post renders the text card — NO thumbnail block at all.
 *   - The gallery variant carries a "Carousel" media-type overlay even with NO cover URL
 *     (ScrapeCreators omits a gallery cover); a single image / self / link post has no pill.
 *   - onerror fallback: a failing hotlinked i.redd.it cover on a MEDIA post keeps the
 *     slot with the KindIcon placeholder (no broken <img>, media identity + pill survive)
 *     — the latched adaptive fallback (live-CDN renderability owed at the Task 3 UAT).
 *
 * Mounts the real Svelte component in Chromium (vitest browser project) so the {#if}
 * presence branches + the BaseFeedCard onThumbnailError wiring are exercised against
 * the actual compiled output, not a mock.
 *
 * Requirements: PLAT-04.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import RedditFeedCard from "../../src/lib/sources/reddit/ui/RedditFeedCard.svelte";
import type { CardEventLite } from "../../src/lib/components/feed/parts/derive-card-data.js";

let host: HTMLElement;

type RdStats = {
  likeCount: number | null;
  commentCount: number | null;
  polledAt: Date;
};

function makeEvent(opts: {
  stats: RdStats | null;
  thumbnailUrl: string | null;
  mediaType: string | null;
  subredditSlug?: string | null;
  deletionDetectedAt?: string | null;
}): CardEventLite {
  return {
    id: "ev_rd_1",
    kind: "reddit_post",
    gameIds: [] as string[],
    sourceId: "src_rd_1",
    externalId: "t3_abc123",
    metadata: { subreddit: "gamedev" },
    occurredAt: new Date("2026-06-03T08:00:00Z"),
    authorIsMe: false,
    title: "A test reddit post title",
    notes: null,
    url: null,
    publishedAt: new Date("2026-06-03T08:00:00Z"),
    lastPolledAt: new Date("2026-06-04T08:00:00Z"),
    lastPollStatus: null,
    redditEnrichment: {
      stats: opts.stats,
      thumbnailUrl: opts.thumbnailUrl,
      mediaType: opts.mediaType,
      subredditSlug: opts.subredditSlug ?? "gamedev",
      deletionDetectedAt: opts.deletionDetectedAt ?? null,
    },
  };
}

// REALISTIC fixture: canonicalizeOnCreate stores the BARE slug/handle and Reddit
// never populates channelTitle. The previous fixture pre-prefixed both, which is a
// shape the adapter never produces — it hid the missing-sigil bug entirely.
const source = {
  id: "src_rd_1",
  displayName: "gamedev",
  handleUrl: "https://www.reddit.com/r/gamedev",
  kind: "reddit_subreddit",
};

const accountSource = {
  id: "src_rd_2",
  displayName: "d954mas",
  handleUrl: "https://www.reddit.com/user/d954mas",
  kind: "reddit_account",
};

function mountCard(
  event: CardEventLite,
  sourceProp: {
    id: string;
    displayName: string | null;
    handleUrl: string;
    kind?: string;
  } | null = source,
): { card: HTMLElement; component: ReturnType<typeof mount> } {
  const component = mount(RedditFeedCard, {
    target: host,
    props: { event, source: sourceProp, games: [], view: "feed" },
  });
  flushSync();
  const card = host.querySelector('[data-testid="feed-card"]') as HTMLElement | null;
  if (!card) throw new Error("RedditFeedCard root not found");
  return { card, component };
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  if (host.parentNode) host.parentNode.removeChild(host);
});

describe("RedditFeedCard adaptive rendering (Phase 12 Plan 06 — PLAT-04)", () => {
  it("[12-06] a SELF (text) post — null thumbnail — renders the text card: NO thumbnail block, likes + comments chips, NO views/shares", () => {
    const { card, component } = mountCard(
      makeEvent({
        stats: { likeCount: 11, commentCount: 4, polledAt: new Date() },
        thumbnailUrl: null,
        mediaType: "self",
      }),
    );
    // ADAPTIVE D-06: a self/link post collapses the thumbnail slot entirely.
    expect(card.querySelector(".card-thumb")).toBeNull();
    const nums = Array.from(card.querySelectorAll(".card-stats .num")).map((n) =>
      (n.textContent ?? "").trim(),
    );
    // Exactly TWO chips (likes + comments) — no views, no shares.
    expect(nums).toHaveLength(2);
    expect(nums).toContain("11");
    expect(nums).toContain("4");
    expect(card.querySelector('.card-stats .stat[data-metric="views"]')).toBeNull();
    expect(card.querySelector('.card-stats .stat[data-metric="shares"]')).toBeNull();
    expect(card.querySelector('.card-stats .stat[data-metric="likes"]')).not.toBeNull();
    expect(card.querySelector('.card-stats .stat[data-metric="comments"]')).not.toBeNull();
    unmount(component);
  });

  it("[12-06] a LINK post — null thumbnail — also renders the text card (no image block)", () => {
    const { card, component } = mountCard(
      makeEvent({
        stats: { likeCount: 5, commentCount: 0, polledAt: new Date() },
        thumbnailUrl: null,
        mediaType: "link",
      }),
    );
    expect(card.querySelector(".card-thumb")).toBeNull();
    // commentCount 0 is a REAL value (not null) → the comments chip renders "0".
    const commentsChip = card.querySelector('.card-stats .stat[data-metric="comments"]');
    expect(commentsChip).not.toBeNull();
    expect(commentsChip!.querySelector(".num")?.textContent?.trim()).toBe("0");
    unmount(component);
  });

  it("[12-06] an IMAGE post — thumbnailUrl present — renders the hotlinked i.redd.it cover + likes/comments chips", () => {
    const { card, component } = mountCard(
      makeEvent({
        stats: { likeCount: 87, commentCount: 12, polledAt: new Date() },
        thumbnailUrl: "https://i.redd.it/screenshot.jpg",
        mediaType: "image",
      }),
    );
    const img = card.querySelector(".card-thumb img") as HTMLImageElement | null;
    expect(img, "an image post should render a thumbnail <img>").not.toBeNull();
    // The raw i.redd.it URL is hotlinked directly (NO proxy — 12-SPIKE Pitfall 5).
    expect(img!.getAttribute("src")).toContain("i.redd.it");
    const nums = Array.from(card.querySelectorAll(".card-stats .num")).map((n) =>
      (n.textContent ?? "").trim(),
    );
    expect(nums).toContain("87");
    expect(nums).toContain("12");
    // A single image gets NO media-type pill (a plain image needs no marker).
    expect(card.querySelector(".card-thumb .media-type-pill")).toBeNull();
    unmount(component);
  });

  it("[12-06] a GALLERY post carries a 'Carousel' media-type overlay over the cover", () => {
    const { card, component } = mountCard(
      makeEvent({
        stats: { likeCount: 40, commentCount: 3, polledAt: new Date() },
        thumbnailUrl: "https://i.redd.it/gallery-cover.jpg",
        mediaType: "gallery",
      }),
    );
    const pill = card.querySelector(".card-thumb .media-type-pill") as HTMLElement | null;
    expect(pill, "a gallery post should render a Carousel pill").not.toBeNull();
    expect(pill!.querySelector(".media-type-pill-label")?.textContent?.trim()).toBe("Carousel");
    unmount(component);
  });

  it("[review-P2] an image thumbnail onerror KEEPS the media slot (placeholder + no broken image), not a text collapse", () => {
    const { card, component } = mountCard(
      makeEvent({
        stats: { likeCount: 1, commentCount: 1, polledAt: new Date() },
        // A blocked/expired i.redd.it cover → fires <img> onerror.
        thumbnailUrl: "https://i.redd.it/EXPIRED-DOES-NOT-EXIST.jpg",
        mediaType: "image",
      }),
    );
    const img = card.querySelector(".card-thumb img") as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toContain("i.redd.it");
    img!.dispatchEvent(new Event("error"));
    flushSync();
    // After error: the onerror latch nulls the cover, but an IMAGE post is a MEDIA post,
    // so the slot STAYS (forceThumbSlot) and shows the KindIcon placeholder — the media
    // identity survives instead of collapsing to a text card. No broken <img> anywhere.
    expect(card.querySelector(".card-thumb img")).toBeNull();
    const thumb = card.querySelector(".card-thumb");
    expect(thumb, "the media slot stays after a failed hotlink").not.toBeNull();
    expect(thumb!.classList.contains("empty")).toBe(true);
    expect(card.querySelector("img")).toBeNull();
    unmount(component);
  });

  it("[review-P2] a GALLERY with NO cover URL still reserves the slot + Carousel pill (real ScrapeCreators shape)", () => {
    const { card, component } = mountCard(
      makeEvent({
        stats: { likeCount: 12, commentCount: 2, polledAt: new Date() },
        thumbnailUrl: null, // ScrapeCreators omits a gallery cover — the real shape
        mediaType: "gallery",
      }),
    );
    const thumb = card.querySelector(".card-thumb");
    expect(thumb, "a gallery reserves the media slot even without a cover").not.toBeNull();
    expect(card.querySelector(".card-thumb img")).toBeNull(); // no cover → KindIcon placeholder
    const pill = card.querySelector(".card-thumb .media-type-pill") as HTMLElement | null;
    expect(pill, "the Carousel pill survives without a cover").not.toBeNull();
    expect(pill!.querySelector(".media-type-pill-label")?.textContent?.trim()).toBe("Carousel");
    unmount(component);
  });

  it("[12-06] presence-based chips: a null metric is HIDDEN, never rendered as 0", () => {
    const { card, component } = mountCard(
      makeEvent({
        // likeCount present, commentCount null → only the likes chip renders.
        stats: { likeCount: 350, commentCount: null, polledAt: new Date() },
        thumbnailUrl: null,
        mediaType: "self",
      }),
    );
    const nums = Array.from(card.querySelectorAll(".card-stats .num")).map((n) =>
      (n.textContent ?? "").trim(),
    );
    expect(nums).toHaveLength(1);
    expect(nums).toContain("350");
    expect(card.querySelector('.card-stats .stat[data-metric="comments"]')).toBeNull();
    unmount(component);
  });
  // REGRESSION (review): the adapter stores the BARE slug, so the card used to render
  // "gamedev" while a hand-pasted post from the same community rendered "r/gamedev" —
  // two spellings of one place in a single feed column.
  it("[review] a subreddit source renders the r/ sigil, not the bare slug", () => {
    const { card, component } = mountCard(
      makeEvent({ stats: null, thumbnailUrl: null, mediaType: "self" }),
    );
    expect((card.querySelector(".src")?.textContent ?? "").trim()).toBe("r/gamedev");
    unmount(component);
  });

  it("[review] an account source renders the u/ sigil AND the post's own subreddit as a byline", () => {
    const { card, component } = mountCard(
      makeEvent({
        stats: null,
        thumbnailUrl: null,
        mediaType: "self",
        subredditSlug: "IndieDev",
      }),
      accountSource,
    );
    expect((card.querySelector(".src")?.textContent ?? "").trim()).toBe("u/d954mas");
    expect(
      (card.querySelector(".card-byline")?.textContent ?? "").trim(),
      "a dev tracking their own posts must see WHICH community each went to",
    ).toBe("r/IndieDev");
    unmount(component);
  });

  it("[review] a subreddit source does NOT repeat its own slug as a byline", () => {
    const { card, component } = mountCard(
      makeEvent({ stats: null, thumbnailUrl: null, mediaType: "self" }),
    );
    expect(card.querySelector(".card-byline")).toBeNull();
    unmount(component);
  });

  it("[review] an already-sigilled display name is never double-prefixed", () => {
    const { card, component } = mountCard(
      makeEvent({ stats: null, thumbnailUrl: null, mediaType: "self" }),
      { ...source, displayName: "r/gamedev" },
    );
    expect((card.querySelector(".src")?.textContent ?? "").trim()).toBe("r/gamedev");
    unmount(component);
  });

  // REGRESSION (review): the enrichment carried deletionDetectedAt and the event DETAIL
  // rendered it, but the card type dropped the field — a deleted post looked completely
  // normal in the feed.
  it("[review] a deleted-on-Reddit post shows the notice on the CARD, not only in the detail", () => {
    const { card, component } = mountCard(
      makeEvent({
        stats: null,
        thumbnailUrl: null,
        mediaType: "self",
        deletionDetectedAt: "2026-06-20T10:00:00Z",
      }),
    );
    const notice = card.querySelector(".reddit-deleted");
    expect(notice, "the feed must surface deletion without opening the event").not.toBeNull();
    expect((notice?.textContent ?? "").toLowerCase()).toContain("deleted");
    unmount(component);
  });

  it("[review] a live post shows NO deletion notice", () => {
    const { card, component } = mountCard(
      makeEvent({ stats: null, thumbnailUrl: null, mediaType: "self" }),
    );
    expect(card.querySelector(".reddit-deleted")).toBeNull();
    unmount(component);
  });
});
