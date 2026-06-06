/**
 * Browser test for InstagramFeedCard (Phase 08 Plan 07, VIZ-05 surface).
 *
 * Asserts the three load-bearing IG-card contracts from 08-UI-SPEC:
 *   - Metrics-by-presence (D-05): a short event (viewCount present) renders
 *     the views chip; a photo event (viewCount null) renders NO views chip.
 *     A null metric is omitted — never a 0-or-dash.
 *   - onerror fallback (D-08): when the hotlinked CDN thumbnail fails to
 *     load, the card swaps to the .card-thumb.empty KindIcon placeholder
 *     (no broken <img>, no error text).
 *
 * Mounts the real Svelte component in Chromium (vitest browser project) so
 * the metrics-by-presence {#if} branches + the BaseFeedCard onThumbnailError
 * wiring are exercised against the actual compiled output, not a mock.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import InstagramFeedCard from "../../src/lib/sources/instagram/ui/InstagramFeedCard.svelte";
import type { CardEventLite } from "../../src/lib/components/feed/parts/derive-card-data.js";

let host: HTMLElement;

type IgStats = {
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  polledAt: Date;
};

function makeEvent(opts: {
  stats: IgStats | null;
  thumbnailUrl: string | null;
  mediaType: string | null;
}): CardEventLite {
  return {
    id: "ev_ig_1",
    kind: "instagram_post",
    gameIds: [] as string[],
    sourceId: "src_ig_1",
    externalId: "ig-post-abc",
    metadata: null,
    occurredAt: new Date("2026-06-03T08:00:00Z"),
    authorIsMe: false,
    title: "A test caption first line",
    notes: null,
    url: null,
    publishedAt: new Date("2026-06-03T08:00:00Z"),
    lastPolledAt: new Date("2026-06-04T08:00:00Z"),
    lastPollStatus: null,
    instagramEnrichment: {
      stats: opts.stats,
      thumbnailUrl: opts.thumbnailUrl,
      mediaType: opts.mediaType,
    },
  };
}

const source = {
  id: "src_ig_1",
  displayName: "Nat Geo",
  handleUrl: "https://www.instagram.com/natgeo/",
  channelTitle: "natgeo",
};

function mountCard(event: CardEventLite): {
  card: HTMLElement;
  component: ReturnType<typeof mount>;
} {
  const component = mount(InstagramFeedCard, {
    target: host,
    props: { event, source, games: [], view: "feed" },
  });
  flushSync();
  const card = host.querySelector('[data-testid="feed-card"]') as HTMLElement | null;
  if (!card) throw new Error("InstagramFeedCard root not found");
  return { card, component };
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  if (host.parentNode) host.parentNode.removeChild(host);
});

describe("InstagramFeedCard (Phase 08 Plan 07)", () => {
  it("short event (viewCount present) renders the views chip + likes + comments", () => {
    const { card, component } = mountCard(
      makeEvent({
        stats: { viewCount: 12000, likeCount: 800, commentCount: 42, polledAt: new Date() },
        thumbnailUrl: "https://scontent.cdninstagram.com/v/short-thumb.jpg",
        mediaType: "short",
      }),
    );
    const nums = Array.from(card.querySelectorAll(".card-stats .num")).map((n) =>
      (n.textContent ?? "").trim(),
    );
    // 12000 → "12.0K", 800 → "800", 42 → "42" (all three chips present).
    expect(nums).toHaveLength(3);
    expect(nums).toContain("12.0K");
    expect(nums).toContain("800");
    expect(nums).toContain("42");
    unmount(component);
  });

  it("photo event (viewCount null) renders NO views chip — metrics by presence (D-05)", () => {
    const { card, component } = mountCard(
      makeEvent({
        stats: { viewCount: null, likeCount: 350, commentCount: 9, polledAt: new Date() },
        thumbnailUrl: "https://scontent.cdninstagram.com/v/photo-thumb.jpg",
        mediaType: "image",
      }),
    );
    const nums = Array.from(card.querySelectorAll(".card-stats .num")).map((n) =>
      (n.textContent ?? "").trim(),
    );
    // Only likes + comments — views is omitted (NOT rendered as "0").
    expect(nums).toHaveLength(2);
    expect(nums).toContain("350");
    expect(nums).toContain("9");
    expect(nums).not.toContain("0");
    unmount(component);
  });

  it("media-type pill: short / carousel / video each render the correct icon+TEXT pill; photo renders none", () => {
    const cases: Array<{ mediaType: string; label: string | null }> = [
      { mediaType: "short", label: "Short" },
      { mediaType: "carousel", label: "Carousel" },
      { mediaType: "video", label: "Video" },
      // A bare photo (image) needs no marker — no pill rendered.
      { mediaType: "image", label: null },
    ];

    for (const { mediaType, label } of cases) {
      const { card, component } = mountCard(
        makeEvent({
          stats: { viewCount: null, likeCount: 1, commentCount: 1, polledAt: new Date() },
          thumbnailUrl: "https://scontent.cdninstagram.com/v/thumb.jpg",
          mediaType,
        }),
      );
      const pill = card.querySelector(".card-thumb .media-type-pill") as HTMLElement | null;
      if (label === null) {
        expect(pill, `${mediaType} should render NO pill`).toBeNull();
      } else {
        expect(pill, `${mediaType} should render a pill`).not.toBeNull();
        // The TEXT label is the load-bearing disambiguator — it renders as
        // visible text inside the pill AND mirrors into aria-label.
        expect(pill!.textContent?.trim()).toBe(label);
        expect(pill!.querySelector(".media-type-pill-label")?.textContent?.trim()).toBe(label);
        expect(pill!.getAttribute("aria-label")).toBe(label);
        expect(pill!.getAttribute("data-media-type")).toBe(mediaType);
        // A small glyph rides alongside the text for visual flavor.
        expect(pill!.querySelector("svg")).not.toBeNull();
      }
      unmount(component);
    }
  });

  it("media-type pill sits over the IMAGE, not the empty placeholder (no thumbnail → no pill)", () => {
    // No thumbnail URL → BaseFeedCard shows the .card-thumb.empty placeholder
    // and the pill is gated off (it marks a picture, not a placeholder).
    const { card, component } = mountCard(
      makeEvent({
        stats: { viewCount: 1, likeCount: 1, commentCount: 1, polledAt: new Date() },
        thumbnailUrl: null,
        mediaType: "short",
      }),
    );
    expect(card.querySelector(".media-type-pill")).toBeNull();
    unmount(component);
  });

  it("thumbnail onerror swaps to the .card-thumb.empty placeholder (D-08, no broken image)", async () => {
    const { card, component } = mountCard(
      makeEvent({
        stats: { viewCount: null, likeCount: 1, commentCount: 1, polledAt: new Date() },
        // A URL that will never resolve → fires <img> onerror.
        thumbnailUrl: "https://scontent.cdninstagram.com/v/expired-DOES-NOT-EXIST.jpg",
        mediaType: "image",
      }),
    );
    const img = card.querySelector(".card-thumb img") as HTMLImageElement | null;
    expect(img).not.toBeNull();
    // Drive the error handler directly — deterministic and harness-safe
    // (real network failure timing is flaky in CI). This is the same
    // onerror path the expired CDN URL triggers in production.
    img!.dispatchEvent(new Event("error"));
    flushSync();
    // After error: the <img> is gone, the .card-thumb is now .empty with a
    // KindIcon placeholder (svg), and there is no error text.
    expect(card.querySelector(".card-thumb img")).toBeNull();
    const thumb = card.querySelector(".card-thumb");
    expect(thumb?.classList.contains("empty")).toBe(true);
    expect(thumb?.querySelector("svg")).not.toBeNull();
    unmount(component);
  });
});
