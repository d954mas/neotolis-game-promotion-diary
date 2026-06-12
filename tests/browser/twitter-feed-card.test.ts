/**
 * Browser test for TwitterFeedCard (Phase 11 Plan 04, PLAT-03 surface — D-06).
 *
 * Asserts the load-bearing Twitter-card contracts (an ADAPTIVE media/text card
 * forked from TelegramFeedCard with the TikTok 4:5 crop + shares chip):
 *   - The SHARES chip (D-05 DERIVED retweet+quote): a twitter_post with a
 *     non-null shareCount renders a Shares chip; a tweet with null shareCount
 *     omits it (metrics-by-presence D-05 — never a 0-or-dash).
 *   - Metrics-by-presence: a media tweet renders views + likes + comments +
 *     shares; a text-only tweet with null views renders NO views chip.
 *   - ADAPTIVE layout (D-06): a MEDIA tweet (thumbnailUrl present) renders the
 *     4:5-cropped cover + a "Video" media-type overlay; a TEXT-ONLY tweet
 *     (thumbnailUrl null) renders the text card — NO thumbnail block at all.
 *   - The 4:5 center-crop: the [data-kind="twitter_post"] .card-thumb carries the
 *     4/5 aspect-ratio override (the native cover is cover-cropped to 4:5).
 *   - onerror fallback: a failing hotlinked pbs.twimg.com cover swaps to the
 *     .card-thumb.empty KindIcon placeholder (no broken <img>).
 *
 * Q6 NOTE (11-SPIKE.md): whether a raw cross-origin <img src="pbs.twimg.com/…">
 * actually LOADS in a real browser (vs ORB/CORP-blocked) is the UAT-owed check
 * (Task 3). This test exercises the card's STRUCTURE (the <img> is emitted with the
 * raw URL, the onerror latch works); the live-CDN renderability is the human UAT
 * assertion — if blocked there, a same-origin proxy is added (mirrors TikTok).
 *
 * Mounts the real Svelte component in Chromium (vitest browser project) so the
 * {#if} presence branches + the BaseFeedCard onThumbnailError wiring are exercised
 * against the actual compiled output, not a mock.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import TwitterFeedCard from "../../src/lib/sources/twitter/ui/TwitterFeedCard.svelte";
import type { CardEventLite } from "../../src/lib/components/feed/parts/derive-card-data.js";

let host: HTMLElement;

type TwStats = {
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  shareCount: number | null;
  polledAt: Date;
};

function makeEvent(opts: {
  stats: TwStats | null;
  thumbnailUrl: string | null;
  mediaType: string | null;
}): CardEventLite {
  return {
    id: "ev_tw_1",
    kind: "twitter_post",
    gameIds: [] as string[],
    sourceId: "src_tw_1",
    externalId: "1799999999999999999",
    metadata: { handle: "ConcernedApe" },
    occurredAt: new Date("2026-06-03T08:00:00Z"),
    authorIsMe: false,
    title: "A test tweet first line",
    notes: null,
    url: null,
    publishedAt: new Date("2026-06-03T08:00:00Z"),
    lastPolledAt: new Date("2026-06-04T08:00:00Z"),
    lastPollStatus: null,
    twitterEnrichment: {
      stats: opts.stats,
      thumbnailUrl: opts.thumbnailUrl,
      mediaType: opts.mediaType,
    },
  };
}

const source = {
  id: "src_tw_1",
  displayName: "Stardew Valley",
  handleUrl: "https://x.com/ConcernedApe",
  channelTitle: "Stardew Valley",
};

function mountCard(event: CardEventLite): {
  card: HTMLElement;
  component: ReturnType<typeof mount>;
} {
  const component = mount(TwitterFeedCard, {
    target: host,
    props: { event, source, games: [], view: "feed" },
  });
  flushSync();
  const card = host.querySelector('[data-testid="feed-card"]') as HTMLElement | null;
  if (!card) throw new Error("TwitterFeedCard root not found");
  return { card, component };
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  if (host.parentNode) host.parentNode.removeChild(host);
});

describe("TwitterFeedCard (Phase 11 Plan 04 — PLAT-03)", () => {
  it("a media tweet renders views + likes + comments + the SHARES chip (the DERIVED retweet+quote)", () => {
    const { card, component } = mountCard(
      makeEvent({
        stats: {
          viewCount: 1_200_000,
          likeCount: 48_000,
          commentCount: 312,
          shareCount: 4974,
          polledAt: new Date(),
        },
        thumbnailUrl: "https://pbs.twimg.com/media/cover.jpg",
        mediaType: "video",
      }),
    );
    const nums = Array.from(card.querySelectorAll(".card-stats .num")).map((n) =>
      (n.textContent ?? "").trim(),
    );
    // 1.2M views, 48.0K likes, 312 comments, 5.0K shares → four chips.
    expect(nums).toHaveLength(4);
    expect(nums).toContain("1.2M");
    expect(nums).toContain("48.0K");
    expect(nums).toContain("312");
    // The SHARES chip — 4974 → "5.0K" — is the load-bearing PLAT-03 assertion.
    expect(nums).toContain("5.0K");
    const sharesChip = card.querySelector('.card-stats .stat[data-metric="shares"]');
    expect(sharesChip, "the shares chip must be present on a media card").not.toBeNull();
    expect(sharesChip!.querySelector(".num")?.textContent?.trim()).toBe("5.0K");
    unmount(component);
  });

  it("the media tweet thumbnail slot is center-cropped to 4:5 + carries a 'Video' overlay", () => {
    const { card, component } = mountCard(
      makeEvent({
        stats: {
          viewCount: 10,
          likeCount: 1,
          commentCount: 1,
          shareCount: 1,
          polledAt: new Date(),
        },
        thumbnailUrl: "https://pbs.twimg.com/media/cover.jpg",
        mediaType: "video",
      }),
    );
    // The card article carries data-kind so the scoped :global override applies.
    expect(card.getAttribute("data-kind")).toBe("twitter_post");
    const thumb = card.querySelector(".card-thumb") as HTMLElement | null;
    expect(thumb).not.toBeNull();
    const ar = getComputedStyle(thumb!).aspectRatio.replace(/\s/g, "");
    expect(ar).toBe("4/5");
    // A native-video tweet → the "Video" media-type pill.
    const pill = card.querySelector(".card-thumb .media-type-pill") as HTMLElement | null;
    expect(pill, "a video tweet should render a pill").not.toBeNull();
    expect(pill!.querySelector(".media-type-pill-label")?.textContent?.trim()).toBe("Video");
    unmount(component);
  });

  it("a TEXT-ONLY tweet (null thumbnail) renders the text card — NO thumbnail block, NO views chip", () => {
    const { card, component } = mountCard(
      makeEvent({
        stats: {
          viewCount: null,
          likeCount: 350,
          commentCount: 9,
          shareCount: null,
          polledAt: new Date(),
        },
        thumbnailUrl: null,
        mediaType: "text",
      }),
    );
    // ADAPTIVE D-06: a text-only tweet collapses the thumbnail slot entirely.
    expect(card.querySelector(".card-thumb")).toBeNull();
    // metrics-by-presence: only likes + comments — views AND shares omitted (NOT 0).
    const nums = Array.from(card.querySelectorAll(".card-stats .num")).map((n) =>
      (n.textContent ?? "").trim(),
    );
    expect(nums).toHaveLength(2);
    expect(nums).toContain("350");
    expect(nums).toContain("9");
    expect(nums).not.toContain("0");
    expect(card.querySelector('.card-stats .stat[data-metric="shares"]')).toBeNull();
    expect(card.querySelector('.card-stats .stat[data-metric="views"]')).toBeNull();
    unmount(component);
  });

  it("a media tweet thumbnail onerror collapses to the text card (no broken image — the adaptive D-06 fallback)", () => {
    const { card, component } = mountCard(
      makeEvent({
        stats: {
          viewCount: 10,
          likeCount: 1,
          commentCount: 1,
          shareCount: 1,
          polledAt: new Date(),
        },
        // An expired/blocked pbs.twimg.com cover → fires <img> onerror.
        thumbnailUrl: "https://pbs.twimg.com/media/EXPIRED-DOES-NOT-EXIST.jpg",
        mediaType: "video",
      }),
    );
    const img = card.querySelector(".card-thumb img") as HTMLImageElement | null;
    expect(img).not.toBeNull();
    // The raw pbs.twimg.com URL is hotlinked directly (NO proxy — Q6).
    expect(img!.getAttribute("src")).toContain("pbs.twimg.com");
    img!.dispatchEvent(new Event("error"));
    flushSync();
    // After error: the onerror latch nulls the thumbnail. twitter_post is NOT a
    // media-shape kind (the Telegram-card adaptive pattern), so a null thumbnail
    // COLLAPSES the thumb slot entirely — the card degrades to text-forward with no
    // broken <img> and no empty placeholder block (unlike TikTok/IG which reserve a
    // fixed media slot). The load-bearing assertion: there is NO broken image.
    expect(card.querySelector(".card-thumb img")).toBeNull();
    expect(card.querySelector(".card-thumb")).toBeNull();
    expect(card.querySelector("img")).toBeNull();
    unmount(component);
  });
});
