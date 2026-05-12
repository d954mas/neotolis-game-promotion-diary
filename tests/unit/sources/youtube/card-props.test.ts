import { describe, it, expect } from "vitest";

import { toCardProps } from "$lib/sources/youtube/ui/server.js";

// Each `it` pins a single contract on src/lib/sources/youtube/ui/card-props.ts's
// toCardProps mapper. The mapper is a pure function — no Svelte component
// imports — so it's safe to import from +page.server.ts loaders.

describe("YouTube toCardProps — props mapper", () => {
  const baseEvent = {
    id: "evt-1",
    externalId: "abc123",
    title: "Test Video",
    authorIsMe: false,
  } as const;

  it("with stats present returns 3 metrics in K/M abbreviated form", () => {
    const props = toCardProps({
      ...baseEvent,
      stats: { viewCount: 1500, likeCount: 50, commentCount: 12 },
    });
    expect(props.metrics).toEqual([
      { label: "Views", value: "1.5K" },
      { label: "Likes", value: "50" },
      { label: "Comments", value: "12" },
    ]);
  });

  it("with stats=null returns empty metrics array", () => {
    const props = toCardProps({ ...baseEvent, stats: null });
    expect(props.metrics).toEqual([]);
  });

  it("with stats=undefined returns empty metrics array", () => {
    const props = toCardProps({ ...baseEvent });
    expect(props.metrics).toEqual([]);
  });

  it("authorIsMe=true sets badge='Mine' and subtitle='My video'", () => {
    const props = toCardProps({ ...baseEvent, authorIsMe: true });
    expect(props.badge).toBe("Mine");
    expect(props.subtitle).toBe("My video");
  });

  it("authorIsMe=false sets badge=null and subtitle=null", () => {
    const props = toCardProps({ ...baseEvent, authorIsMe: false });
    expect(props.badge).toBeNull();
    expect(props.subtitle).toBeNull();
  });

  it("thumbnail uses YouTube img.youtube.com mqdefault.jpg pattern", () => {
    const props = toCardProps({ ...baseEvent, externalId: "xyz" });
    expect(props.thumbnail).toBe("https://img.youtube.com/vi/xyz/mqdefault.jpg");
  });

  it("thumbnail is null when externalId is null", () => {
    const props = toCardProps({ ...baseEvent, externalId: null });
    expect(props.thumbnail).toBeNull();
  });

  it("href === `/events/${event.id}`", () => {
    const props = toCardProps({ ...baseEvent, id: "ev-42" });
    expect(props.href).toBe("/events/ev-42");
  });

  it("formatStat boundary values via the metrics column: 0 → '0', 999 → '999'", () => {
    const props = toCardProps({
      ...baseEvent,
      stats: { viewCount: 0, likeCount: 999, commentCount: 1_500_000 },
    });
    expect(props.metrics).toEqual([
      { label: "Views", value: "0" },
      { label: "Likes", value: "999" },
      { label: "Comments", value: "1.5M" },
    ]);
  });
});

describe("getAdapterUI('youtube_channel') — registry-ui wiring", () => {
  it("returns object exposing toCardProps function", async () => {
    const { getAdapterUI } = await import("$lib/sources/registry-ui.js");
    const ui = getAdapterUI("youtube_channel");
    expect(typeof ui.toCardProps).toBe("function");
  });

  it("dispatches the same toCardProps as the direct ui/server import", async () => {
    const { getAdapterUI } = await import("$lib/sources/registry-ui.js");
    const direct = await import("$lib/sources/youtube/ui/server.js");
    const viaRegistry = getAdapterUI("youtube_channel");
    expect(viaRegistry.toCardProps).toBe(direct.toCardProps);
  });
});

describe("eventKindToSourceKind — event.kind → SourceKind bridge", () => {
  it("maps youtube_video → youtube_channel", async () => {
    const { eventKindToSourceKind } = await import("$lib/sources/event-to-source-kind.js");
    expect(eventKindToSourceKind("youtube_video")).toBe("youtube_channel");
  });

  it("returns null for free-form kinds (post, conference, talk, press, other)", async () => {
    const { eventKindToSourceKind } = await import("$lib/sources/event-to-source-kind.js");
    expect(eventKindToSourceKind("post")).toBeNull();
    expect(eventKindToSourceKind("conference")).toBeNull();
    expect(eventKindToSourceKind("talk")).toBeNull();
    expect(eventKindToSourceKind("press")).toBeNull();
    expect(eventKindToSourceKind("other")).toBeNull();
  });
});
