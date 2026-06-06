/**
 * Browser test for YoutubeFeedCard's media-type pill.
 *
 * Mirrors the Instagram-card pill assertions (instagram-card.test.ts) but for
 * YouTube: EVERY YouTube video shows the "Video" icon+text pill for now
 * (Shorts-vs-full-video detection is deferred — see the TODO in
 * YoutubeFeedCard.svelte). The pill reuses the SAME shared helper
 * (feed/parts/media-type-overlay.ts) and the SAME BaseFeedCard pill treatment
 * as the Instagram card, so the two media cards stay visually consistent.
 *
 * Mounts the real Svelte component in Chromium (vitest browser project) so the
 * thumbnailOverlay wiring is exercised against the actual compiled output,
 * not a mock.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import YoutubeFeedCard from "../../src/lib/sources/youtube/ui/YoutubeFeedCard.svelte";
import type { CardEventLite } from "../../src/lib/components/feed/parts/derive-card-data.js";

let host: HTMLElement;

function makeEvent(opts: { externalId: string | null }): CardEventLite {
  return {
    id: "ev_yt_1",
    kind: "youtube_video",
    gameIds: [] as string[],
    sourceId: "src_yt_1",
    externalId: opts.externalId,
    metadata: null,
    occurredAt: new Date("2026-06-03T08:00:00Z"),
    authorIsMe: false,
    title: "A test devlog video",
    notes: null,
    url: null,
    publishedAt: new Date("2026-06-03T08:00:00Z"),
    lastPolledAt: new Date("2026-06-04T08:00:00Z"),
    lastPollStatus: null,
    channelTitle: "Test Channel",
    stats: { viewCount: 12000, likeCount: 800, commentCount: 42, polledAt: new Date() },
  };
}

const source = {
  id: "src_yt_1",
  displayName: "Test Channel",
  handleUrl: "https://www.youtube.com/@test",
  channelTitle: "Test Channel",
};

function mountCard(event: CardEventLite): {
  card: HTMLElement;
  component: ReturnType<typeof mount>;
} {
  const component = mount(YoutubeFeedCard, {
    target: host,
    props: { event, source, games: [], view: "feed" },
  });
  flushSync();
  const card = host.querySelector('[data-testid="feed-card"]') as HTMLElement | null;
  if (!card) throw new Error("YoutubeFeedCard root not found");
  return { card, component };
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  if (host.parentNode) host.parentNode.removeChild(host);
});

describe("YoutubeFeedCard media-type pill", () => {
  it('renders the "Video" icon+TEXT pill over the thumbnail', () => {
    const { card, component } = mountCard(makeEvent({ externalId: "dQw4w9WgXcQ" }));
    const pill = card.querySelector(".card-thumb .media-type-pill") as HTMLElement | null;
    expect(pill, "YouTube card should render a media-type pill").not.toBeNull();
    // The TEXT label is the load-bearing disambiguator — visible text + aria.
    expect(pill!.textContent?.trim()).toBe("Video");
    expect(pill!.querySelector(".media-type-pill-label")?.textContent?.trim()).toBe("Video");
    expect(pill!.getAttribute("aria-label")).toBe("Video");
    expect(pill!.getAttribute("data-media-type")).toBe("video");
    // A small glyph rides alongside the text for visual flavor.
    expect(pill!.querySelector("svg")).not.toBeNull();
    unmount(component);
  });

  it("pill sits over the IMAGE, not the empty placeholder (no externalId → no thumbnail → no pill)", () => {
    // No externalId → deriveThumbnailUrl returns null → BaseFeedCard shows the
    // .card-thumb.empty KindIcon placeholder and gates the pill off (it marks a
    // picture, not a placeholder).
    const { card, component } = mountCard(makeEvent({ externalId: null }));
    expect(card.querySelector(".media-type-pill")).toBeNull();
    unmount(component);
  });
});
