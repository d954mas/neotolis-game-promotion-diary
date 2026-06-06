/**
 * Browser test for YoutubeFeedCard's media-type overlay.
 *
 * Mirrors the Instagram-card overlay assertions (instagram-card.test.ts) but
 * for YouTube: EVERY YouTube video shows the "video" play-glyph overlay for
 * now (Shorts-vs-full-video detection is deferred — see the TODO in
 * YoutubeFeedCard.svelte). The overlay reuses the SAME shared helper
 * (feed/parts/media-type-overlay.ts) and the SAME corner placement + scrim as
 * the Instagram card, so the two media cards stay visually consistent.
 *
 * Mounts the real Svelte component in Chromium (vitest browser project) so the
 * thumbnailOverlaySlot wiring is exercised against the actual compiled output,
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

describe("YoutubeFeedCard media-type overlay", () => {
  it('renders the "video" play-glyph overlay (aria-label "Video") over the thumbnail', () => {
    const { card, component } = mountCard(makeEvent({ externalId: "dQw4w9WgXcQ" }));
    const overlay = card.querySelector(".card-thumb .media-type-overlay") as HTMLElement | null;
    expect(overlay, "YouTube card should render a media-type overlay").not.toBeNull();
    expect(overlay!.getAttribute("aria-label")).toBe("Video");
    // The glyph itself is an inline SVG inside the overlay.
    expect(overlay!.querySelector("svg")).not.toBeNull();
    unmount(component);
  });

  it("overlay sits over the IMAGE, not the empty placeholder (no externalId → no thumbnail → no overlay)", () => {
    // No externalId → deriveThumbnailUrl returns null → BaseFeedCard shows the
    // .card-thumb.empty KindIcon placeholder and gates the overlay slot off (it
    // marks a picture, not a placeholder).
    const { card, component } = mountCard(makeEvent({ externalId: null }));
    expect(card.querySelector(".media-type-overlay")).toBeNull();
    unmount(component);
  });
});
