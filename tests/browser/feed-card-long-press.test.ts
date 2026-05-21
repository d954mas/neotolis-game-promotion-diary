/**
 * Browser test for FeedCard touch long-press → selection (D-27, D-28).
 *
 * Wave 2 Plan 08 extends FeedCard.svelte with the ontouchstart /
 * ontouchend / ontouchmove / ontouchcancel handlers. This file scaffolds
 * the contract.
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
 *
 * Wave 2 activation: un-comment the component import below; Wave 2 Plan 08
 * ships the long-press wiring in src/lib/components/FeedCard.svelte.
 * The existing project browser-test pattern (see tests/browser/feed-360.test.ts)
 * uses @vitest/browser/context against a live SvelteKit preview server;
 * these scaffolds will follow the same shape OR the in-process Svelte 5
 * mount pattern that Wave 2 Plan 08 chooses.
 */

import { describe, it } from "vitest";
// Wave 2 Plan 08 ACTIVATES this import path:
// import FeedCard from "../../src/lib/components/FeedCard.svelte";

describe("FeedCard touch long-press (Wave 2 Plan 08)", () => {
  it.skip("Wave 2 Plan 08: ontouchstart starts 480ms timer; timer fire calls onToggleSelect(id, true) (D-27)", async () => {});
  it.skip("Wave 2 Plan 08: ontouchmove cancels timer — scroll-cancel (D-28, RESEARCH Pitfall 6)", async () => {});
  it.skip("Wave 2 Plan 08: ontouchend cancels timer if released before 480ms (D-28)", async () => {});
  it.skip("Wave 2 Plan 08: ontouchcancel cancels timer (D-28)", async () => {});
  it.skip("Wave 2 Plan 08: after timer fires, card data-long-pressed='1' attribute set (D-28)", async () => {});
  it.skip("Wave 2 Plan 08: onclick fired after long-press fire is suppressed — no double-toggle when finger lifts (D-28)", async () => {});
  it.skip("Wave 2 Plan 08: oncontextmenu calls preventDefault — suppresses Android long-press OS menu (D-27)", async () => {});
});
