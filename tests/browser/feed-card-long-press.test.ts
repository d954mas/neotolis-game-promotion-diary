/**
 * Browser test for FeedCard touch long-press → selection (D-27, D-28).
 *
 * Wave 2 Plan 08 extends FeedCard.svelte with the ontouchstart /
 * ontouchend / ontouchmove / ontouchcancel handlers.
 *
 * MANUAL UAT CAVEAT: vitest browser-mode touch emulation does NOT
 * reliably fire ontouchmove during inertial scroll (RESEARCH Pitfall 6).
 * Real-device verification is the load-bearing test; this file covers
 * the timer + cancel logic only.
 *
 * Contract anchors:
 *   - D-27 — Touch-only long-press; onTouchStart 480ms timer; suppress
 *            browser default context menu via oncontextmenu preventDefault
 *   - D-28 — Long-press cancel via touchend / touchmove (scroll cancels) /
 *            touchcancel; data-long-pressed="1" on the card after fire;
 *            click handler skips one click to avoid double-toggle when
 *            finger lifts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import FeedCard from "../../src/lib/components/FeedCard.svelte";

let host: HTMLElement;

const baseEvent = {
  id: "ev_test_1",
  gameIds: [] as string[],
  sourceId: null,
  kind: "conference" as const,
  authorIsMe: false,
  occurredAt: new Date("2026-05-21T08:00:00Z"),
  title: "Test event title",
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
      game: null,
      games: [],
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

// Synthetic touch event — vitest browser-mode chromium exposes TouchEvent.
// We only need a target to satisfy the handler signature; the timer fires
// off setTimeout and does not actually read e.touches.
function dispatchTouch(el: HTMLElement, type: "touchstart" | "touchend" | "touchmove" | "touchcancel"): void {
  const ev = new Event(type, { bubbles: true });
  el.dispatchEvent(ev);
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  if (host.parentNode) host.parentNode.removeChild(host);
});

describe("FeedCard touch long-press (Wave 2 Plan 08)", () => {
  it("ontouchstart starts 480ms timer; timer fire calls onToggleSelect(id, true) (D-27)", () => {
    const { card, onToggleSelect, component } = mountFeedCard();
    dispatchTouch(card, "touchstart");
    vi.advanceTimersByTime(479);
    expect(onToggleSelect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onToggleSelect).toHaveBeenCalledExactlyOnceWith(baseEvent.id, true);
    unmount(component);
  });

  it("ontouchmove cancels timer — scroll-cancel (D-28, RESEARCH Pitfall 6)", () => {
    const { card, onToggleSelect, component } = mountFeedCard();
    dispatchTouch(card, "touchstart");
    vi.advanceTimersByTime(200);
    dispatchTouch(card, "touchmove");
    vi.advanceTimersByTime(500);
    expect(onToggleSelect).not.toHaveBeenCalled();
    unmount(component);
  });

  it("ontouchend cancels timer if released before 480ms (D-28)", () => {
    const { card, onToggleSelect, component } = mountFeedCard();
    dispatchTouch(card, "touchstart");
    vi.advanceTimersByTime(200);
    dispatchTouch(card, "touchend");
    vi.advanceTimersByTime(500);
    expect(onToggleSelect).not.toHaveBeenCalled();
    unmount(component);
  });

  it("ontouchcancel cancels timer (D-28)", () => {
    const { card, onToggleSelect, component } = mountFeedCard();
    dispatchTouch(card, "touchstart");
    vi.advanceTimersByTime(200);
    dispatchTouch(card, "touchcancel");
    vi.advanceTimersByTime(500);
    expect(onToggleSelect).not.toHaveBeenCalled();
    unmount(component);
  });

  it("after timer fires, card data-long-pressed='1' attribute set (D-28)", () => {
    const { card, component } = mountFeedCard();
    dispatchTouch(card, "touchstart");
    vi.advanceTimersByTime(480);
    expect(card.dataset.longPressed).toBe("1");
    unmount(component);
  });

  it("onclick fired after long-press fire is suppressed — no double-toggle when finger lifts (D-28)", () => {
    const { card, onToggleSelect, onOpenDetail, component } = mountFeedCard();
    dispatchTouch(card, "touchstart");
    vi.advanceTimersByTime(480);
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    // Simulate the synthetic click that follows touchend after a long press.
    card.click();
    // Click handler MUST detect data-long-pressed and skip both onToggleSelect AND onOpenDetail.
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    expect(onOpenDetail).not.toHaveBeenCalled();
    // The flag is cleared after the skip so subsequent clicks work normally.
    expect(card.dataset.longPressed).toBeUndefined();
    unmount(component);
  });

  it("oncontextmenu calls preventDefault — suppresses Android long-press OS menu (D-27)", () => {
    const { card, component } = mountFeedCard();
    const ev = new Event("contextmenu", { bubbles: true, cancelable: true });
    card.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    unmount(component);
  });
});
