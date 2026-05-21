/**
 * Browser test for FeedCard Gmail-style anySelected sweep (D-12 + prototype line 1061-1075).
 *
 * Wave 2 Plan 08 extends FeedCard.svelte with the click handler that
 * branches on anySelected. This file scaffolds the contract.
 *
 * Contract anchors:
 *   - D-12 — selection state drives Gmail-style bulk-action sweep
 *   - LB-10 — data-selected attribute load-bearing for test/styling hooks
 *   - Prototype docs/design/v2/ui-kit/feed-card.jsx lines 1061-1075 —
 *     anySelected branch turns plain click into a select-toggle
 *
 * Wave 2 activation: un-comment the component import below; Wave 2 Plan 08
 * ships the click handler + selection wiring in
 * src/lib/components/FeedCard.svelte.
 */

import { describe, it } from "vitest";
// Wave 2 Plan 08 ACTIVATES this import path:
// import FeedCard from "../../src/lib/components/FeedCard.svelte";

describe("FeedCard anySelected sweep (Wave 2 Plan 08)", () => {
  it.skip("Wave 2 Plan 08: when anySelected=false, card-surface click calls onOpenDetail(id)", async () => {});
  it.skip("Wave 2 Plan 08: when anySelected=true, card-surface click calls onToggleSelect(id, !selected) instead of onOpenDetail (D-12 Gmail sweep)", async () => {});
  it.skip("Wave 2 Plan 08: click on .card-select checkbox does NOT bubble to card surface — closest('.card-select') early-return", async () => {});
  it.skip("Wave 2 Plan 08: click on .card-actions ⋯ button does NOT bubble to card surface", async () => {});
  it.skip("Wave 2 Plan 08: data-selected='1' attribute applied when selected=true (LB-10)", async () => {});
  it.skip("Wave 2 Plan 08: data-view attribute reflects view='feed' | 'trash' prop", async () => {});
});
