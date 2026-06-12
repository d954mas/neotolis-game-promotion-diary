/**
 * Browser test for TikTokFeedCard (Phase 10 Plan 05, PLAT-02 surface — D-07).
 *
 * Asserts the load-bearing TikTok-card contracts (a thin fork of the IG card):
 *   - The SHARES chip (PLAT-02 delta vs IG): a tiktok_post with a non-null
 *     shareCount renders a Shares chip; a post with null shareCount omits it
 *     (metrics-by-presence D-05 — never a 0-or-dash).
 *   - Metrics-by-presence: a photo-mode (carousel) post with null viewCount
 *     renders NO views chip.
 *   - The media-type overlay: short → "Short", carousel → "Carousel" (every
 *     TikTok video is a short-form clip → "short"; user re-decided 2026-06-12).
 *   - The 4:5 center-crop: the [data-kind="tiktok_post"] .card-thumb carries the
 *     4/5 aspect-ratio override (the native 9:16 cover is cover-cropped to 4:5).
 *   - onerror fallback (D-07): a failing hotlinked cover swaps to the
 *     .card-thumb.empty KindIcon placeholder (no broken <img>).
 *
 * Mounts the real Svelte component in Chromium (vitest browser project) so the
 * {#if} presence branches + the BaseFeedCard onThumbnailError wiring are
 * exercised against the actual compiled output, not a mock.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import TikTokFeedCard from "../../src/lib/sources/tiktok/ui/TikTokFeedCard.svelte";
import type { CardEventLite } from "../../src/lib/components/feed/parts/derive-card-data.js";

let host: HTMLElement;

type TkStats = {
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  shareCount: number | null;
  polledAt: Date;
};

function makeEvent(opts: {
  stats: TkStats | null;
  thumbnailUrl: string | null;
  mediaType: string | null;
}): CardEventLite {
  return {
    id: "ev_tk_1",
    kind: "tiktok_post",
    gameIds: [] as string[],
    sourceId: "src_tk_1",
    externalId: "7649569886871522573",
    metadata: null,
    occurredAt: new Date("2026-06-03T08:00:00Z"),
    authorIsMe: false,
    title: "A test TikTok caption first line",
    notes: null,
    url: null,
    publishedAt: new Date("2026-06-03T08:00:00Z"),
    lastPolledAt: new Date("2026-06-04T08:00:00Z"),
    lastPollStatus: null,
    tiktokEnrichment: {
      stats: opts.stats,
      thumbnailUrl: opts.thumbnailUrl,
      mediaType: opts.mediaType,
    },
  };
}

const source = {
  id: "src_tk_1",
  displayName: "Dave Portnoy",
  handleUrl: "https://www.tiktok.com/@stoolpresidente",
  channelTitle: "stoolpresidente",
};

function mountCard(event: CardEventLite): {
  card: HTMLElement;
  component: ReturnType<typeof mount>;
} {
  const component = mount(TikTokFeedCard, {
    target: host,
    props: { event, source, games: [], view: "feed" },
  });
  flushSync();
  const card = host.querySelector('[data-testid="feed-card"]') as HTMLElement | null;
  if (!card) throw new Error("TikTokFeedCard root not found");
  return { card, component };
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  if (host.parentNode) host.parentNode.removeChild(host);
});

describe("TikTokFeedCard (Phase 10 Plan 05 — PLAT-02)", () => {
  it("a short post renders views + likes + comments + the SHARES chip (PLAT-02 delta)", () => {
    const { card, component } = mountCard(
      makeEvent({
        stats: {
          viewCount: 1_200_000,
          likeCount: 48_000,
          commentCount: 312,
          shareCount: 4974,
          polledAt: new Date(),
        },
        thumbnailUrl: "https://p16.tiktokcdn-us.com/cover.awebp",
        mediaType: "short",
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
    // The SHARES chip — 4974 → "5.0K" — is the load-bearing PLAT-02 assertion.
    expect(nums).toContain("5.0K");
    // The shares chip is explicitly tagged so the assertion is unambiguous.
    const sharesChip = card.querySelector('.card-stats .stat[data-metric="shares"]');
    expect(sharesChip, "the shares chip must be present on a short card").not.toBeNull();
    expect(sharesChip!.querySelector(".num")?.textContent?.trim()).toBe("5.0K");
    unmount(component);
  });

  it("a photo-mode (carousel) post with null views + null shares omits both chips (metrics by presence)", () => {
    const { card, component } = mountCard(
      makeEvent({
        stats: {
          viewCount: null,
          likeCount: 350,
          commentCount: 9,
          shareCount: null,
          polledAt: new Date(),
        },
        thumbnailUrl: "https://p16.tiktokcdn-us.com/photo-cover.awebp",
        mediaType: "carousel",
      }),
    );
    const nums = Array.from(card.querySelectorAll(".card-stats .num")).map((n) =>
      (n.textContent ?? "").trim(),
    );
    // Only likes + comments — views AND shares are omitted (NOT rendered as "0").
    expect(nums).toHaveLength(2);
    expect(nums).toContain("350");
    expect(nums).toContain("9");
    expect(nums).not.toContain("0");
    expect(card.querySelector('.card-stats .stat[data-metric="shares"]')).toBeNull();
    unmount(component);
  });

  it("media-type overlay: short → Short, carousel → Carousel", () => {
    for (const { mediaType, label } of [
      { mediaType: "short", label: "Short" },
      { mediaType: "carousel", label: "Carousel" },
    ]) {
      const { card, component } = mountCard(
        makeEvent({
          stats: {
            viewCount: 10,
            likeCount: 1,
            commentCount: 1,
            shareCount: 1,
            polledAt: new Date(),
          },
          thumbnailUrl: "https://p16.tiktokcdn-us.com/cover.awebp",
          mediaType,
        }),
      );
      const pill = card.querySelector(".card-thumb .media-type-pill") as HTMLElement | null;
      expect(pill, `${mediaType} should render a pill`).not.toBeNull();
      expect(pill!.querySelector(".media-type-pill-label")?.textContent?.trim()).toBe(label);
      expect(pill!.getAttribute("aria-label")).toBe(label);
      unmount(component);
    }
  });

  it("the thumbnail slot is center-cropped to 4:5 (the [data-kind=tiktok_post] aspect-ratio override)", () => {
    const { card, component } = mountCard(
      makeEvent({
        stats: {
          viewCount: 10,
          likeCount: 1,
          commentCount: 1,
          shareCount: 1,
          polledAt: new Date(),
        },
        thumbnailUrl: "https://p16.tiktokcdn-us.com/cover.awebp",
        mediaType: "short",
      }),
    );
    // The card article carries data-kind so the scoped :global override applies.
    expect(card.getAttribute("data-kind")).toBe("tiktok_post");
    const thumb = card.querySelector(".card-thumb") as HTMLElement | null;
    expect(thumb).not.toBeNull();
    // The computed aspect-ratio is 4 / 5 (the cover-crop slot). Different
    // browsers serialize it as "4 / 5"; assert the ratio numerically.
    const ar = getComputedStyle(thumb!).aspectRatio.replace(/\s/g, "");
    expect(ar).toBe("4/5");
    unmount(component);
  });

  it("thumbnail onerror swaps to the .card-thumb.empty placeholder (D-07, no broken image)", () => {
    const { card, component } = mountCard(
      makeEvent({
        stats: {
          viewCount: 10,
          likeCount: 1,
          commentCount: 1,
          shareCount: 1,
          polledAt: new Date(),
        },
        // An expired/invalid signed CDN URL → fires <img> onerror.
        thumbnailUrl: "https://p16.tiktokcdn-us.com/EXPIRED-DOES-NOT-EXIST.awebp",
        mediaType: "short",
      }),
    );
    const img = card.querySelector(".card-thumb img") as HTMLImageElement | null;
    expect(img).not.toBeNull();
    img!.dispatchEvent(new Event("error"));
    flushSync();
    // After error: the <img> is gone, the .card-thumb is now .empty with a
    // KindIcon placeholder (svg), and there is no broken image.
    expect(card.querySelector(".card-thumb img")).toBeNull();
    const thumb = card.querySelector(".card-thumb");
    expect(thumb?.classList.contains("empty")).toBe(true);
    expect(thumb?.querySelector("svg")).not.toBeNull();
    unmount(component);
  });
});
