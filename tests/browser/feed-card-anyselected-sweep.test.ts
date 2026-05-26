/**
 * Browser test for FeedCard Gmail-style anySelected sweep (D-12 + prototype line 1061-1075).
 *
 * Wave 2 Plan 08 extends FeedCard.svelte with the click handler that
 * branches on anySelected.
 *
 * Contract anchors:
 *   - D-12 — selection state drives Gmail-style bulk-action sweep
 *   - LB-10 — data-selected attribute load-bearing for test/styling hooks
 *   - Prototype docs/design/v2/ui-kit/app.jsx lines 1061-1075 —
 *     anySelected branch turns plain click into a select-toggle
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import FeedCard from "../../src/lib/components/FeedCard.svelte";

let host: HTMLElement;

const baseEvent = {
  id: "ev_test_sweep",
  gameIds: ["g1"],
  sourceId: null,
  kind: "conference" as const,
  authorIsMe: false,
  occurredAt: new Date("2026-05-21T08:00:00Z"),
  title: "Sweep test event",
  url: null,
  externalId: null,
  notes: null,
  metadata: null,
  publishedAt: null,
  lastPolledAt: null,
  lastPollStatus: null,
  stats: null,
  channelTitle: null,
};

function mountFeedCard(propsOverrides: Record<string, unknown> = {}): {
  card: HTMLElement;
  onToggleSelect: ReturnType<typeof vi.fn>;
  onOpenDetail: ReturnType<typeof vi.fn>;
  onOpenGamesPickerForCard: ReturnType<typeof vi.fn>;
  onDelete: ReturnType<typeof vi.fn>;
  component: ReturnType<typeof mount>;
} {
  const onToggleSelect = vi.fn();
  const onOpenDetail = vi.fn();
  const onOpenGamesPickerForCard = vi.fn();
  const onDelete = vi.fn();
  const component = mount(FeedCard, {
    target: host,
    props: {
      event: baseEvent,
      source: null,
      game: { id: "g1", title: "Game 1" },
      games: [{ id: "g1", title: "Game 1" }],
      selected: false,
      anySelected: false,
      view: "feed",
      onToggleSelect,
      onOpenDetail,
      onOpenGamesPickerForCard,
      onDelete,
      ...propsOverrides,
    },
  });
  flushSync();
  const card = host.querySelector('[data-testid="feed-card"]') as HTMLElement | null;
  if (!card) throw new Error("FeedCard root not found");
  return { card, onToggleSelect, onOpenDetail, onOpenGamesPickerForCard, onDelete, component };
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  if (host.parentNode) host.parentNode.removeChild(host);
});

describe("FeedCard anySelected sweep (Wave 2 Plan 08)", () => {
  it("when anySelected=false, card-surface click calls onOpenDetail(id)", () => {
    const { card, onOpenDetail, onToggleSelect, component } = mountFeedCard({
      anySelected: false,
    });
    card.click();
    expect(onOpenDetail).toHaveBeenCalledExactlyOnceWith(baseEvent.id);
    expect(onToggleSelect).not.toHaveBeenCalled();
    unmount(component);
  });

  it("when anySelected=true, card-surface click calls onToggleSelect(id, !selected) instead of onOpenDetail (D-12 Gmail sweep)", () => {
    const { card, onOpenDetail, onToggleSelect, component } = mountFeedCard({
      anySelected: true,
      selected: false,
    });
    card.click();
    expect(onOpenDetail).not.toHaveBeenCalled();
    expect(onToggleSelect).toHaveBeenCalledExactlyOnceWith(baseEvent.id, true);
    unmount(component);
  });

  it("when anySelected=true and selected=true, click toggles to deselect", () => {
    const { card, onToggleSelect, component } = mountFeedCard({
      anySelected: true,
      selected: true,
    });
    card.click();
    expect(onToggleSelect).toHaveBeenCalledExactlyOnceWith(baseEvent.id, false);
    unmount(component);
  });

  it("click on .card-select checkbox does NOT bubble to card-surface — closest('.card-select') early-return", () => {
    const { card, onOpenDetail, component } = mountFeedCard({ anySelected: false });
    const select = card.querySelector(".card-select input") as HTMLInputElement | null;
    expect(select).not.toBeNull();
    select!.click();
    // The select's own onchange fires onToggleSelect; the card-surface
    // onclick handler must NOT call onOpenDetail (early-return on .card-select).
    expect(onOpenDetail).not.toHaveBeenCalled();
    unmount(component);
  });

  it("click on .card-actions ⋯ button does NOT bubble to card-surface", () => {
    const { card, onOpenDetail, component } = mountFeedCard({ anySelected: false });
    const actions = card.querySelector(".card-actions") as HTMLElement | null;
    expect(actions).not.toBeNull();
    actions!.click();
    expect(onOpenDetail).not.toHaveBeenCalled();
    unmount(component);
  });

  it("data-selected='1' attribute applied when selected=true (LB-10)", () => {
    const { card, component } = mountFeedCard({ selected: true });
    expect(card.dataset.selected).toBe("1");
    unmount(component);
  });

  it("data-selected='0' attribute when selected=false (LB-10)", () => {
    const { card, component } = mountFeedCard({ selected: false });
    expect(card.dataset.selected).toBe("0");
    unmount(component);
  });

  it("data-view attribute reflects view='feed' | 'trash' prop", () => {
    const { card, component } = mountFeedCard({ view: "trash" });
    expect(card.dataset.view).toBe("trash");
    unmount(component);
  });

  it("data-mine='0' when authorIsMe=false", () => {
    const { card, component } = mountFeedCard({
      event: { ...baseEvent, authorIsMe: false },
    });
    expect(card.dataset.mine).toBe("0");
    unmount(component);
  });

  it("data-mine='1' when authorIsMe=true", () => {
    const { card, component } = mountFeedCard({
      event: { ...baseEvent, authorIsMe: true },
    });
    expect(card.dataset.mine).toBe("1");
    unmount(component);
  });
});
